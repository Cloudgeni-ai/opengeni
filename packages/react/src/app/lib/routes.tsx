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

/** First-class durable workspace memory surface. */
export function workspaceMemoryPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/memory`;
}

/** Workspace Insights — usage, spend, live ops (preview surface). */
export function workspaceInsightsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/insights`;
}

/** Workspace settings: workspace name, API keys, environments link, danger zone. */
export function workspaceSettingsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/settings`;
}

/** Organization (formerly "account") settings: billing, usage, plan, members. */
export function orgSettingsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/organization`;
}

// Stripe Checkout may return directly to organization billing or through the
// API's `/billing` fallback. Keep only known outcome values for the balance
// confirmation; a stray `?checkout=foo` never renders one.
export type CheckoutOutcome = "success" | "cancelled";

export function parseCheckoutOutcome(search: Record<string, unknown>): CheckoutOutcome | undefined {
  return search.checkout === "success" || search.checkout === "cancelled"
    ? search.checkout
    : undefined;
}

/** Full-page artifact return context belongs to route assembly, not the session graph. */
export type ArtifactReturnSearch = {
  fromSession?: string | undefined;
  kind?: "site" | "image" | "document" | "spreadsheet" | "presentation" | "file" | undefined;
  q?: string | undefined;
  sort?: "newest" | "title" | undefined;
  status?: "archived" | undefined;
  /**
   * Opened from the Artifacts list: show the artifact's detail page with the
   * list's previous/next controls. Without it (a link from a chat, a
   * notification, a copied or pasted URL) the artifact opens straight in its
   * full view, and leaving the full view shows the detail page.
   */
  browse?: boolean | undefined;
  /**
   * A Site's own sub-page. `publish` is kept for links made before Publish to
   * web moved into the Site's Settings tab, and opens that tab.
   */
  view?: "publish" | undefined;
  /** A Site page's tab other than the Site itself. */
  tab?: SiteDetailTab | undefined;
};

export type SiteDetailTab = "versions" | "conversations" | "data" | "settings";

export function artifactReturnSearch(search: Record<string, unknown>): ArtifactReturnSearch {
  // Router match search merges validation over raw input. An omitted key would
  // leave an invalid raw fromSession available to useSearch() consumers.
  return {
    fromSession:
      typeof search.fromSession === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(search.fromSession)
        ? search.fromSession
        : undefined,
    kind:
      search.kind === "site" ||
      search.kind === "image" ||
      search.kind === "document" ||
      search.kind === "spreadsheet" ||
      search.kind === "presentation" ||
      search.kind === "file"
        ? search.kind
        : undefined,
    q: typeof search.q === "string" ? search.q.slice(0, 500) || undefined : undefined,
    sort: search.sort === "newest" || search.sort === "title" ? search.sort : undefined,
    status: search.status === "archived" ? "archived" : undefined,
    browse: search.browse === true ? true : undefined,
    view: search.view === "publish" ? "publish" : undefined,
    tab:
      search.tab === "versions" ||
      search.tab === "conversations" ||
      search.tab === "data" ||
      search.tab === "settings"
        ? search.tab
        : undefined,
  };
}
