import { Command } from 'commander';
import ora from 'ora';
import { readFile, stat } from 'node:fs/promises';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { error, success, info, formatCanvasList, formatCanvasContent } from '../lib/formatter.ts';
import { canvasHtmlToMarkdown, isAuthPage } from '../lib/canvas-parser.ts';
import { readInteractiveInput, confirmPrompt } from '../lib/interactive-input.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import type {
  SlackCanvas,
  SlackUser,
  CanvasChange,
  CanvasEditOperation,
  CanvasSectionCriteria,
  CanvasSectionsOptions,
} from '../types/index.ts';

const CANVAS_ID_PATTERN = /^F[A-Z0-9]+$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Resolve canvas markdown from exactly one source: inline --content, a --file,
 * or --stdin. Returns undefined when no source is given (Slack allows creating
 * an empty canvas). Throws on conflicting sources or an unreadable file.
 */
export async function resolveCanvasMarkdown(options: {
  content?: string;
  file?: string;
  stdin?: boolean;
}): Promise<string | undefined> {
  const sources = [options.content, options.file, options.stdin].filter(Boolean).length;
  if (sources > 1) {
    throw new Error('Use only one of --content, --file, or --stdin');
  }

  if (options.content) return options.content;

  if (options.file) {
    const fileStats = await stat(options.file).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new Error(`File not found: ${options.file}`);
      }
      throw err;
    });
    if (!fileStats.isFile()) {
      throw new Error(`Cannot read non-file path: ${options.file}`);
    }
    if (fileStats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${fileStats.size} bytes (max ${MAX_FILE_SIZE})`);
    }
    return await readFile(options.file, 'utf-8');
  }

  if (options.stdin) {
    const input = await readInteractiveInput({
      prompt: 'Enter canvas markdown (press Enter twice when done):',
    });
    return input.trim();
  }

  return undefined;
}

/**
 * Build the canvases.create request params from resolved inputs. Pure so it can
 * be unit-tested without a network call. document_content is JSON-stringified
 * to match how the Slack API expects nested objects over form-encoding.
 */
export function buildCreateParams(input: {
  title?: string;
  markdown?: string;
  channel?: string;
}): Record<string, any> {
  const params: Record<string, any> = {};
  if (input.title) params.title = input.title;
  if (input.markdown) {
    params.document_content = JSON.stringify({ type: 'markdown', markdown: input.markdown });
  }
  if (input.channel) params.channel_id = input.channel;
  return params;
}

export const VALID_EDIT_OPERATIONS: CanvasEditOperation[] = [
  'insert_at_start',
  'insert_at_end',
  'insert_after',
  'insert_before',
  'replace',
  'delete',
  'rename',
];

export const VALID_SECTION_TYPES = ['h1', 'h2', 'h3', 'any_header'] as const;

// Resolve canvas markdown from exactly one of --content, --file, or --stdin.
export async function resolveMarkdown(options: { content?: string; file?: string; stdin?: boolean }): Promise<string | undefined> {
  const sources = [options.content, options.file, options.stdin].filter(Boolean).length;
  if (sources > 1) {
    throw new Error('Use only one of --content, --file, or --stdin');
  }
  if (options.content) return options.content;
  if (options.file) {
    const stats = await stat(options.file).catch((err: any) => {
      if (err?.code === 'ENOENT') throw new Error(`File not found: ${options.file}`);
      throw err;
    });
    if (!stats.isFile()) throw new Error(`Not a file: ${options.file}`);
    if (stats.size > MAX_FILE_SIZE) throw new Error(`File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    return await readFile(options.file, 'utf-8');
  }
  if (options.stdin) return (await readInteractiveInput()).trim();
  return undefined;
}

// Build a single canvases.edit change and validate the operation/argument combo.
export function buildEditChange(
  operation: CanvasEditOperation,
  markdown: string | undefined,
  sectionId: string | undefined,
): CanvasChange {
  const needsContent = operation !== 'delete';
  const needsSection = operation === 'insert_after' || operation === 'insert_before' || operation === 'delete';
  const forbidsSection = operation === 'insert_at_start' || operation === 'insert_at_end' || operation === 'rename';

  if (needsContent && !markdown) {
    throw new Error(`Operation "${operation}" requires content (--content, --file, or --stdin)`);
  }
  if (needsSection && !sectionId) {
    throw new Error(`Operation "${operation}" requires --section`);
  }
  if (forbidsSection && sectionId) {
    throw new Error(`Operation "${operation}" does not accept --section`);
  }
  if (operation === 'delete' && markdown) {
    throw new Error('Operation "delete" does not accept content');
  }

  const change: CanvasChange = { operation };
  // `rename` is canvas-level: the markdown becomes the new title, carried in
  // title_content rather than document_content.
  if (operation === 'rename') {
    change.title_content = { type: 'markdown', markdown: markdown as string };
  } else if (needsContent && markdown) {
    change.document_content = { type: 'markdown', markdown };
  }
  if (sectionId) change.section_id = sectionId;
  return change;
}

// Build canvases.sections.lookup criteria from CLI options.
export function buildSectionCriteria(options: { contains?: string; type?: 'h1' | 'h2' | 'h3' | 'any_header' }): CanvasSectionCriteria {
  const criteria: CanvasSectionCriteria = {};
  if (options.type) criteria.section_types = [options.type];
  if (options.contains) criteria.contains_text = options.contains;
  // Slack requires criteria to have at least one property. With no filters given,
  // default to matching any header so `canvas sections <id>` lists all headers.
  if (!criteria.section_types && !criteria.contains_text) {
    criteria.section_types = ['any_header'];
  }
  return criteria;
}

// Map exactly one position flag to the matching insert operation. Throws when
// none or more than one is supplied so `section create` fails loudly rather
// than guessing where the new section should go.
export function resolveCreatePosition(options: {
  atStart?: boolean;
  atEnd?: boolean;
  after?: string;
  before?: string;
}): { operation: CanvasEditOperation; sectionId?: string } {
  const chosen: Array<{ operation: CanvasEditOperation; sectionId?: string }> = [];
  if (options.atStart) chosen.push({ operation: 'insert_at_start' });
  if (options.atEnd) chosen.push({ operation: 'insert_at_end' });
  if (options.after) chosen.push({ operation: 'insert_after', sectionId: options.after });
  if (options.before) chosen.push({ operation: 'insert_before', sectionId: options.before });

  if (chosen.length === 0) {
    throw new Error('Specify one position: --at-start, --at-end, --after <id>, or --before <id>');
  }
  if (chosen.length > 1) {
    throw new Error('Use only one of --at-start, --at-end, --after, or --before');
  }
  return chosen[0];
}

const HEADING_LEVEL_BY_TYPE: Record<'h1' | 'h2' | 'h3', number> = { h1: 1, h2: 2, h3: 3 };

// Slack has no per-section read API, so a section is read by slicing the
// downloaded canvas markdown: find the heading named by `query` and return the
// block beneath it, ending at the next heading of the same or higher level.
// Matching mirrors src/lib/mentions.ts — exact (case-insensitive) heading match
// first, then a single `includes` match, with actionable errors otherwise.
export function extractSection(
  markdown: string,
  query: string,
  type?: 'h1' | 'h2' | 'h3' | 'any_header',
): { heading: string; level: number; body: string } {
  const lines = markdown.split('\n');
  const headings: Array<{ index: number; level: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i]);
    if (match) headings.push({ index: i, level: match[1].length, text: match[2] });
  }

  // Restrict matching to a single heading level when --type is given. Boundary
  // detection still considers every heading so nested subsections stay intact.
  const wantLevel = type && type !== 'any_header' ? HEADING_LEVEL_BY_TYPE[type] : undefined;
  const candidates = wantLevel ? headings.filter((h) => h.level === wantLevel) : headings;

  if (candidates.length === 0) {
    throw new Error('Canvas has no matching headings. Add a "# Heading" or relax --type.');
  }

  const target = query.toLowerCase();
  let matched = candidates.find((h) => h.text.toLowerCase() === target);

  if (!matched) {
    const partial = candidates.filter((h) => h.text.toLowerCase().includes(target));
    if (partial.length === 1) {
      matched = partial[0];
    } else if (partial.length > 1) {
      const names = partial.map((h) => `"${h.text}"`).join(', ');
      throw new Error(`"${query}" matches ${partial.length} headings: ${names}. Use exact heading text.`);
    }
  }

  if (!matched) {
    const available = candidates.map((h) => `"${h.text}"`).join(', ');
    throw new Error(`No section heading matches "${query}". Available: ${available}.`);
  }

  let endLine = lines.length;
  for (const heading of headings) {
    if (heading.index > matched.index && heading.level <= matched.level) {
      endLine = heading.index;
      break;
    }
  }

  const body = lines.slice(matched.index + 1, endLine).join('\n').replace(/\s+$/, '');
  return { heading: matched.text, level: matched.level, body };
}

// Resolve <@U…> / <#C…> escape tokens in canvas markdown to friendly names.
// Extracted from `canvas read` so `section read` resolves mentions identically.
async function resolveCanvasMentions(
  client: SlackClient,
  markdown: string,
  spinner: ReturnType<typeof ora>,
): Promise<string> {
  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const match of markdown.matchAll(/<@(U[A-Z0-9]+)>/gi)) userIds.add(match[1]);
  for (const match of markdown.matchAll(/<#(C[A-Z0-9]+)>/gi)) channelIds.add(match[1]);

  if (userIds.size === 0 && channelIds.size === 0) return markdown;

  spinner.text = 'Resolving mentions...';
  let result = markdown;

  if (userIds.size > 0) {
    const usersResponse = await client.getUsersInfo(Array.from(userIds));
    const users = new Map<string, SlackUser>();
    usersResponse.users?.forEach((user: SlackUser) => users.set(user.id, user));
    for (const [id, user] of users) {
      const displayName = user.real_name || user.name || id;
      result = result.replace(new RegExp(`<@${id}>`, 'g'), `@${displayName}`);
    }
  }

  if (channelIds.size > 0) {
    for (const channelId of channelIds) {
      try {
        const info = await client.getConversationInfo(channelId);
        if (info.channel?.name) {
          result = result.replace(new RegExp(`<#${channelId}>`, 'g'), `#${info.channel.name}`);
        }
      } catch {
        // Skip channels we can't resolve
      }
    }
  }

  return result;
}

// Resolve a canvas file ID to its content. Returns raw HTML when options.raw is
// set, otherwise mention-resolved markdown. Shared by `canvas read` and
// `canvas section read`; the caller owns spinner success and final output.
async function loadCanvasMarkdown(
  client: SlackClient,
  fileId: string,
  options: { raw?: boolean },
  spinner: ReturnType<typeof ora>,
): Promise<{ file: SlackCanvas; markdown?: string; html?: string }> {
  spinner.text = 'Fetching canvas metadata...';
  const fileInfo = await client.getFileInfo(fileId);
  const file: SlackCanvas | undefined = fileInfo.file;
  if (!file) throw new Error('Canvas not found');

  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) throw new Error('No download URL available for this canvas');

  spinner.text = 'Downloading canvas content...';
  const html = await client.downloadFile(downloadUrl, MAX_FILE_SIZE);

  if (isAuthPage(html)) {
    throw new Error('The downloaded content is a Slack sign-in page. Your token may have expired.');
  }

  if (options.raw) return { file, html };

  const markdown = await resolveCanvasMentions(client, canvasHtmlToMarkdown(html), spinner);
  return { file, markdown };
}

// Shared implementation behind both `canvas sections` and `canvas section list`.
async function runSectionLookup(canvasId: string, options: CanvasSectionsOptions): Promise<void> {
  if (!CANVAS_ID_PATTERN.test(canvasId)) {
    error('Invalid canvas ID', 'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
    process.exit(1);
  }

  if (options.type && !VALID_SECTION_TYPES.includes(options.type)) {
    error('Invalid --type', `Valid types: ${VALID_SECTION_TYPES.join(', ')}`);
    process.exit(1);
  }

  const spinner = ora('Looking up canvas sections...').start();

  try {
    const client = await getAuthenticatedClient(options.workspace);
    const criteria = buildSectionCriteria(options);
    const response = await client.lookupCanvasSections(canvasId, criteria);
    const sections = response.sections || [];

    if (sections.length === 0) {
      spinner.succeed('No matching sections found');
      return;
    }

    spinner.succeed(`Found ${sections.length} section(s)`);

    if (options.json) {
      console.log(JSON.stringify({ section_count: sections.length, sections }, null, 2));
      return;
    }

    for (const section of sections) {
      console.log(`  ${section.id}`);
    }
  } catch (err: any) {
    spinner.fail('Failed to look up sections');
    error(err.message);
    process.exit(1);
  }
}

export function createCanvasCommand(): Command {
  const canvas = new Command('canvas')
    .description('Manage Slack canvas documents');

  // List canvases
  canvas
    .command('list')
    .description('List canvas documents in the workspace')
    .option('--limit <number>', 'Number of canvases to return', '20')
    .option('--channel <id>', 'List canvases shared in a specific channel')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const spinner = ora('Fetching canvases...').start();

      try {
        const limit = parseInt(options.limit);
        if (isNaN(limit) || limit < 1 || limit > 1000) {
          spinner.fail('Invalid limit');
          error('Limit must be a number between 1 and 1000');
          process.exit(1);
        }

        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.listCanvases({
          limit,
          channel: options.channel,
        });

        const files: SlackCanvas[] = response.files || [];

        if (files.length === 0) {
          spinner.succeed('No canvases found');
          return;
        }

        spinner.succeed(`Found ${files.length} canvases`);

        if (options.json) {
          console.log(JSON.stringify({
            canvas_count: files.length,
            canvases: files.map(f => ({
              id: f.id,
              title: f.title || f.name,
              created: f.created,
              edit_timestamp: f.edit_timestamp,
              user: f.user,
              editors: f.editors,
              size: f.size,
              permalink: f.permalink,
            })),
          }, null, 2));
          return;
        }

        console.log('\n' + formatCanvasList(files));
      } catch (err: any) {
        spinner.fail('Failed to fetch canvases');
        error(err.message);
        process.exit(1);
      }
    });

  // Read canvas content
  canvas
    .command('read')
    .description('Read canvas content as markdown')
    .argument('[canvas-id]', 'Canvas file ID (e.g., F1234567890)')
    .option('--channel <id>', 'Read the canvas associated with a channel')
    .option('--raw', 'Output raw HTML instead of markdown', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      const spinner = ora('Fetching canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        // Resolve canvas ID
        let fileId = canvasId;

        if (!fileId && options.channel) {
          spinner.text = 'Looking up channel canvas...';
          fileId = await client.getChannelCanvasId(options.channel);
          if (!fileId) {
            spinner.fail('No canvas found for this channel');
            return;
          }
        }

        if (!fileId) {
          spinner.fail('Missing canvas ID');
          error('Provide a canvas ID or use --channel to read a channel canvas.');
          process.exit(1);
        }

        if (!CANVAS_ID_PATTERN.test(fileId)) {
          spinner.fail('Invalid canvas ID');
          error('Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
          process.exit(1);
        }

        const { file, markdown, html } = await loadCanvasMarkdown(client, fileId, options, spinner);
        spinner.succeed(`Canvas: ${file.title || file.name || fileId}`);

        // Raw mode: output HTML directly
        if (options.raw) {
          console.log(html);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify({
            id: file.id,
            title: file.title || file.name,
            created: file.created,
            edit_timestamp: file.edit_timestamp,
            user: file.user,
            editors: file.editors,
            size: file.size,
            permalink: file.permalink,
            markdown,
          }, null, 2));
          return;
        }

        console.log('\n' + formatCanvasContent(file, markdown as string));
      } catch (err: any) {
        spinner.fail('Failed to read canvas');
        error(err.message);
        process.exit(1);
      }
    });

  // Create a canvas
  canvas
    .command('create')
    .description('Create a new canvas')
    .option('--title <title>', 'Canvas title')
    .option('--content <markdown>', 'Canvas body as markdown')
    .option('--file <path>', 'Read canvas markdown from a file')
    .option('--stdin', 'Read canvas markdown from stdin', false)
    .option('--channel <id>', 'Channel to tab the canvas into (required on free teams)')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      // Resolve content before starting the spinner so prompts/errors are clean
      let markdown: string | undefined;
      try {
        markdown = await resolveCanvasMarkdown(options);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }

      const spinner = ora('Creating canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        const response = await client.createCanvas({
          title: options.title,
          markdown,
          channel: options.channel,
        });

        const canvasId = response.canvas_id;
        if (!canvasId) {
          spinner.fail('Canvas creation failed');
          error('Slack did not return a canvas ID.');
          process.exit(1);
        }

        spinner.succeed(`Created canvas ${canvasId}`);

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            canvas_id: canvasId,
            title: options.title,
            channel: options.channel,
          }, null, 2));
          return;
        }

        success(`Canvas created: ${canvasId}`);
        info('Read it back with: slackcli canvas read ' + canvasId);
      } catch (err: any) {
        spinner.fail('Failed to create canvas');
        error(err.message);
        process.exit(1);
      }
    });

  // Edit canvas content
  canvas
    .command('edit')
    .description('Edit an existing canvas (use --operation rename with --content to set the canvas title)')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('--operation <op>', 'Edit operation: insert_at_start, insert_at_end, insert_after, insert_before, replace, delete, rename')
    .option('--content <markdown>', 'Canvas content as markdown')
    .option('--file <path>', 'Read canvas markdown from a file')
    .option('--stdin', 'Read canvas markdown from stdin', false)
    .option('--section <id>', 'Target section ID (from "canvas sections")')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      if (!CANVAS_ID_PATTERN.test(canvasId)) {
        error('Invalid canvas ID', 'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
        process.exit(1);
      }

      const operation = options.operation as CanvasEditOperation;
      if (!operation || !VALID_EDIT_OPERATIONS.includes(operation)) {
        error('Invalid or missing --operation', `Valid operations: ${VALID_EDIT_OPERATIONS.join(', ')}`);
        process.exit(1);
      }

      let change: CanvasChange;
      try {
        const markdown = await resolveMarkdown(options);
        change = buildEditChange(operation, markdown, options.section);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }

      const spinner = ora('Editing canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        await client.editCanvas(canvasId, [change]);
        spinner.succeed(`Edited canvas ${canvasId}`);

        if (options.json) {
          console.log(JSON.stringify({ ok: true, canvas_id: canvasId, change }, null, 2));
          return;
        }

        success(`Applied "${operation}" to canvas ${canvasId}`);
      } catch (err: any) {
        spinner.fail('Failed to edit canvas');
        error(err.message);
        process.exit(1);
      }
    });

  // Look up section IDs for targeted edits (back-compat alias of `section list`)
  canvas
    .command('sections')
    .description('Look up section IDs within a canvas (for targeted edits)')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('--contains <text>', 'Only sections containing this text')
    .option('--type <type>', 'Section type: h1, h2, h3, or any_header')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => runSectionLookup(canvasId, options));

  // Canvas section CRUD — ergonomic wrappers over canvases.edit / lookup / read.
  const section = canvas
    .command('section')
    .description('Create, read, update, and delete canvas sections');

  // Create a section at a chosen position
  section
    .command('create')
    .description('Insert a new section at a position in the canvas')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('--at-start', 'Insert at the start of the canvas', false)
    .option('--at-end', 'Insert at the end of the canvas', false)
    .option('--after <id>', 'Insert after the section with this ID (from "canvas section list")')
    .option('--before <id>', 'Insert before the section with this ID (from "canvas section list")')
    .option('--content <markdown>', 'Section content as markdown')
    .option('--file <path>', 'Read section markdown from a file')
    .option('--stdin', 'Read section markdown from stdin', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      if (!CANVAS_ID_PATTERN.test(canvasId)) {
        error('Invalid canvas ID', 'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
        process.exit(1);
      }

      let change: CanvasChange;
      try {
        const markdown = await resolveMarkdown(options);
        const { operation, sectionId } = resolveCreatePosition(options);
        change = buildEditChange(operation, markdown, sectionId);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }

      const spinner = ora('Creating canvas section...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        await client.editCanvas(canvasId, [change]);
        spinner.succeed(`Created section in canvas ${canvasId}`);

        if (options.json) {
          console.log(JSON.stringify({ ok: true, canvas_id: canvasId, change }, null, 2));
          return;
        }

        success(`Created a new section in canvas ${canvasId}`);
      } catch (err: any) {
        spinner.fail('Failed to create canvas section');
        error(err.message);
        process.exit(1);
      }
    });

  // Read one section by heading text (Slack has no per-section read API)
  section
    .command('read')
    .description('Read a single section by heading text (slices the canvas markdown locally)')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('--contains <text>', 'Heading text identifying the section to read')
    .option('--type <type>', 'Restrict matching to a heading level: h1, h2, h3, or any_header')
    .option('--channel <id>', 'Read the canvas associated with a channel')
    .option('--raw', 'Print only the section body (omit the heading line)', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      if (!options.contains) {
        error('Missing --contains', 'Specify the section heading text to read, e.g. --contains "Action Items".');
        process.exit(1);
      }

      if (options.type && !VALID_SECTION_TYPES.includes(options.type)) {
        error('Invalid --type', `Valid types: ${VALID_SECTION_TYPES.join(', ')}`);
        process.exit(1);
      }

      const spinner = ora('Fetching canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let fileId = canvasId;
        if (!fileId && options.channel) {
          spinner.text = 'Looking up channel canvas...';
          fileId = await client.getChannelCanvasId(options.channel);
          if (!fileId) {
            spinner.fail('No canvas found for this channel');
            return;
          }
        }

        if (!fileId) {
          spinner.fail('Missing canvas ID');
          error('Provide a canvas ID or use --channel to read a channel canvas.');
          process.exit(1);
        }

        if (!CANVAS_ID_PATTERN.test(fileId)) {
          spinner.fail('Invalid canvas ID');
          error('Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
          process.exit(1);
        }

        const { file, markdown } = await loadCanvasMarkdown(client, fileId, { raw: false }, spinner);
        const sec = extractSection(markdown as string, options.contains, options.type);
        const block = `${'#'.repeat(sec.level)} ${sec.heading}` + (sec.body ? `\n${sec.body}` : '');

        spinner.succeed(`Section: ${sec.heading}`);

        if (options.json) {
          console.log(JSON.stringify({
            canvas_id: fileId,
            heading: sec.heading,
            level: sec.level,
            markdown: block,
          }, null, 2));
          return;
        }

        if (options.raw) {
          console.log(sec.body);
          return;
        }

        console.log('\n' + block);
      } catch (err: any) {
        spinner.fail('Failed to read canvas section');
        error(err.message);
        process.exit(1);
      }
    });

  // Update (replace) a section by ID
  section
    .command('update')
    .description('Replace a section\'s content by section ID')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .argument('<section-id>', 'Section ID (from "canvas section list")')
    .option('--content <markdown>', 'New section content as markdown')
    .option('--file <path>', 'Read section markdown from a file')
    .option('--stdin', 'Read section markdown from stdin', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, sectionId, options) => {
      if (!CANVAS_ID_PATTERN.test(canvasId)) {
        error('Invalid canvas ID', 'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
        process.exit(1);
      }

      let change: CanvasChange;
      try {
        const markdown = await resolveMarkdown(options);
        change = buildEditChange('replace', markdown, sectionId);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }

      const spinner = ora('Updating canvas section...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        await client.editCanvas(canvasId, [change]);
        spinner.succeed(`Updated section ${sectionId} in canvas ${canvasId}`);

        if (options.json) {
          console.log(JSON.stringify({ ok: true, canvas_id: canvasId, section_id: sectionId, change }, null, 2));
          return;
        }

        success(`Updated section ${sectionId} in canvas ${canvasId}`);
      } catch (err: any) {
        spinner.fail('Failed to update canvas section');
        error(err.message);
        process.exit(1);
      }
    });

  // Delete a section by ID
  section
    .command('delete')
    .description('Delete a section by section ID')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .argument('<section-id>', 'Section ID (from "canvas section list")')
    .option('-y, --yes', 'Skip the confirmation prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, sectionId, options) => {
      if (!CANVAS_ID_PATTERN.test(canvasId)) {
        error('Invalid canvas ID', 'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).');
        process.exit(1);
      }

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          error('Refusing to delete without confirmation.', 'Re-run with --yes to delete non-interactively.');
          process.exit(1);
        }

        const confirmed = await confirmPrompt(
          `Delete section ${sectionId} from canvas ${canvasId}? This cannot be undone.`,
        );
        if (!confirmed) {
          info('Aborted.');
          return;
        }
      }

      const spinner = ora('Deleting canvas section...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);
        const change = buildEditChange('delete', undefined, sectionId);
        await client.editCanvas(canvasId, [change]);
        spinner.succeed(`Deleted section ${sectionId} from canvas ${canvasId}`);

        if (options.json) {
          console.log(JSON.stringify({ ok: true, canvas_id: canvasId, section_id: sectionId }, null, 2));
          return;
        }

        success(`Section ${sectionId} deleted from canvas ${canvasId}.`);
      } catch (err: any) {
        spinner.fail('Failed to delete canvas section');
        error(err.message);
        process.exit(1);
      }
    });

  // List section IDs (same as `canvas sections`)
  section
    .command('list')
    .description('List section IDs within a canvas')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('--contains <text>', 'Only sections containing this text')
    .option('--type <type>', 'Section type: h1, h2, h3, or any_header')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => runSectionLookup(canvasId, options));

  // Delete a canvas (permanent)
  canvas
    .command('delete')
    .description('Permanently delete a canvas')
    .argument('<canvas-id>', 'Canvas file ID (e.g., F1234567890)')
    .option('-y, --yes', 'Skip the confirmation prompt', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (canvasId, options) => {
      // Validate the canvas ID before doing anything destructive
      if (!CANVAS_ID_PATTERN.test(canvasId)) {
        error(
          'Invalid canvas ID',
          'Canvas ID must start with F followed by alphanumeric characters (e.g., F1234567890).',
        );
        process.exit(1);
      }

      // Confirmation guard — deletion is irreversible
      if (!options.yes) {
        if (!process.stdin.isTTY) {
          error(
            'Refusing to delete without confirmation.',
            'Re-run with --yes to delete non-interactively.',
          );
          process.exit(1);
        }

        const confirmed = await confirmPrompt(
          `Delete canvas ${canvasId}? This cannot be undone.`,
        );
        if (!confirmed) {
          info('Aborted.');
          return;
        }
      }

      const spinner = ora('Deleting canvas...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        await client.deleteCanvas(canvasId);

        spinner.succeed(`Deleted canvas ${canvasId}`);

        if (options.json) {
          console.log(JSON.stringify({ ok: true, canvas_id: canvasId }, null, 2));
          return;
        }

        success(`Canvas ${canvasId} has been permanently deleted.`);
      } catch (err: any) {
        spinner.fail('Failed to delete canvas');
        error(err.message);
        process.exit(1);
      }
    });

  return canvas;
}
