/** The shared browser/preview session SDK surface. Tenant routing stays with
 * the host; normal API handlers remain the authorization boundary. */
export function siteSessionPath(path: string, workspaceId: string, method = "GET"): string {
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
  return path.replace("/workspaces/site-host", `/workspaces/${encodeURIComponent(workspaceId)}`);
}
