const SITE_WORKSPACE_PREFIX = "/v1/workspaces/site-host";
/** Site Data routes under any published Site: `<prefix>/published-artifacts/<id>/data|files`. */
const SITE_DATA_PATH =
  /^\/v1\/workspaces\/site-host\/published-artifacts\/([^/]+)\/(?:data|files)(?:\/|$)/u;

/** The header a host sets on every request it forwards from a Site frame. */
export const SITE_FRAME_HEADER = "x-opengeni-site-frame";

/** A Site/Codemode SDK request named a route outside the proxied surface. */
export class SiteSessionPathError extends Error {
  readonly code = "site_session_path_unsupported";

  constructor() {
    super("Unsupported Site session API path");
    this.name = "SiteSessionPathError";
  }
}

/** The host serves no Site Data: it is not bound to a published Site (inline HTML, previews). */
export class SiteDataUnsupportedError extends Error {
  readonly code = "site_data_unsupported";

  constructor() {
    super("This Site host does not provide Site Data");
    this.name = "SiteDataUnsupportedError";
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
  const data = SITE_DATA_PATH.exec(pathname);
  if (data) {
    // A Site reaches only its own data, as `current`; naming any Site id is refused for every host.
    if (data[1] !== "current") throw new SiteSessionPathError();
    // Inside the Site the alias stays unresolved; the host resolves it.
    if (workspaceId === "site-host") return path;
    // Only a host bound to a published Site serves its data.
    if (!siteId) throw new SiteDataUnsupportedError();
    return rewritten.replace(
      "/published-artifacts/current/",
      `/published-artifacts/${encodeURIComponent(siteId)}/`,
    );
  }
  // Preview has no published Site identity. Never widen a Site-only list to the workspace.
  const url = new URL(rewritten, "http://site.invalid");
  if (url.searchParams.get("originSiteId") === "current" && workspaceId !== "site-host") {
    url.searchParams.set("originSiteId", siteId ?? "00000000-0000-0000-0000-000000000000");
    return url.pathname + url.search;
  }
  return rewritten;
}

/** Preserve SDK request semantics while the host supplies identity and transport headers. */
export function siteRequestHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input);
  const connectionHeaders = (headers.get("connection") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    if (
      connectionHeaders.includes(name) ||
      /^(authorization|proxy-authorization|cookie|cookie2|host|origin|referer|connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade|content-length|accept-encoding|forwarded|x-api-key)$/i.test(
        name,
      ) ||
      /^(sec-|x-forwarded-|x-opengeni-(access-key|external-actor|site-|managed-actor))/i.test(name)
    )
      headers.delete(name);
  }
  return headers;
}
