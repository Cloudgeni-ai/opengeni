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

/** Workspace settings: workspace name, API keys, environments link, danger zone. */
export function workspaceSettingsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/settings`;
}

/** Organization (formerly "account") settings: billing, usage, plan, members. */
export function orgSettingsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/organization`;
}

// Stripe checkout redirects land on `/billing?checkout=success|cancelled` (the
// success_url/cancel_url baked into every checkout session by the API). The
// `/billing` route forwards the shopper onto their account page, carrying this
// outcome so the balance view can confirm the top-up. Unknown values are
// dropped so a stray `?checkout=foo` never renders a confirmation.
export type CheckoutOutcome = "success" | "cancelled";

export function parseCheckoutOutcome(search: Record<string, unknown>): CheckoutOutcome | undefined {
  return search.checkout === "success" || search.checkout === "cancelled"
    ? search.checkout
    : undefined;
}
