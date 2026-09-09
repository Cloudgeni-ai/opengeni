const SITE_WORKSPACE_PREFIX = "/v1/workspaces/site-host";

/** A Site SDK request attempted to escape its host-owned API destination. */
export class SiteSessionPathError extends Error {
  readonly code = "site_session_path_unsupported";

  constructor() {
    super("Unsupported Site session API path");
    this.name = "SiteSessionPathError";
  }
}

/** Host-owned destination routing, not an operation permission list.
 * Published Sites use the viewer's authenticated transport; sandbox previews
 * use an exact live agent attempt and its restricted delegated permissions.
 * Ordinary API handlers enforce permissions, resource access and agent reach.
 * Tool calls additionally retain their pinned Site/attempt catalog boundary.
 */
export function siteSessionPath(
  path: string,
  workspaceId: string,
  method = "GET",
  siteId?: string,
): string {
  const pathname = path.split("?")[0]!;
  const workspacePath =
    pathname === SITE_WORKSPACE_PREFIX || pathname.startsWith(`${SITE_WORKSPACE_PREFIX}/`);
  const clientConfig = pathname === "/v1/config/client" && method.toUpperCase() === "GET";
  if (
    (!workspacePath && !clientConfig) ||
    /[%\\#]/u.test(pathname) ||
    pathname.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new SiteSessionPathError();
  }
  const rewritten = workspacePath
    ? `/v1/workspaces/${encodeURIComponent(workspaceId)}${path.slice(SITE_WORKSPACE_PREFIX.length)}`
    : path;
  const url = new URL(rewritten, "http://site.invalid");
  // A preview has no published Site identity. Do not broaden Site-only lists.
  if (url.searchParams.get("originSiteId") === "current" && workspaceId !== "site-host") {
    url.searchParams.set("originSiteId", siteId ?? "00000000-0000-0000-0000-000000000000");
    return url.pathname + url.search;
  }
  return rewritten;
}
