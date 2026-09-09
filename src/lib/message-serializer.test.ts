import { describe, expect, it } from 'bun:test';
import { serializeFile, serializeMessage } from './message-serializer.ts';
import type { SlackFile, SlackMessage } from '../types/index.ts';

describe('serializeFile', () => {
  it('keeps plain_text — the only content of an emailed file', () => {
    // Regression: Slack's email bridge posts a message whose top-level `text`
    // is empty and whose entire body lives in files[0].plain_text. The old
    // inline projection dropped it, so consumers saw a filename and nothing
    // else (5318 bytes of real content reduced to 681).
    const file: SlackFile = {
      id: 'F123',
      name: 'Daily SendGrid Statistics Report',
      filetype: 'email',
      plain_text: "It's time to review your email performance.",
      preview_plain_text: "It's time to review your email...",
      subject: 'Daily SendGrid Statistics Report',
    };

    const out = serializeFile(file);

    expect(out.plain_text).toBe("It's time to review your email performance.");
    expect(out.preview_plain_text).toBe("It's time to review your email...");
    expect(out.subject).toBe('Daily SendGrid Statistics Report');
  });

  it('still exposes the original identity and link fields', () => {
    const out = serializeFile({
      id: 'F1',
      name: 'a.png',
      title: 'A',
      mimetype: 'image/png',
      filetype: 'png',
      size: 1024,
      url_private: 'https://files.slack.com/files-pri/T1/a.png',
      permalink: 'https://ws.slack.com/files/U1/F1/a.png',
      mode: 'hosted',
    });

    expect(out.id).toBe('F1');
    expect(out.name).toBe('a.png');
    expect(out.mimetype).toBe('image/png');
    expect(out.size).toBe(1024);
    expect(out.url_private).toBe('https://files.slack.com/files-pri/T1/a.png');
    expect(out.permalink).toBe('https://ws.slack.com/files/U1/F1/a.png');
  });

  it('does not leak url_private_download', () => {
    // Kept from the previous behaviour: the download URL is deliberately not
    // part of the JSON projection.
    const out = serializeFile({ id: 'F1', url_private_download: 'https://x/dl' });
    expect(out.url_private_download).toBeUndefined();
  });
});

describe('serializeMessage', () => {
  const base: SlackMessage = { type: 'message', text: '', ts: '1700000000.000100' };

  it('includes attachments — bot alerts carry their body there', () => {
    // Regression: `conversations get` omitted attachments entirely while
    // `conversations read` included them, so the same message returned
    // different content depending on the command. Rollbar/Bitbucket/Sentry put
    // their title and body in attachments[0], so dropping it loses everything.
    const msg: SlackMessage = {
      ...base,
      bot_id: 'B1',
      attachments: [
        { fallback: '<https://rollbar/1805|#1805 New error: ParameterMissing>' },
      ],
    };

    const out = serializeMessage(msg);

    expect(out.attachments).toBeDefined();
    expect((out.attachments as Array<Record<string, unknown>>)[0].fallback)
      .toContain('#1805 New error');
  });

  it('includes blocks', () => {
    const out = serializeMessage({
      ...base,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Deploy* failed' } }],
    });
    expect((out.blocks as unknown[]).length).toBe(1);
  });

  it('exposes the identity fields needed to attribute a bot post', () => {
    const out = serializeMessage({
      ...base,
      subtype: 'bot_message',
      username: 'Rollbar',
      app_id: 'A1',
      team: 'T1',
    });

    expect(out.subtype).toBe('bot_message');
    expect(out.username).toBe('Rollbar');
    expect(out.app_id).toBe('A1');
    expect(out.team).toBe('T1');
  });

  it('omits files entirely when the message has none', () => {
    expect(serializeMessage(base).files).toBeUndefined();
  });

  it('maps every file through serializeFile', () => {
    const out = serializeMessage({
      ...base,
      files: [
        { id: 'F1', name: 'a.txt', plain_text: 'first' },
        { id: 'F2', name: 'b.txt', plain_text: 'second' },
      ],
    });

    const files = out.files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);
    expect(files[0].plain_text).toBe('first');
    expect(files[1].plain_text).toBe('second');
  });

  it('is identical for read and get paths', () => {
    // Both commands now share one projection, so a message can never serialize
    // differently depending on which command produced it.
    const msg: SlackMessage = {
      ...base,
      attachments: [{ fallback: 'x' }],
      files: [{ id: 'F1', plain_text: 'body' }],
    };
    expect(JSON.stringify(serializeMessage(msg)))
      .toBe(JSON.stringify(serializeMessage(msg)));
  });
});
