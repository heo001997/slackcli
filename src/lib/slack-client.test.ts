import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlackClient } from './slack-client.ts';

class TestSlackClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor() {
    super({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'browser',
    });
  }

  override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });

    if (method === 'files.getUploadURLExternal') {
      return {
        ok: true,
        upload_url: 'https://uploads.slack.test/file',
        file_id: 'F123',
      };
    }

    if (method === 'files.completeUploadExternal') {
      return {
        ok: true,
        files: [{ id: 'F123' }],
      };
    }

    if (method === 'files.info') {
      return {
        ok: true,
        file: { id: 'F123', permalink: 'https://example.slack.com/files/F123' },
      };
    }

    throw new Error(`Unexpected method: ${method}`);
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SlackClient.uploadFileExternal', () => {
  it('uploads a local file and shares it with the message as the initial comment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-upload-'));
    const filePath = join(dir, 'report.txt');
    await Bun.write(filePath, 'Quarterly report');

    let uploadRequest: { url: string; bodyText: string; contentType?: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(Uint8Array);
      uploadRequest = {
        url: String(input),
        bodyText: new TextDecoder().decode(body as Uint8Array),
        contentType: init?.headers instanceof Headers
          ? init.headers.get('Content-Type') ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.['Content-Type'],
      };

      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const client = new TestSlackClient();

      const result = await client.uploadFileExternal('C123', filePath, {
        initial_comment: 'Here is the file',
      });

      expect(client.calls).toEqual([
        {
          method: 'files.getUploadURLExternal',
          params: {
            filename: 'report.txt',
            length: 16,
          },
        },
        {
          method: 'files.completeUploadExternal',
          params: {
            files: JSON.stringify([{ id: 'F123', title: 'report.txt' }]),
            channel_id: 'C123',
            initial_comment: 'Here is the file',
          },
        },
        {
          method: 'files.info',
          params: { file: 'F123' },
        },
      ]);
      expect(result).toEqual({
        file_id: 'F123',
        permalink: 'https://example.slack.com/files/F123',
      });
      expect(uploadRequest).toEqual({
        url: 'https://uploads.slack.test/file',
        bodyText: 'Quarterly report',
        contentType: 'application/octet-stream',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits channel_id when no channel is given (private upload) and returns the permalink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slackcli-upload-'));
    const filePath = join(dir, 'shot.png');
    await Bun.write(filePath, 'binary-ish');

    globalThis.fetch = (async (_input, _init) => new Response('', { status: 200 })) as typeof fetch;

    try {
      const client = new TestSlackClient();

      const result = await client.uploadFileExternal(undefined, filePath, {});

      // No channel_id in the completeUploadExternal params → file stays private.
      expect(client.calls).toEqual([
        { method: 'files.getUploadURLExternal', params: { filename: 'shot.png', length: 10 } },
        {
          method: 'files.completeUploadExternal',
          params: { files: JSON.stringify([{ id: 'F123', title: 'shot.png' }]) },
        },
        { method: 'files.info', params: { file: 'F123' } },
      ]);
      expect(result).toEqual({
        file_id: 'F123',
        permalink: 'https://example.slack.com/files/F123',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the file does not exist', async () => {
    const client = new TestSlackClient();

    await expect(
      client.uploadFileExternal('C123', '/tmp/slackcli-missing-file.txt', {
        initial_comment: 'Here is the file',
      }),
    ).rejects.toThrow('File not found: /tmp/slackcli-missing-file.txt');

    expect(client.calls).toEqual([]);
  });
});

describe('SlackClient capability routing', () => {
  it('throws an actionable error when a standard-only method has no standard cred', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'browser',
    });

    await expect(client.request('canvases.create', {})).rejects.toThrow(
      /requires a standard token/,
    );
  });

  it('throws an actionable error when a browser-only method has no browser cred', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      standard: { token: 'xoxp-test', token_type: 'user' },
      default_auth: 'standard',
    });

    await expect(client.request('drafts.create', {})).rejects.toThrow(
      /requires browser auth/,
    );
  });

  it('reports browser as the effective auth type when both creds are present', () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      standard: { token: 'xoxp-test', token_type: 'user' },
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'standard',
    });

    expect(client.authType).toBe('browser');
  });
});

class CapturingSlackClient extends SlackClient {
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor() {
    super({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'browser',
    });
  }

  override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return { ok: true };
  }
}

describe('SlackClient.deleteCanvas', () => {
  it('calls canvases.delete with the canvas_id', async () => {
    const client = new CapturingSlackClient();

    await client.deleteCanvas('F1234567890');

    expect(client.calls).toEqual([
      { method: 'canvases.delete', params: { canvas_id: 'F1234567890' } },
    ]);
  });
});

describe('SlackClient.deleteDraft', () => {
  it('calls drafts.delete with the client clock and skip_file_deletion=false by default', async () => {
    const client = new CapturingSlackClient();
    await client.deleteDraft('Dr0B9F9HD2RL');
    expect(client.calls).toHaveLength(1);
    const { method, params } = client.calls[0];
    expect(method).toBe('drafts.delete');
    expect(params.draft_id).toBe('Dr0B9F9HD2RL');
    expect(params.skip_file_deletion).toBe('false');
    expect(params.client_last_updated_ts).toMatch(/^\d+\.\d+$/);
  });

  it('honors an explicit clientLastUpdatedTs and skip_file_deletion=true when keepFiles is set', async () => {
    const client = new CapturingSlackClient();
    await client.deleteDraft('Dr0B9F9HD2RL', { clientLastUpdatedTs: '999.000', skipFileDeletion: true });
    expect(client.calls).toEqual([
      {
        method: 'drafts.delete',
        params: { draft_id: 'Dr0B9F9HD2RL', client_last_updated_ts: '999.000', skip_file_deletion: 'true' },
      },
    ]);
  });
});

describe('SlackClient.downloadFileBytes', () => {
  it('authenticates with the browser cookie, not the bearer token, even when a standard token exists', async () => {
    // Slack's url_private 302-redirects bearer tokens to the login page, so the
    // browser cookie must win whenever it is present.
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      standard: { token: 'xoxp-test', token_type: 'user' },
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'browser',
    });

    let sentHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input, init) => {
      sentHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;

    const { bytes, contentType } = await client.downloadFileBytes('https://files.slack.com/files-pri/T123-F1/a.png');

    expect(sentHeaders['Cookie']).toBe('d=xoxd-test');
    expect(sentHeaders['Authorization']).toBeUndefined();
    expect(contentType).toBe('image/png');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('throws an actionable login-redirect error when Slack 302s the download', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'browser',
    });

    globalThis.fetch = (async (_input, _init) =>
      new Response('', { status: 302, headers: { location: 'https://example.slack.com/?redir=x' } })) as typeof fetch;

    await expect(
      client.downloadFileBytes('https://files.slack.com/files-pri/T123-F1/a.png'),
    ).rejects.toThrow(/login page/);
  });
});

describe('SlackClient browser auth errors', () => {
  it('maps invalid_auth to an actionable re-login hint', async () => {
    const client = new SlackClient({
      workspace_id: 'T123',
      workspace_name: 'Test Workspace',
      workspace_url: 'https://example.slack.com',
      browser: { xoxc_token: 'xoxc-test', xoxd_token: 'xoxd-test' },
      default_auth: 'browser',
    });

    globalThis.fetch = (async (_input, _init) =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })) as typeof fetch;

    // saved.list is a browser-only method, so it routes through browserRequest.
    await expect(client.request('saved.list', {})).rejects.toThrow(/browser session/);
  });
});
