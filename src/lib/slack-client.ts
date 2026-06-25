import { WebClient } from '@slack/web-api';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { WorkspaceConfig, AuthClass, SlackAuthTestResponse, CanvasChange, CanvasSectionCriteria } from '../types/index.ts';
import { parseMrkdwn } from './mrkdwn.ts';

interface ExternalUploadUrlResponse {
  upload_url?: string;
  file_id?: string;
}

// Which credential each Slack method accepts. Methods not listed work with
// either credential ('any'). Verified by live probing on T037LUW4MMM:
//  - canvases.* reject browser tokens (not_allowed_token_type) → standard_only
//  - files upload + drafts + the web-client-only endpoints reject xoxp
//    (missing_scope / not allowed) → browser_only
const METHOD_AUTH: Record<string, AuthClass> = {
  'canvases.create': 'standard_only',
  'canvases.edit': 'standard_only',
  'canvases.delete': 'standard_only',
  'canvases.sections.lookup': 'standard_only',
  'conversations.canvases.create': 'standard_only',
  'files.getUploadURLExternal': 'browser_only',
  'files.completeUploadExternal': 'browser_only',
  'drafts.create': 'browser_only',
  'drafts.delete': 'browser_only',
  'saved.list': 'browser_only',
  'client.counts': 'browser_only',
  'search.modules': 'browser_only',
  'messages.list': 'browser_only',
};

export class SlackClient {
  private config: WorkspaceConfig;
  private webClient?: WebClient;

  constructor(config: WorkspaceConfig) {
    this.config = config;

    // The @slack/web-api WebClient backs every standard-token request.
    if (config.standard) {
      this.webClient = new WebClient(config.standard.token);
    }
  }

  // Route a Slack method to the credential that accepts it. standard_only /
  // browser_only methods throw an actionable error when their credential is
  // absent; 'any' methods prefer default_auth, falling back to whichever
  // credential exists.
  async request(method: string, params: Record<string, any> = {}): Promise<any> {
    const authClass: AuthClass = METHOD_AUTH[method] ?? 'any';

    if (authClass === 'standard_only') {
      if (!this.config.standard) {
        throw new Error(
          `"${method}" requires a standard token (xoxp/xoxb). Add one with: ` +
          `slackcli auth login --token=<xoxp…> --workspace-name="${this.config.workspace_name}"`,
        );
      }
      return this.standardRequest(method, params);
    }

    if (authClass === 'browser_only') {
      if (!this.config.browser) {
        throw new Error(
          `"${method}" requires browser auth (xoxc/xoxd). Add it with: ` +
          `slackcli auth login-browser --xoxc=… --xoxd=… --workspace-url=…`,
        );
      }
      return this.browserRequest(method, params);
    }

    // 'any': prefer default_auth, else standard, else browser.
    const useStandard =
      this.config.default_auth === 'browser' ? !this.config.browser : !!this.config.standard;

    if (useStandard && this.config.standard) {
      return this.standardRequest(method, params);
    }
    if (this.config.browser) {
      return this.browserRequest(method, params);
    }
    if (this.config.standard) {
      return this.standardRequest(method, params);
    }
    throw new Error(`No credentials configured for workspace "${this.config.workspace_name}".`);
  }

  // Standard token request (using @slack/web-api)
  private async standardRequest(method: string, params: Record<string, any>): Promise<any> {
    if (!this.webClient) {
      throw new Error('WebClient not initialized');
    }

    try {
      const response = await this.webClient.apiCall(method, params);
      return response;
    } catch (error: any) {
      throw new Error(`Slack API error: ${error.message}`);
    }
  }

  // Browser token request (custom implementation)
  private async browserRequest(method: string, params: Record<string, any>): Promise<any> {
    if (!this.config.browser || !this.config.workspace_url) {
      throw new Error('Browser auth not configured (missing xoxc/xoxd tokens or workspace_url)');
    }

    const url = `${this.config.workspace_url}/api/${method}`;

    const formBody = new URLSearchParams({
      token: this.config.browser.xoxc_token,
      ...params,
    });

    try {
      // URL-encode the xoxd token for the cookie
      const encodedXoxdToken = encodeURIComponent(this.config.browser.xoxd_token);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Cookie': `d=${encodedXoxdToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://app.slack.com',
          'User-Agent': 'Mozilla/5.0 (compatible; SlackCLI/0.1.0)',
        },
        body: formBody,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: any = await response.json();

      if (!data.ok) {
        // Surface a stale/revoked browser session as an actionable re-login hint
        // rather than an opaque "invalid_auth" — xoxc rotates and xoxd can be
        // revoked, so this is the common "I already provided the token" failure.
        if (['invalid_auth', 'not_authed', 'token_expired', 'token_revoked'].includes(data.error)) {
          throw new Error(
            `Slack rejected the browser session (${data.error}) — the xoxc/xoxd tokens ` +
            `have expired or been revoked. Refresh them with: ` +
            `slackcli auth login-browser --xoxc=… --xoxd=… --workspace-url=…`,
          );
        }
        throw new Error(data.error || 'Unknown API error');
      }

      return data;
    } catch (error: any) {
      throw new Error(`Slack API error: ${error.message}`);
    }
  }

  // Test authentication
  async testAuth(): Promise<SlackAuthTestResponse> {
    return this.request('auth.test', {});
  }

  // List conversations
  async listConversations(options: {
    types?: string;
    limit?: number;
    exclude_archived?: boolean;
    cursor?: string;
  } = {}): Promise<any> {
    return this.request('conversations.list', options);
  }

  // Get conversation history
  async getConversationHistory(channel: string, options: {
    cursor?: string;
    latest?: string;
    oldest?: string;
    inclusive?: boolean;
    limit?: number;
  } = {}): Promise<any> {
    // Filter out undefined values
    const params: Record<string, any> = { channel };
    if (options.cursor) params.cursor = options.cursor;
    if (options.latest) params.latest = options.latest;
    if (options.oldest) params.oldest = options.oldest;
    if (options.inclusive !== undefined) params.inclusive = options.inclusive;
    if (options.limit) params.limit = options.limit;

    return this.request('conversations.history', params);
  }

  // Get conversation replies (thread)
  async getConversationReplies(channel: string, ts: string, options: {
    cursor?: string;
    latest?: string;
    oldest?: string;
    inclusive?: boolean;
    limit?: number;
  } = {}): Promise<any> {
    const params: Record<string, any> = { channel, ts };
    if (options.cursor) params.cursor = options.cursor;
    if (options.latest) params.latest = options.latest;
    if (options.oldest) params.oldest = options.oldest;
    if (options.inclusive !== undefined) params.inclusive = options.inclusive;
    if (options.limit) params.limit = options.limit;

    return this.request('conversations.replies', params);
  }

  // Post message
  async postMessage(channel: string, text: string, options: {
    thread_ts?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = { channel, text };
    if (options.thread_ts) params.thread_ts = options.thread_ts;

    return this.request('chat.postMessage', params);
  }

  // Upload a local file via Slack's external-upload flow (browser-only). When
  // `channel` is omitted the file stays private — it never posts to a channel —
  // but still gets a usable permalink, which is exactly what the canvas
  // converter needs. Returns the new file_id and its permalink.
  async uploadFileExternal(channel: string | undefined, filePath: string, options: {
    initial_comment?: string;
    thread_ts?: string;
  } = {}): Promise<{ file_id: string; permalink?: string }> {
    const fileStats = await stat(filePath).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`File not found: ${filePath}`);
      }
      throw error;
    });
    if (!fileStats.isFile()) {
      throw new Error(`Cannot upload non-file path: ${filePath}`);
    }
    if (fileStats.size === 0) {
      throw new Error(`Cannot upload empty file: ${filePath}`);
    }

    const filename = basename(filePath);
    const uploadUrlResponse = await this.request('files.getUploadURLExternal', {
      filename,
      length: fileStats.size,
    }) as ExternalUploadUrlResponse;

    if (!uploadUrlResponse.upload_url || !uploadUrlResponse.file_id) {
      throw new Error('Slack API error: missing upload URL or file ID');
    }

    const fileBytes = await readFile(filePath);
    const uploadResponse = await fetch(uploadUrlResponse.upload_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: fileBytes,
    });

    if (!uploadResponse.ok) {
      throw new Error(`File upload failed: HTTP ${uploadResponse.status}`);
    }

    const params: Record<string, string> = {
      files: JSON.stringify([{ id: uploadUrlResponse.file_id, title: filename }]),
    };
    if (channel) params.channel_id = channel;
    if (options.initial_comment) params.initial_comment = options.initial_comment;
    if (options.thread_ts) params.thread_ts = options.thread_ts;

    await this.request('files.completeUploadExternal', params);

    // Resolve the permalink so callers (e.g. the canvas converter) can link to
    // the file without re-querying.
    const fileInfo = await this.getFileInfo(uploadUrlResponse.file_id);
    return { file_id: uploadUrlResponse.file_id, permalink: fileInfo.file?.permalink };
  }

  // Create draft message
  async createDraft(channelId: string, text: string, options: {
    thread_ts?: string;
  } = {}): Promise<any> {
    if (!this.config.browser) {
      throw new Error('Draft creation requires browser authentication');
    }

    const destinations: any = [{ channel_id: channelId }];
    if (options.thread_ts) {
      destinations[0].thread_ts = options.thread_ts;
      destinations[0].broadcast = false;
    }

    const params: Record<string, any> = {
      client_msg_id: crypto.randomUUID(),
      blocks: JSON.stringify(parseMrkdwn(text)),
      destinations: JSON.stringify(destinations),
      file_ids: '[]',
      is_from_composer: 'false',
    };

    return this.request('drafts.create', params);
  }

  // Delete a draft message
  async deleteDraft(draftId: string, options: {
    skipFileDeletion?: boolean;
    clientLastUpdatedTs?: string;
  } = {}): Promise<any> {
    if (!this.config.browser) {
      throw new Error('Draft deletion requires browser authentication');
    }

    // drafts.delete uses client_last_updated_ts for optimistic-concurrency: the
    // server returns draft_has_conflict if its stored stamp is newer than ours,
    // so send the client's current clock unless the caller pins a specific stamp.
    const clientLastUpdatedTs = options.clientLastUpdatedTs ?? (Date.now() / 1000).toFixed(6);

    const params: Record<string, any> = {
      draft_id: draftId,
      client_last_updated_ts: clientLastUpdatedTs,
      skip_file_deletion: options.skipFileDeletion ? 'true' : 'false',
    };

    return this.request('drafts.delete', params);
  }

  // Get user info
  async getUserInfo(userId: string): Promise<any> {
    return this.request('users.info', { user: userId });
  }

  // Get multiple users info
  async getUsersInfo(userIds: string[]): Promise<any> {
    const users: any[] = [];

    for (const userId of userIds) {
      try {
        const response = await this.getUserInfo(userId);
        if (response.ok && response.user) {
          users.push(response.user);
        }
      } catch (error) {
        // Skip users we can't fetch
        console.error(`Failed to fetch user ${userId}`);
      }
    }

    return { ok: true, users };
  }

  // Open a conversation (DM)
  async openConversation(users: string): Promise<any> {
    return this.request('conversations.open', { users });
  }

  // Add reaction to message
  async addReaction(channel: string, timestamp: string, name: string): Promise<any> {
    return this.request('reactions.add', {
      channel,
      timestamp,
      name
    });
  }

  // Remove reaction from message
  async removeReaction(channel: string, timestamp: string, name: string): Promise<any> {
    return this.request('reactions.remove', {
      channel,
      timestamp,
      name
    });
  }

  // List saved items (browser: saved.list, standard: stars.list)
  async listSavedItems(options: {
    count?: number;
    cursor?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = {};
    if (options.count) params.count = options.count;
    if (options.cursor) params.cursor = options.cursor;

    if (this.config.browser) {
      return this.request('saved.list', params);
    }
    return this.request('stars.list', params);
  }

  // Batch-fetch messages by channel + timestamp (browser auth only).
  // Groups are {channel, timestamps[]} — Slack returns full message objects
  // regardless of whether they're top-level or thread replies.
  async listMessages(messageIds: Array<{ channel: string; timestamps: string[] }>): Promise<any> {
    return this.request('messages.list', {
      message_ids: JSON.stringify(messageIds),
    });
  }

  // Search messages
  async searchMessages(query: string, options: {
    count?: number;
    page?: number;
    sort?: string;
    sort_dir?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = { query };
    if (options.count) params.count = options.count;
    if (options.page) params.page = options.page;
    if (options.sort) params.sort = options.sort;
    if (options.sort_dir) params.sort_dir = options.sort_dir;
    return this.request('search.messages', params);
  }

  // Search by module (browser: search.modules, standard: falls back to search.all)
  async searchModules(query: string, module: 'channels' | 'people', options: {
    count?: number;
    cursor?: string;
  } = {}): Promise<any> {
    if (this.config.browser) {
      const params: Record<string, any> = {
        query,
        module,
        count: options.count || 20,
      };
      if (options.cursor) params.cursor = options.cursor;
      return this.request('search.modules', params);
    }

    // Standard auth: no search.modules available — fall back to
    // listing + client-side filtering (may be slow on large workspaces)
    if (module === 'channels') {
      return this.listConversations({
        types: 'public_channel,private_channel',
        limit: 1000,
        exclude_archived: true,
      });
    } else {
      return this.listUsers({ limit: 1000 });
    }
  }

  // List users
  async listUsers(options: {
    cursor?: string;
    limit?: number;
  } = {}): Promise<any> {
    const params: Record<string, any> = {};
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit) params.limit = options.limit;
    return this.request('users.list', params);
  }

  // List usergroups (used to resolve @group:<handle> mentions to <!subteam^S…>)
  async listUsergroups(options: {
    include_disabled?: boolean;
    include_users?: boolean;
  } = {}): Promise<any> {
    const params: Record<string, any> = {};
    if (options.include_disabled !== undefined) params.include_disabled = options.include_disabled;
    if (options.include_users !== undefined) params.include_users = options.include_users;
    return this.request('usergroups.list', params);
  }

  // Get conversation info
  async getConversationInfo(channel: string): Promise<any> {
    return this.request('conversations.info', { channel });
  }

  // Get unread counts (browser: client.counts, standard: conversations.list with unread data)
  async getUnreadCounts(): Promise<any> {
    if (this.config.browser) {
      return this.request('client.counts', {});
    }
    return this.listConversations({
      types: 'public_channel,private_channel,mpim,im',
      limit: 1000,
    });
  }

  // List canvas files
  async listCanvases(options: {
    limit?: number;
    channel?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = { types: 'canvas' };
    if (options.limit) params.count = options.limit;
    if (options.channel) params.channel = options.channel;
    return this.request('files.list', params);
  }

  // Get file info (used to get canvas download URL)
  async getFileInfo(fileId: string): Promise<any> {
    return this.request('files.info', { file: fileId });
  }

  // Edit a canvas. changes[] follows Slack's canvases.edit schema.
  async editCanvas(canvasId: string, changes: CanvasChange[]): Promise<any> {
    return this.request('canvases.edit', {
      canvas_id: canvasId,
      changes: JSON.stringify(changes),
    });
  }

  // Look up section IDs within a canvas for targeted edits.
  async lookupCanvasSections(canvasId: string, criteria: CanvasSectionCriteria = {}): Promise<any> {
    return this.request('canvases.sections.lookup', {
      canvas_id: canvasId,
      criteria: JSON.stringify(criteria),
    });
  }

  // Fetch raw file bytes from a Slack url_private with the right auth, a redirect
  // guard, and a streaming size cap. Backs both downloadFile (text) and
  // downloadFileBytes (binary).
  //
  // Auth: files.slack.com / url_private authenticate via the browser session
  // cookie (d=xoxd). A standard bearer token does NOT work for these URLs —
  // Slack 302-redirects it to the login page exactly like an unauthenticated
  // request — so prefer the browser cookie whenever it exists and only fall back
  // to the bearer token when no browser credential is configured.
  private async fetchFileBytes(
    url: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const headers: Record<string, string> = {};

    if (this.config.browser) {
      headers['Cookie'] = `d=${encodeURIComponent(this.config.browser.xoxd_token)}`;
      headers['Origin'] = 'https://app.slack.com';
    } else if (this.config.standard) {
      headers['Authorization'] = `Bearer ${this.config.standard.token}`;
    }

    // redirect: 'manual' so a login redirect surfaces as a 3xx we can report,
    // instead of silently following through to a 200 sign-in page that would be
    // saved as if it were the file.
    const response = await fetch(url, { headers, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        'Slack redirected the download to a login page — the browser session is ' +
        'missing, expired, or not authorized for this file. Refresh it with: ' +
        'slackcli auth login-browser --xoxc=… --xoxd=… --workspace-url=…',
      );
    }

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // Early exit when Content-Length is known and exceeds limit
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`File too large: ${contentLength} bytes (max ${maxBytes})`);
    }

    // Stream-based size guard (handles chunked transfer / missing Content-Length)
    const reader = response.body?.getReader();
    if (!reader) {
      return { bytes: new Uint8Array(0), contentType };
    }

    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error(`File too large: exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { bytes: merged, contentType };
  }

  // Download text file content (e.g. canvas HTML) with auth + size guard.
  async downloadFile(url: string, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
    const { bytes } = await this.fetchFileBytes(url, maxBytes);
    return new TextDecoder().decode(bytes);
  }

  // Download raw file bytes (binary-safe) — used by `files download`. Returns the
  // bytes alongside the server's content-type so callers can pick an extension.
  async downloadFileBytes(
    url: string,
    maxBytes: number = 50 * 1024 * 1024,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.fetchFileBytes(url, maxBytes);
  }

  // Get canvas file ID associated with a channel or DM
  async getChannelCanvasId(channelId: string): Promise<string | null> {
    const response = await this.getConversationInfo(channelId);
    const props = response?.channel?.properties;
    if (!props) return null;

    // Standard channel canvas
    if (props.canvas?.file_id) return props.canvas.file_id;

    // DM / private conversation (stored as meeting_notes)
    if (props.meeting_notes?.file_id) return props.meeting_notes.file_id;

    // Fallback: check tabs for a canvas entry
    const canvasTab = props.tabs?.find((t: any) => t.type === 'canvas');
    if (canvasTab?.data?.file_id) return canvasTab.data.file_id;

    return null;
  }

  // Create a canvas. document_content is markdown wrapped per Slack's schema.
  async createCanvas(options: {
    title?: string;
    markdown?: string;
    channel?: string;
  } = {}): Promise<any> {
    const params: Record<string, any> = {};
    if (options.title) params.title = options.title;
    if (options.markdown) {
      params.document_content = JSON.stringify({ type: 'markdown', markdown: options.markdown });
    }
    if (options.channel) params.channel_id = options.channel;
    return this.request('canvases.create', params);
  }

  // Permanently delete a canvas. Irreversible — there is no way to recover it.
  async deleteCanvas(canvasId: string): Promise<any> {
    return this.request('canvases.delete', { canvas_id: canvasId });
  }

  // Effective auth type, browser-preferred. Callers (message.ts, unread.ts)
  // use this to anticipate which API path request() takes for 'any'-class
  // methods so they parse the matching response shape. Browser-preferred
  // because messages.list / client.counts return richer browser-only payloads.
  get authType(): string {
    return this.config.browser ? 'browser' : 'standard';
  }
}
