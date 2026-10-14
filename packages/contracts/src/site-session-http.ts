import { matchSiteOperation, type SiteOperation } from "./site-operations";

const SITE_WORKSPACE_PREFIX = "/v1/workspaces/site-host";
/** Site Data and Site SQL routes under any published Site: `<prefix>/published-artifacts/<id>/data|files|sql`. */
const SITE_DATA_PATH =
  /^\/v1\/workspaces\/site-host\/published-artifacts\/([^/]+)\/(?:data|files|sql)(?:\/|$)/u;
/** The list filter a frame without a published Site gets: it names no Site, so lists nothing. */
export const SITE_NO_ORIGIN_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The header a host sets on every request it forwards from a Site frame. The
 * value names the host: `1` for the console bridge, `preview` for a Codemode
 * local preview. The API treats a request carrying it (or the pinned Site id)
 * as Site code: only `SITE_OPERATIONS`, only the frame's own sessions.
 */
export const SITE_FRAME_HEADER = "x-opengeni-site-frame";
/** SITE_FRAME_HEADER value a Codemode local preview sets. */
export const SITE_PREVIEW_FRAME = "preview";
/**
 * A random id the host mints per mounted frame. A frame without a published
 * Site (inline HTML, previews) records it on the sessions it starts and may
 * reach only those sessions afterwards.
 */
export const SITE_FRAME_ID_HEADER = "x-opengeni-site-frame-id";
/** The published Site (artifact id) a host pinned the frame to. */
export const SITE_ID_HEADER = "x-opengeni-site-id";
/** The exact Site version the pinned frame runs. */
export const SITE_VERSION_HEADER = "x-opengeni-site-version";

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

function unsafePathname(pathname: string): boolean {
  return (
    /[%\\#\u0000-\u0020\u007f]/u.test(pathname) ||
    pathname.split("/").some((part) => part === "." || part === "..")
  );
}

function hostWorkspacePath(path: string, workspaceId: string): string {
  return path.replace("/workspaces/site-host", `/workspaces/${encodeURIComponent(workspaceId)}`);
}

/** Site Data: a Site reaches only its own data, as `current`, through a host bound to a published Site. */
function siteDataPath(path: string, rewritten: string, workspaceId: string, siteId?: string) {
  // Inside the Site the alias stays unresolved; the host resolves it.
  if (workspaceId === "site-host") return path;
  // Only a host bound to a published Site serves its data.
  if (!siteId) throw new SiteDataUnsupportedError();
  return rewritten.replace(
    "/published-artifacts/current/",
    `/published-artifacts/${encodeURIComponent(siteId)}/`,
  );
}

/**
 * Route a request from Site code (the in-Site SDK, the console bridge, a
 * Codemode preview) to the host workspace. This is the `SITE_OPERATIONS`
 * allowlist: anything else is refused with SiteSessionPathError before any
 * request is made. Ordinary API handlers still authorize every allowed
 * operation with the viewer's own authority, and the API independently
 * refuses frame requests outside the allowlist or to another Site's sessions.
 *
 * `workspaceId` `site-host` checks a path inside the Site without rewriting
 * it. A session list must name `originSiteId=current`; the host binds it to
 * its pinned Site, or to no Site at all when the frame has none.
 */
export function siteSessionPath(
  path: string,
  workspaceId: string,
  method = "GET",
  siteId?: string,
): string {
  const pathname = path.split("?")[0]!;
  const match = matchSiteOperation(method, pathname);
  if (!match) throw new SiteSessionPathError();
  const rewritten = hostWorkspacePath(path, workspaceId);
  if (SITE_DATA_PATH.test(pathname)) return siteDataPath(path, rewritten, workspaceId, siteId);
  if (match.operation.id !== "sessions.list") return rewritten;
  // A Site lists only its own conversations. Never widen a Site list to the workspace.
  const url = new URL(rewritten, "http://site.invalid");
  const origins = url.searchParams.getAll("originSiteId");
  if (origins.length !== 1 || origins[0] !== "current") throw new SiteSessionPathError();
  if (workspaceId === "site-host") return path;
  url.searchParams.set("originSiteId", siteId ?? SITE_NO_ORIGIN_ID);
  return url.pathname + url.search;
}

/**
 * Route an agent's own SDK request through the Codemode SDK proxy to its
 * workspace. Unlike `siteSessionPath` this is a URL prefix boundary, not an
 * operation allowlist: the proxy signs a short-lived credential bounded by
 * the agent's own permission ceiling and ordinary handlers authorize every
 * operation. Site Data is not served here (an agent uses its tools).
 * Requests a Codemode preview forwards from Site code carry the frame marker
 * and use `siteSessionPath` instead.
 */
export function siteHostWorkspacePath(path: string, workspaceId: string): string {
  const pathname = path.split("?")[0]!;
  const workspace =
    pathname === SITE_WORKSPACE_PREFIX || pathname.startsWith(`${SITE_WORKSPACE_PREFIX}/`);
  if ((!workspace && pathname !== "/v1/config/client") || unsafePathname(pathname))
    throw new SiteSessionPathError();
  const rewritten = hostWorkspacePath(path, workspaceId);
  const data = SITE_DATA_PATH.exec(pathname);
  if (data) {
    if (data[1] !== "current") throw new SiteSessionPathError();
    return siteDataPath(path, rewritten, workspaceId);
  }
  const url = new URL(rewritten, "http://site.invalid");
  if (url.searchParams.get("originSiteId") === "current" && workspaceId !== "site-host") {
    url.searchParams.set("originSiteId", SITE_NO_ORIGIN_ID);
    return url.pathname + url.search;
  }
  return rewritten;
}

/** The Site identity a host attached to a request, from its host-set headers. */
export type SiteFrameHeaders = {
  /** The pinned published Site id, or null for a frame without one. */
  siteId: string | null;
  versionId: string | null;
  /** The host's frame marker value (`1`, `preview`), or null when only the Site id was set. */
  marker: string | null;
  frameId: string | null;
};

/** Read the host-set frame headers. Null when the request did not come from a Site frame. */
export function siteFrameFromHeaders(
  header: (name: string) => string | null | undefined,
): SiteFrameHeaders | null {
  const value = (name: string) => header(name) ?? null;
  const marker = value(SITE_FRAME_HEADER);
  const siteId = value(SITE_ID_HEADER);
  const versionId = value(SITE_VERSION_HEADER);
  const frameId = value(SITE_FRAME_ID_HEADER);
  if (marker === null && siteId === null && versionId === null && frameId === null) return null;
  return { siteId: siteId || null, versionId: versionId || null, marker, frameId: frameId || null };
}

/**
 * Match a request that reached a workspace route from a Site frame against
 * `SITE_OPERATIONS`. `pathname` is the raw request path
 * (`/v1/workspaces/<id>/...` or `/v1/config/client`). The frame's own pinned
 * Site id maps back to `current`; any other Site id does not match.
 */
export function siteFrameOperation(
  method: string,
  pathname: string,
  workspaceId: string,
  frameSiteId: string | null,
): { operation: SiteOperation; suffix: string; sessionId: string | null } | null {
  if (unsafePathname(pathname)) return null;
  let sitePath = pathname;
  if (pathname !== "/v1/config/client") {
    const prefix = `/v1/workspaces/${workspaceId}`;
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
    sitePath = `${SITE_WORKSPACE_PREFIX}${pathname.slice(prefix.length)}`;
    const data = /^\/v1\/workspaces\/site-host\/published-artifacts\/([^/]+)\//u.exec(sitePath);
    if (data) {
      if (!frameSiteId || data[1] !== frameSiteId) return null;
      sitePath = sitePath.replace(
        `/published-artifacts/${frameSiteId}/`,
        "/published-artifacts/current/",
      );
    }
  }
  const match = matchSiteOperation(method, sitePath);
  if (!match) return null;
  const session = /^\/sessions\/([^/]+)(?:\/|$)/u.exec(match.suffix);
  return { ...match, sessionId: session ? session[1]! : null };
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

// ---------------------------------------------------------------------------
// What a Site frame may put in a request body
// ---------------------------------------------------------------------------

/** Message fields a Site page may set: the text and how the model answers it. */
const SITE_FRAME_MESSAGE_FIELDS = [
  "text",
  "annotations",
  "model",
  "reasoningEffort",
  "latencyMode",
  "controlEtag",
  "expectedDraftRevision",
] as const;

/**
 * Body fields a Site frame may send per operation. Anything else with a
 * value (resources, personal resource attachments, MCP credential updates,
 * connection accounts, model context, approval decisions, human-input
 * answers) is the person's to give in the console, never a Site page's.
 */
const SITE_FRAME_BODY_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "sessions.send": ["type", "payload", "clientEventId"],
  "sessions.steer": [...SITE_FRAME_MESSAGE_FIELDS, "clientEventId"],
  "sessions.control": ["action", "reason", "clientEventId", "expectedControlEtag"],
  "sessions.composerDraft.put": [
    "text",
    "annotations",
    "resources",
    "model",
    "reasoningEffort",
    "latencyMode",
    "expectedRevision",
  ],
  "sessions.composerDraft.submit": [
    ...SITE_FRAME_MESSAGE_FIELDS,
    "resources",
    "connectionAccounts",
    "clientEventId",
    "delivery",
  ],
  "sessions.queue.move": ["clientEventId", "expectedQueueVersion", "beforeTurnId"],
  "sessions.queue.edit": [
    "clientEventId",
    "expectedTurnVersion",
    "expectedDraftRevision",
    "replaceDraft",
  ],
  "sessions.queue.steer": ["clientEventId", "expectedTurnVersion", "controlEtag"],
  "sessions.queue.delete": ["clientEventId", "expectedTurnVersion", "reason"],
});

/** Fields allowed above only while empty: a draft carries no resources or accounts. */
const SITE_FRAME_EMPTY_ONLY_FIELDS = new Set(["resources", "connectionAccounts"]);

/**
 * Session create fields a Site frame may send. The API starts the session
 * with a minimal Site profile: no tools, servers, connections, permissions,
 * vaults, sandbox or environment choice, resources, Skills, agent overrides,
 * hidden model context, learning overrides, goals, channels, visibility,
 * usage limits or nesting. Metadata keeps only keys outside `_opengeni`.
 */
export const SITE_FRAME_SESSION_CREATE_FIELDS: readonly string[] = Object.freeze([
  "initialMessage",
  "requestedSessionId",
  "idempotencyKey",
  "clientEventId",
  "model",
  "reasoningEffort",
  "latencyMode",
  "startMode",
  "metadata",
]);

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Absent, null, an empty list or an empty object asks for nothing. */
function emptyBodyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function refusedField(
  body: Record<string, unknown>,
  allowed: readonly string[],
  prefix = "",
): string | null {
  for (const [name, value] of Object.entries(body)) {
    if (emptyBodyValue(value)) continue;
    if (!allowed.includes(name) || SITE_FRAME_EMPTY_ONLY_FIELDS.has(name))
      return `${prefix}${name}`;
  }
  return null;
}

/**
 * The first body field a Site frame may not send for this operation (for
 * example `payload.resources` or `type`), or null when the body is allowed.
 * `suffix` is the operation's site-host suffix (from `siteFrameOperation` or
 * `matchSiteOperation`). A body that is not a JSON object is left to the
 * route, which refuses it. Only `user.message` events are allowed:
 * approvals and answers to questions happen in the console.
 */
export function siteFrameBodyRefusal(
  operationId: string,
  suffix: string,
  body: unknown,
): string | null {
  const record = bodyRecord(body);
  if (!record) return null;
  if (operationId === "sessions.create")
    return refusedField(record, SITE_FRAME_SESSION_CREATE_FIELDS);
  const action =
    operationId === "sessions.queue.item"
      ? /\/queue\/[^/]+\/(move|edit|steer|delete)$/u.exec(suffix)?.[1]
      : undefined;
  const key = action ? `sessions.queue.${action}` : operationId;
  const allowed = SITE_FRAME_BODY_FIELDS[key];
  if (!allowed) return null;
  const refused = refusedField(record, allowed);
  if (refused) return refused;
  if (operationId !== "sessions.send") return null;
  if (record.type !== "user.message") return "type";
  const payload = bodyRecord(record.payload);
  return payload ? refusedField(payload, SITE_FRAME_MESSAGE_FIELDS, "payload.") : null;
}
