import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { success, error } from '../lib/formatter.ts';
import { resolveMentions } from '../lib/mentions.ts';

export function createMessagesCommand(): Command {
  const messages = new Command('messages')
    .description('Send and manage messages');

  // Send message
  messages
    .command('send')
    .description('Send a message to a channel or user')
    .requiredOption('--recipient-id <id>', 'Channel ID or User ID')
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Send as reply to thread')
    .option('--file <path>', 'Attach a file to the message')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Sending message...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        // Check if recipient is a user ID (starts with U) and needs DM opened
        let channelId = options.recipientId;
        if (options.recipientId.startsWith('U')) {
          spinner.text = 'Opening direct message...';
          const dmResponse = await client.openConversation(options.recipientId);
          channelId = dmResponse.channel.id;
        }

        spinner.text = 'Sending message...';
        if (options.file) {
          await client.uploadFileExternal(channelId, options.file, {
            initial_comment: options.message,
            thread_ts: options.threadTs,
          });

          spinner.succeed('Message sent successfully!');
          success('File uploaded successfully');
          return;
        }

        const response = await client.postMessage(channelId, options.message, {
          thread_ts: options.threadTs,
        });

        spinner.succeed('Message sent successfully!');
        success(`Message timestamp: ${response.ts}`);
      } catch (err: any) {
        spinner.fail('Failed to send message');
        error(err.message);
        process.exit(1);
      }
    });

  // Add reaction to message
  messages
    .command('react')
    .description('Add a reaction to a message')
    .requiredOption('--channel-id <id>', 'Channel ID where the message is')
    .requiredOption('--timestamp <ts>', 'Message timestamp')
    .requiredOption('--emoji <name>', 'Emoji name (e.g., thumbsup, heart, fire)')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Adding reaction...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        await client.addReaction(options.channelId, options.timestamp, options.emoji);

        spinner.succeed('Reaction added successfully!');
        success(`Added :${options.emoji}: to message ${options.timestamp}`);
      } catch (err: any) {
        spinner.fail('Failed to add reaction');
        error(err.message);
        process.exit(1);
      }
    });

  // Create draft message
  messages
    .command('draft')
    .description('Create a draft message in a channel or user. Note: Only works with Browser Session Tokens. Slack apps cannot create drafts.')
    .requiredOption('--recipient-id <id>', 'Channel ID or User ID')
    .requiredOption('--message <text>', 'Message text content')
    .option('--thread-ts <timestamp>', 'Create draft as reply to thread')
    .option('--workspace <id|name>', 'Workspace to use')
    .action(async (options) => {
      const spinner = ora('Creating draft...').start();

      try {
        const client = await getAuthenticatedClient(options.workspace);

        let channelId = options.recipientId;
        if (options.recipientId.startsWith('U')) {
          spinner.text = 'Opening direct message...';
          const dmResponse = await client.openConversation(options.recipientId);
          channelId = dmResponse.channel.id;
        }

        spinner.text = 'Resolving mentions...';
        const resolvedMessage = await resolveMentions(options.message, client);

        spinner.text = 'Creating draft...';
        const response = await client.createDraft(channelId, resolvedMessage, {
          thread_ts: options.threadTs,
        });

        spinner.succeed('Draft created successfully!');
        success(`Draft ID: ${response.draft.id}`);
      } catch (err: any) {
        spinner.fail('Failed to create draft');
        error(err.message);
        process.exit(1);
      }
    });

  // Manage draft messages
  const DRAFT_ID_PATTERN = /^Dr[A-Za-z0-9]+$/;

  const drafts = new Command('drafts').description('Manage draft messages');
  drafts
    .command('delete')
    .description('Delete a draft message by its draft ID (e.g. Dr0B9F9HD2RL). Requires Browser Session Tokens.')
    .argument('<draft-id>', 'Draft ID to delete (starts with Dr)')
    .option('--keep-files', 'Keep files attached to the draft (skip_file_deletion)', false)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .action(async (draftId, options) => {
      if (!DRAFT_ID_PATTERN.test(draftId)) {
        error('Invalid draft ID', 'Draft ID must start with "Dr" (e.g. Dr0B9F9HD2RL).');
        process.exit(1);
      }

      const spinner = ora('Deleting draft...').start();
      try {
        const client = await getAuthenticatedClient(options.workspace);
        await client.deleteDraft(draftId, { skipFileDeletion: options.keepFiles });
        spinner.succeed(`Deleted draft ${draftId}`);

        if (options.json) {
          console.log(JSON.stringify({ ok: true, draft_id: draftId }, null, 2));
          return;
        }
        success(`Draft ${draftId} has been deleted.`);
      } catch (err: any) {
        spinner.fail('Failed to delete draft');
        error(err.message);
        process.exit(1);
      }
    });
  messages.addCommand(drafts);

  return messages;
}
