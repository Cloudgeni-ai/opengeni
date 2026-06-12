// Canonical console paths. Everything is workspace-scoped; there are no
// legacy unscoped session URLs.

export function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function workspaceSessionsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/sessions`;
}

/** Back-compat name: the old "agent" home is now the sessions index. */
export function workspaceAgentPath(workspaceId: string): string {
  return workspaceSessionsPath(workspaceId);
}

export function workspaceSessionPath(workspaceId: string, sessionId: string): string {
  return `${workspaceSessionsPath(workspaceId)}/${encodeURIComponent(sessionId)}`;
}
