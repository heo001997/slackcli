import type { SlackFile, SlackMessage } from '../types/index.ts';

/**
 * Serialize a Slack message for `--json` output.
 *
 * Why this exists: the JSON projection used to be written inline, once per
 * command, as an explicit allow-list of fields. Two copies drifted apart —
 * `conversations read` emitted `attachments` while `conversations get` did not,
 * so the same message returned different content depending on which command you
 * asked. The file projection also dropped `plain_text`, which for an emailed
 * file or a snippet is the ENTIRE body of the message: consumers saw a filename
 * where Slack had several KB of text.
 *
 * Keeping one projection in one place means every command returns the same
 * shape, and adding a field fixes it everywhere at once.
 */

/** File fields worth exposing, including the text-bearing ones. */
export function serializeFile(f: SlackFile): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    pretty_type: f.pretty_type,
    size: f.size,
    mode: f.mode,
    url_private: f.url_private,
    permalink: f.permalink,
    // Text content — for emailed files, posts and snippets this is the only
    // human-readable part of the message.
    plain_text: f.plain_text,
    preview: f.preview,
    preview_plain_text: f.preview_plain_text,
    // Email bridge metadata.
    subject: f.subject,
    from: f.from,
    to: f.to,
    cc: f.cc,
  };
}

/** Full message projection shared by every `--json` code path. */
export function serializeMessage(msg: SlackMessage): Record<string, unknown> {
  return {
    ts: msg.ts,
    thread_ts: msg.thread_ts,
    type: msg.type,
    subtype: msg.subtype,
    user: msg.user,
    username: msg.username,
    bot_id: msg.bot_id,
    app_id: msg.app_id,
    team: msg.team,
    text: msg.text,
    edited: msg.edited,
    reply_count: msg.reply_count,
    reactions: msg.reactions,
    blocks: msg.blocks,
    attachments: msg.attachments,
    ...(msg.files?.length ? { files: msg.files.map(serializeFile) } : {}),
  };
}
