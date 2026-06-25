import { SlackClient } from './slack-client.ts';
import { mergeCredential, getWorkspace } from './workspaces.ts';
import type { WorkspaceConfig, StandardCredential, BrowserCredential } from '../types/index.ts';
import { extractSlackWorkspaceName } from './curl-parser.ts';

// Authenticate with a standard token, then merge it into the workspace (keeping
// any browser credential already stored there).
export async function authenticateStandard(
  token: string,
  workspaceName: string
): Promise<WorkspaceConfig> {
  const standard: StandardCredential = {
    token,
    token_type: token.startsWith('xoxb-') ? 'bot' : 'user',
  };

  // Temporary config so auth.test runs against the new token before we save it.
  const client = new SlackClient({
    workspace_id: 'temp',
    workspace_name: workspaceName,
    standard,
    default_auth: 'standard',
  });

  try {
    const authTest = await client.testAuth();

    return await mergeCredential(authTest.team_id, {
      workspace_name: workspaceName || authTest.team,
      standard,
    });
  } catch (error: any) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

// Authenticate with browser tokens, then merge them into the workspace (keeping
// any standard credential already stored there).
export async function authenticateBrowser(
  xoxdToken: string,
  xoxcToken: string,
  workspaceUrl: string,
  workspaceName?: string
): Promise<WorkspaceConfig> {
  const defaultName = extractSlackWorkspaceName(workspaceUrl);
  const browser: BrowserCredential = { xoxc_token: xoxcToken, xoxd_token: xoxdToken };

  // Temporary config so auth.test runs against the new tokens before we save them.
  const client = new SlackClient({
    workspace_id: 'temp',
    workspace_name: workspaceName || defaultName,
    workspace_url: workspaceUrl,
    browser,
    default_auth: 'browser',
  });

  try {
    const authTest = await client.testAuth();

    return await mergeCredential(authTest.team_id, {
      workspace_name: workspaceName || authTest.team,
      workspace_url: workspaceUrl,
      browser,
    });
  } catch (error: any) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

// Get authenticated client for workspace
export async function getAuthenticatedClient(workspaceIdentifier?: string): Promise<SlackClient> {
  const workspace = await getWorkspace(workspaceIdentifier);

  if (!workspace) {
    if (workspaceIdentifier) {
      throw new Error(`Workspace not found: ${workspaceIdentifier}`);
    } else {
      throw new Error('No workspace configured. Run "slackcli auth login" first.');
    }
  }

  return new SlackClient(workspace);
}
