const SITE_WORKSPACE_PREFIX = "/v1/workspaces/site-host";

/** A Site/Codemode SDK request named a route outside the proxied surface. */
export class SiteSessionPathError extends Error {
  readonly code = "site_session_path_unsupported";

  constructor() {
    super("Unsupported Site session API path");
    this.name = "SiteSessionPathError";
  }
}

/** Route browser/preview SDK requests to the host workspace. This is a URL
 * boundary, not an endpoint or HTTP-method allowlist. Ordinary API handlers
 * authorize every operation with the viewer or agent's existing authority. */
export function siteSessionPath(
  path: string,
  workspaceId: string,
  _method = "GET",
  siteId?: string,
): string {
  const pathname = path.split("?")[0]!;
  const workspace =
    pathname === SITE_WORKSPACE_PREFIX || pathname.startsWith(`${SITE_WORKSPACE_PREFIX}/`);
  const context = pathname === "/v1/config/client";
  if (
    (!workspace && !context) ||
    /[%\\#\u0000-\u0020\u007f]/u.test(pathname) ||
    pathname.split("/").some((p) => p === "." || p === "..")
  ) {
    throw new SiteSessionPathError();
  }
  const rewritten = path.replace(
    "/workspaces/site-host",
    `/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  // Preview has no published Site identity. Never widen a Site-only list to the workspace.
  const url = new URL(rewritten, "http://site.invalid");
  if (url.searchParams.get("originSiteId") === "current" && workspaceId !== "site-host") {
    url.searchParams.set("originSiteId", siteId ?? "00000000-0000-0000-0000-000000000000");
    return url.pathname + url.search;
  }
  return rewritten;
}
