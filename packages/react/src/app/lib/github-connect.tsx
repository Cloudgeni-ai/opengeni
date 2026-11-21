/**
 * Whether this workspace has GitHub connected (the GitHub App installed on
 * an account or organization) and where Connected tools connects it. A GitHub
 * event source needs it; the agent page's Add trigger and the Add a source
 * page both ask with these.
 */

/** Where Connected tools opens the GitHub connection. */
export function githubConnectHref(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins?open=integration:github`;
}

/**
 * True when GitHub is connected, false when it isn't; null when unknown (not
 * read yet) or when this server has no GitHub App ("disabled"), so the
 * server decides and explains when a GitHub source is added.
 */
export function githubConnectedOf(status: string | null | undefined): boolean | null {
  if (status === undefined || status === null || status === "disabled") return null;
  return status === "bound";
}
