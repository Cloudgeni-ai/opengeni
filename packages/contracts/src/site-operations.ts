// Zod-free on purpose: browser bundles (the Site runtime, the console Site
// bridge and the gateway shell) import this module, and must not pull in zod.

// ---------------------------------------------------------------------------
// Site operation allowlist
// ---------------------------------------------------------------------------

/**
 * Every HTTP operation Site code may perform through a host, as an explicit
 * allowlist (method + exact path shape) rather than a URL prefix. Paths are
 * the suffix after `/v1/workspaces/site-host` that the in-Site SDK client
 * uses; `/v1/config/client` is the one path outside that prefix.
 *
 * The console host forwards an allowed operation to the ordinary workspace
 * route with Site provenance. The gateway forwards it to `/_og/api<suffix>`
 * and the API serves it at `/v1/site-runtime<suffix>`. `agent: true` marks
 * operations that start or message an agent; every such route records which
 * Site (and version) originated it.
 */
export type SiteOperationMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type SiteOperation = {
  id: string;
  method: SiteOperationMethod;
  /** Anchored pattern on the site-host suffix (`""` is the workspace itself). */
  pattern: RegExp;
  agent?: true;
  stream?: true;
};

const ID = "[A-Za-z0-9_-]{1,128}";
const DATA = "/published-artifacts/current/(?:data|files)(?:/[A-Za-z0-9._~:@!$&'()*+,;=-]+)*";

export const SITE_OPERATIONS: readonly SiteOperation[] = Object.freeze([
  { id: "config.client", method: "GET", pattern: /^\/v1\/config\/client$/u },
  { id: "workspace.get", method: "GET", pattern: /^$/u },
  { id: "site.config", method: "GET", pattern: /^\/site\/config$/u },
  { id: "models.list", method: "GET", pattern: /^\/model-catalog$/u },
  { id: "sessions.list", method: "GET", pattern: /^\/sessions$/u },
  { id: "sessions.create", method: "POST", pattern: /^\/sessions$/u, agent: true },
  { id: "sessions.get", method: "GET", pattern: new RegExp(`^/sessions/${ID}$`, "u") },
  { id: "sessions.events", method: "GET", pattern: new RegExp(`^/sessions/${ID}/events$`, "u") },
  {
    id: "sessions.stream",
    method: "GET",
    pattern: new RegExp(`^/sessions/${ID}/events/stream$`, "u"),
    stream: true,
  },
  {
    id: "sessions.send",
    method: "POST",
    pattern: new RegExp(`^/sessions/${ID}/events$`, "u"),
    agent: true,
  },
  {
    id: "sessions.steer",
    method: "POST",
    pattern: new RegExp(`^/sessions/${ID}/steer$`, "u"),
    agent: true,
  },
  {
    id: "sessions.control",
    method: "POST",
    pattern: new RegExp(`^/sessions/${ID}/control$`, "u"),
    agent: true,
  },
  { id: "sessions.queue", method: "GET", pattern: new RegExp(`^/sessions/${ID}/queue$`, "u") },
  // SessionConversation's documented queue edit/delete/steer/move.
  {
    id: "sessions.queue.item",
    method: "POST",
    pattern: new RegExp(`^/sessions/${ID}/queue/${ID}/(?:move|edit|steer|delete)$`, "u"),
    agent: true,
  },
  // SessionConversation's durable composer draft and its Send.
  {
    id: "sessions.composerDraft.get",
    method: "GET",
    pattern: new RegExp(`^/sessions/${ID}/composer-draft$`, "u"),
  },
  {
    id: "sessions.composerDraft.put",
    method: "PUT",
    pattern: new RegExp(`^/sessions/${ID}/composer-draft$`, "u"),
  },
  {
    id: "sessions.composerDraft.submit",
    method: "POST",
    pattern: new RegExp(`^/sessions/${ID}/composer-draft/submit$`, "u"),
    agent: true,
  },
  {
    id: "sessions.humanInput",
    method: "GET",
    pattern: new RegExp(`^/sessions/${ID}/human-input-requests$`, "u"),
  },
  // SessionConversation's human-input form reads the one open request.
  {
    id: "sessions.humanInput.get",
    method: "GET",
    pattern: new RegExp(`^/sessions/${ID}/human-input-requests/${ID}$`, "u"),
  },
  { id: "data.read", method: "GET", pattern: new RegExp(`^${DATA}$`, "u") },
  { id: "data.write", method: "POST", pattern: new RegExp(`^${DATA}$`, "u") },
  { id: "data.put", method: "PUT", pattern: new RegExp(`^${DATA}$`, "u") },
  { id: "data.patch", method: "PATCH", pattern: new RegExp(`^${DATA}$`, "u") },
  { id: "data.delete", method: "DELETE", pattern: new RegExp(`^${DATA}$`, "u") },
  // Site SQL (PR B): run one named query the owner defined; never raw SQL.
  {
    id: "sql.run",
    method: "POST",
    pattern: /^\/published-artifacts\/current\/sql\/queries\/[A-Za-z][A-Za-z0-9_-]{0,63}$/u,
  },
  { id: "site.report", method: "POST", pattern: /^\/site\/reports$/u },
] satisfies SiteOperation[]);

/**
 * Tool bridge methods (MessagePort, not HTTP). The gateway serves them at
 * POST /_og/api/tools/<method>; the console uses its tool gateway client.
 */
export const SITE_TOOL_METHODS = Object.freeze([
  "catalog",
  "declarations",
  "call",
  "resolve",
  "invoke",
] as const);
export type SiteToolMethod = (typeof SITE_TOOL_METHODS)[number];

const SITE_HOST_PREFIX = "/v1/workspaces/site-host";

/**
 * Match a Site-originated request against the allowlist. `path` is the
 * pathname the in-Site SDK used (`/v1/workspaces/site-host/...` or
 * `/v1/config/client`), without query. Returns the operation and the
 * site-host suffix, or null when the operation is not allowed. Refuses
 * encoded separators, dot segments and control characters.
 */
export function matchSiteOperation(
  method: string,
  path: string,
): { operation: SiteOperation; suffix: string } | null {
  if (/[%\\#\u0000-\u0020\u007f]/u.test(path)) return null;
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  const upper = method.toUpperCase();
  let suffix: string;
  if (path === "/v1/config/client") suffix = path;
  else if (path === SITE_HOST_PREFIX) suffix = "";
  else if (path.startsWith(`${SITE_HOST_PREFIX}/`)) suffix = path.slice(SITE_HOST_PREFIX.length);
  else return null;
  const operation = SITE_OPERATIONS.find(
    (candidate) => candidate.method === upper && candidate.pattern.test(suffix),
  );
  return operation ? { operation, suffix } : null;
}
