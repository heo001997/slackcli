import { mkdir, readFile, writeFile, exists } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type {
  WorkspacesData,
  WorkspaceConfig,
  StandardCredential,
  BrowserCredential,
} from '../types/index.ts';

const CONFIG_DIR = join(homedir(), '.config', 'slackcli');
const WORKSPACES_FILE = join(CONFIG_DIR, 'workspaces.json');

// Ensure config directory exists
async function ensureConfigDir(): Promise<void> {
  if (!await exists(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

// Migrate a single workspace from a legacy (auth_type-tagged, one-credential)
// shape to the unified shape with nested standard/browser creds. A workspace
// without auth_type is already migrated and passed through unchanged.
// Exported for unit testing (pure — no filesystem access).
export function migrateWorkspace(raw: any): WorkspaceConfig {
  if (!raw || typeof raw !== 'object' || !('auth_type' in raw)) {
    return raw as WorkspaceConfig;
  }

  const base = {
    workspace_id: raw.workspace_id,
    workspace_name: raw.workspace_name,
  };

  if (raw.auth_type === 'browser') {
    return {
      ...base,
      workspace_url: raw.workspace_url,
      browser: { xoxc_token: raw.xoxc_token, xoxd_token: raw.xoxd_token },
      default_auth: 'browser',
    };
  }

  return {
    ...base,
    standard: { token: raw.token, token_type: raw.token_type },
    default_auth: 'standard',
  };
}

// Load workspaces data, migrating any legacy entries on read.
export async function loadWorkspaces(): Promise<WorkspacesData> {
  await ensureConfigDir();

  if (!await exists(WORKSPACES_FILE)) {
    return { workspaces: {} };
  }

  try {
    const raw = await readFile(WORKSPACES_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { default_workspace?: string; workspaces?: Record<string, any> };

    const workspaces: Record<string, WorkspaceConfig> = {};
    for (const [id, ws] of Object.entries(parsed.workspaces || {})) {
      workspaces[id] = migrateWorkspace(ws);
    }

    return { default_workspace: parsed.default_workspace, workspaces };
  } catch (error) {
    console.error('Error loading workspaces:', error);
    return { workspaces: {} };
  }
}

// Save workspaces data
export async function saveWorkspaces(data: WorkspacesData): Promise<void> {
  await ensureConfigDir();
  await writeFile(WORKSPACES_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Merge one credential into a workspace WITHOUT dropping the other. Used by the
// login path so a second login (e.g. adding a standard token to a workspace that
// already has browser tokens) augments rather than clobbers. Preserves name and
// workspace_url, and seeds default_auth from the first credential added.
export async function mergeCredential(
  workspaceId: string,
  patch: {
    workspace_name?: string;
    workspace_url?: string;
    standard?: StandardCredential;
    browser?: BrowserCredential;
  },
): Promise<WorkspaceConfig> {
  const data = await loadWorkspaces();
  const existing = data.workspaces[workspaceId];

  const merged: WorkspaceConfig = {
    workspace_id: workspaceId,
    workspace_name: patch.workspace_name || existing?.workspace_name || workspaceId,
    workspace_url: patch.workspace_url ?? existing?.workspace_url,
    standard: patch.standard ?? existing?.standard,
    browser: patch.browser ?? existing?.browser,
    default_auth: existing?.default_auth ?? (patch.standard ? 'standard' : 'browser'),
  };

  data.workspaces[workspaceId] = merged;

  if (!data.default_workspace) {
    data.default_workspace = workspaceId;
  }

  await saveWorkspaces(data);
  return merged;
}

// Remove a single credential from a workspace, keeping the other. If no
// credential remains, the whole workspace is dropped (and the default realigned).
export async function removeCredential(
  workspaceId: string,
  cred: 'standard' | 'browser',
): Promise<void> {
  const data = await loadWorkspaces();
  const workspace = data.workspaces[workspaceId];

  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  if (cred === 'standard') {
    delete workspace.standard;
  } else {
    delete workspace.browser;
    delete workspace.workspace_url;
  }

  // Realign default_auth to a surviving credential.
  if (workspace.default_auth === cred) {
    workspace.default_auth = workspace.standard ? 'standard' : workspace.browser ? 'browser' : undefined;
  }

  // No credentials left → drop the workspace entirely.
  if (!workspace.standard && !workspace.browser) {
    delete data.workspaces[workspaceId];
    if (data.default_workspace === workspaceId) {
      const remainingIds = Object.keys(data.workspaces);
      data.default_workspace = remainingIds.length > 0 ? remainingIds[0] : undefined;
    }
  }

  await saveWorkspaces(data);
}

// Remove a workspace
export async function removeWorkspace(workspaceId: string): Promise<void> {
  const data = await loadWorkspaces();

  if (!data.workspaces[workspaceId]) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  delete data.workspaces[workspaceId];

  // Update default if we removed it
  if (data.default_workspace === workspaceId) {
    const remainingIds = Object.keys(data.workspaces);
    data.default_workspace = remainingIds.length > 0 ? remainingIds[0] : undefined;
  }

  await saveWorkspaces(data);
}

// Set default workspace
export async function setDefaultWorkspace(workspaceId: string): Promise<void> {
  const data = await loadWorkspaces();

  if (!data.workspaces[workspaceId]) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  data.default_workspace = workspaceId;
  await saveWorkspaces(data);
}

// Get workspace by ID or name
export async function getWorkspace(identifier?: string): Promise<WorkspaceConfig | null> {
  const data = await loadWorkspaces();

  // If no identifier, return default workspace
  if (!identifier) {
    if (!data.default_workspace) {
      return null;
    }
    return data.workspaces[data.default_workspace] || null;
  }

  // Try to find by ID first
  if (data.workspaces[identifier]) {
    return data.workspaces[identifier];
  }

  // Try to find by name
  const workspaceByName = Object.values(data.workspaces).find(
    w => w.workspace_name === identifier
  );

  return workspaceByName || null;
}

// Get all workspaces
export async function getAllWorkspaces(): Promise<WorkspaceConfig[]> {
  const data = await loadWorkspaces();
  return Object.values(data.workspaces);
}

// Clear all workspaces
export async function clearAllWorkspaces(): Promise<void> {
  await saveWorkspaces({ workspaces: {} });
}

// Get default workspace ID
export async function getDefaultWorkspaceId(): Promise<string | undefined> {
  const data = await loadWorkspaces();
  return data.default_workspace;
}
