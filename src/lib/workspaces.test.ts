import { describe, expect, it } from 'bun:test';
import { migrateWorkspace } from './workspaces.ts';

// Pure migration only — these never touch the on-disk config file.
describe('migrateWorkspace', () => {
  it('migrates a legacy browser workspace into a nested browser credential', () => {
    const migrated = migrateWorkspace({
      workspace_id: 'T037LUW4MMM',
      workspace_name: 'Wellifiy',
      auth_type: 'browser',
      xoxc_token: 'xoxc-abc',
      xoxd_token: 'xoxd-def',
      workspace_url: 'https://wellifiyworkspace.slack.com',
    });

    expect(migrated).toEqual({
      workspace_id: 'T037LUW4MMM',
      workspace_name: 'Wellifiy',
      workspace_url: 'https://wellifiyworkspace.slack.com',
      browser: { xoxc_token: 'xoxc-abc', xoxd_token: 'xoxd-def' },
      default_auth: 'browser',
    });
  });

  it('migrates a legacy standard workspace into a nested standard credential', () => {
    const migrated = migrateWorkspace({
      workspace_id: 'T1',
      workspace_name: 'Acme',
      auth_type: 'standard',
      token: 'xoxp-123',
      token_type: 'user',
    });

    expect(migrated).toEqual({
      workspace_id: 'T1',
      workspace_name: 'Acme',
      standard: { token: 'xoxp-123', token_type: 'user' },
      default_auth: 'standard',
    });
  });

  it('passes an already-migrated workspace through unchanged', () => {
    const unified = {
      workspace_id: 'T2',
      workspace_name: 'Beta',
      workspace_url: 'https://beta.slack.com',
      standard: { token: 'xoxp-1', token_type: 'user' as const },
      browser: { xoxc_token: 'xoxc-1', xoxd_token: 'xoxd-1' },
      default_auth: 'standard' as const,
    };

    expect(migrateWorkspace(unified)).toEqual(unified);
  });
});
