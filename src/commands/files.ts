import { Command } from 'commander';
import ora from 'ora';
import { writeFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, success, info } from '../lib/formatter.ts';

export function createFilesCommand(): Command {
  const files = new Command('files')
    .description('Upload and manage Slack files');

  // Upload a local file without sharing it to a channel. The file stays private
  // but gets a permalink — used by the Obsidian→canvas converter to turn each
  // embedded screenshot into a clickable link. Routes to browser auth.
  files
    .command('upload')
    .description('Upload a local file (no channel — stays private, returns a permalink)')
    .argument('<path>', 'Path to the local file to upload')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (path, options) => {
      const spinner = ora('Uploading file...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const result = await client.uploadFileExternal(undefined, path, {});

        spinner.succeed(`Uploaded file ${result.file_id}`);

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            file_id: result.file_id,
            permalink: result.permalink,
          }, null, 2));
          return;
        }

        success(`File uploaded: ${result.file_id}`);
        if (result.permalink) {
          info(`Permalink: ${result.permalink}`);
        }
      } catch (err: any) {
        spinner.fail('Failed to upload file');
        error(err.message);
        process.exit(1);
      }
    });

  // Download a Slack file to disk. Slack's url_private endpoints only honor the
  // browser session cookie (a standard bearer token is 302-redirected to the
  // login page), so the client routes the fetch through browser auth and writes
  // raw bytes — binary-safe for images and other attachments, not just text.
  files
    .command('download')
    .description('Download a Slack file by file ID or url_private link (uses browser session auth)')
    .argument('<file>', 'Slack file ID (e.g. F0123ABC) or a url_private link')
    .option('-o, --output <path>', 'Output file or directory (defaults to the file name in the current directory)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (file, options) => {
      const spinner = ora('Resolving file...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        // Resolve the download URL + a default filename. A bare file ID is
        // looked up via files.info; a url_private link is used directly.
        let downloadUrl: string;
        let defaultName: string;

        if (/^https?:\/\//.test(file)) {
          downloadUrl = file;
          defaultName = basename(new URL(file).pathname) || 'download';
        } else {
          const fileInfo = await client.getFileInfo(file);
          const f = fileInfo.file;
          if (!f) throw new Error(`File not found: ${file}`);
          downloadUrl = f.url_private_download || f.url_private;
          if (!downloadUrl) throw new Error(`No download URL available for file ${file}`);
          defaultName = f.name || file;
        }

        // Resolve the output path: an existing directory (or a trailing slash)
        // means "write the file inside it"; anything else is the target file.
        let outputPath = options.output || defaultName;
        if (options.output) {
          const isDir =
            options.output.endsWith('/') ||
            (await stat(options.output).then((s) => s.isDirectory()).catch(() => false));
          if (isDir) outputPath = join(options.output, defaultName);
        }

        spinner.text = 'Downloading file...';
        const { bytes } = await client.downloadFileBytes(downloadUrl);

        await writeFile(outputPath, bytes);
        spinner.succeed(`Downloaded ${bytes.byteLength} bytes`);

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            path: outputPath,
            bytes: bytes.byteLength,
          }, null, 2));
          return;
        }

        success(`File saved: ${outputPath}`);
        info(`Size: ${bytes.byteLength} bytes`);
      } catch (err: any) {
        spinner.fail('Failed to download file');
        error(err.message);
        process.exit(1);
      }
    });

  return files;
}
