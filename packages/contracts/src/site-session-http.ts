/** The shared browser/preview session SDK surface. Tenant routing stays with
 * the host; normal API handlers remain the authorization boundary. */
export function siteSessionPath(
  path: string,
  workspaceId: string,
  method = "GET",
  siteId?: string,
): string {
  const session =
    /^\/v1\/workspaces\/site-host\/(?:sessions(?:[/?]|$)|new-session-draft(?:[?]|$))/u.test(path);
  const context =
    method === "GET" &&
    (path === "/v1/config/client" ||
      /^\/v1\/workspaces\/site-host(?:[?].*|$|\/(?:model-catalog|live-events\/stream|control-events(?:\/stream)?|interaction-events\/stream)(?:[?].*|$))/u.test(
        path,
      ));
  if (
    (!session && !context) ||
    /[%\\#]/u.test(path.split("?")[0]!) ||
    path
      .split("?")[0]!
      .split("/")
      .some((p) => p === "." || p === "..")
  ) {
    throw new Error("Unsupported Site session API path");
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
