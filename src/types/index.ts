// Type definitions for SlackCLI

export type AuthType = 'standard' | 'browser';
export type TokenType = 'bot' | 'user';
export type ConversationType = 'public_channel' | 'private_channel' | 'mpim' | 'im';

// Workspace configuration interfaces
//
// One workspace can hold BOTH a standard token (xoxp/xoxb) and browser tokens
// (xoxc/xoxd) at once. Each Slack method routes to the credential that accepts
// it (see METHOD_AUTH in slack-client.ts), so an image-bearing canvas — which
// needs browser-only upload AND standard-only canvas writes — works in one run.
export interface StandardCredential {
  token: string;
  token_type: TokenType;
}

export interface BrowserCredential {
  xoxc_token: string;
  xoxd_token: string;
}

export interface WorkspaceConfig {
  workspace_id: string;
  workspace_name: string;
  workspace_url?: string;        // required for any browser request
  standard?: StandardCredential;
  browser?: BrowserCredential;
  default_auth?: AuthType;       // tie-break for 'any'-class methods
}

// Which credential a Slack method accepts. 'any' methods work with either.
export type AuthClass = 'standard_only' | 'browser_only' | 'any';

// Legacy on-disk shapes (one credential per workspace, tagged by auth_type).
// Migrated to the unified shape on read, never written again.
export interface LegacyStandardConfig {
  workspace_id: string;
  workspace_name: string;
  auth_type: 'standard';
  token: string;
  token_type: TokenType;
}

export interface LegacyBrowserConfig {
  workspace_id: string;
  workspace_name: string;
  workspace_url: string;
  auth_type: 'browser';
  xoxd_token: string;
  xoxc_token: string;
}

export interface WorkspacesData {
  default_workspace?: string;
  workspaces: Record<string, WorkspaceConfig>;
}

// Slack API response types
export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: {
    value: string;
  };
  purpose?: {
    value: string;
  };
  user?: string; // For DMs
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    email?: string;
    display_name?: string;
    real_name?: string;
  };
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  mode?: string;
}

export interface SlackMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{
    name: string;
    count: number;
    users: string[];
  }>;
  blocks?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  files?: SlackFile[];
}

export interface SlackAuthTestResponse {
  ok: boolean;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
  is_enterprise_install?: boolean;
}

// CLI options interfaces
export interface ConversationListOptions {
  types?: string;
  limit?: number;
  excludeArchived?: boolean;
  workspace?: string;
}

export interface ConversationReadOptions {
  threadTs?: string;
  excludeReplies?: boolean;
  limit?: number;
  oldest?: string;
  latest?: string;
  workspace?: string;
}

export interface MessageSendOptions {
  recipientId: string;
  message: string;
  threadTs?: string;
  file?: string;
  workspace?: string;
}

export interface MessageDraftOptions {
  recipientId: string;
  message: string;
  threadTs?: string;
  workspace?: string;
}

export interface AuthLoginOptions {
  token: string;
  workspaceName: string;
}

export interface AuthLoginBrowserOptions {
  xoxd: string;
  xoxc: string;
  workspaceUrl: string;
  workspaceName?: string;
}

// Saved items
export interface SavedItem {
  type: 'message' | 'file' | string;
  channel_id: string;
  channel_name?: string;
  message?: SlackMessage;
  date_saved?: number;
  todo_state?: string;
  file?: {
    name?: string;
    title?: string;
    url_private?: string;
  };
}

// Search results
export interface SearchMatch {
  ts: string;
  text: string;
  username?: string;
  user?: string;
  permalink?: string;
  channel?: {
    id: string;
    name: string;
  };
}

export interface ChannelSearchResult {
  id: string;
  name: string;
  is_member?: boolean;
  is_private?: boolean;
  member_count?: number;
  num_members?: number;
  purpose?: {
    value: string;
  };
  topic?: {
    value: string;
  };
}

export interface PeopleSearchResult {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    title?: string;
  };
}

// Unread channel info
export interface UnreadChannel {
  id: string;
  name?: string;
  mention_count: number;
  unread_count?: number;
  has_unreads: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

// Canvas types
export interface SlackCanvas {
  id: string;
  title?: string;
  name?: string;
  created?: number;
  updated?: number;
  edit_timestamp?: number;
  user?: string;
  editors?: string[];
  size?: number;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
}

export interface CanvasListOptions {
  channel?: string;
  limit?: number;
  workspace?: string;
}

export interface CanvasReadOptions {
  channel?: string;
  raw?: boolean;
  workspace?: string;
}

export interface CanvasDocumentContent {
  type: 'markdown';
  markdown: string;
}

export interface CanvasCreateOptions {
  title?: string;
  content?: string;
  file?: string;
  stdin?: boolean;
  channel?: string;
  json?: boolean;
  workspace?: string;
}

export type CanvasEditOperation =
  | 'insert_at_start'
  | 'insert_at_end'
  | 'insert_after'
  | 'insert_before'
  | 'replace'
  | 'delete'
  | 'rename';

export interface CanvasChange {
  operation: CanvasEditOperation;
  document_content?: CanvasDocumentContent;
  // Canvas-level title for the `rename` operation only.
  title_content?: CanvasDocumentContent;
  section_id?: string;
}

export interface CanvasEditOptions {
  operation?: CanvasEditOperation;
  content?: string;
  file?: string;
  stdin?: boolean;
  section?: string;
  json?: boolean;
  workspace?: string;
}

export interface CanvasSectionCriteria {
  section_types?: Array<'h1' | 'h2' | 'h3' | 'any_header'>;
  contains_text?: string;
}

export interface CanvasSectionsOptions {
  contains?: string;
  type?: 'h1' | 'h2' | 'h3' | 'any_header';
  json?: boolean;
  workspace?: string;
}

export interface CanvasDeleteOptions {
  yes?: boolean;
  json?: boolean;
  workspace?: string;
}

// `canvas section create` — exactly one position flag plus one content source.
export interface CanvasSectionCreateOptions {
  atStart?: boolean;
  atEnd?: boolean;
  after?: string;
  before?: string;
  content?: string;
  file?: string;
  stdin?: boolean;
  json?: boolean;
  workspace?: string;
}

// `canvas section read` — pick a section by heading text and slice it out.
export interface CanvasSectionReadOptions {
  contains?: string;
  type?: 'h1' | 'h2' | 'h3' | 'any_header';
  channel?: string;
  raw?: boolean;
  json?: boolean;
  workspace?: string;
}

// `canvas section update` — replace a section by id with new content.
export interface CanvasSectionUpdateOptions {
  content?: string;
  file?: string;
  stdin?: boolean;
  json?: boolean;
  workspace?: string;
}

// `canvas section delete` — remove a section by id.
export interface CanvasSectionDeleteOptions {
  yes?: boolean;
  json?: boolean;
  workspace?: string;
}
