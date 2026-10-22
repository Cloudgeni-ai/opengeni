// Opengeni web links that a native app (phone or desktop) can show itself, and
// the account each belongs to. Pure: no platform modules, so every app shares it.

/** A deployment address as typed: trimmed, https by default, no trailing slash. */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  const match = /^(https?):\/\/([a-z0-9.-]+(?::\d{1,5})?)(?:[/?#].*)?$/iu.exec(withScheme);
  return match ? `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}` : null;
}

/** The host a person recognizes, e.g. app.opengeni.ai. */
export function serverLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//iu, "");
}

/** The part of a signed-in app account that link routing reads. */
export interface AppLinkAccount {
  id: string;
  /** The deployment's web origin, e.g. https://app.opengeni.ai. */
  baseUrl: string;
  /** The workspace last used with this account. */
  workspaceId: string | null;
  /** Set when the deployment rejected the credential. */
  signedOut?: boolean;
}

/**
 * A web link the app can show itself: a conversation or a workspace on some
 * deployment. Everything else on the web (settings, organization, artifacts)
 * stays in the browser.
 */
export interface AppLink {
  /** The deployment's origin, normalized like a stored account's baseUrl. */
  origin: string;
  /** Absent for the web's workspace-less `/sessions/:id` links. */
  workspaceId: string | null;
  /** Absent for a link to the workspace itself. */
  sessionId: string | null;
  /** The session moment the link points at (`?at=`). */
  at: number | null;
  /** The web address the link came from, for the browser fallback. */
  webUrl: string;
}

/**
 * Where a product's web app shows workspaces, sessions and the inbox, so a
 * native app can read the product's links and open its pages. Each builder
 * returns a path on the deployment's origin (with any query it needs).
 * `OPENGENI_WEB_PATHS` describes Opengeni's own web app; a product whose web
 * app uses its own routes passes its own.
 */
export interface AppWebPaths {
  /** The page a workspace opens on, where a person starts a new session. */
  home(workspaceId: string): string;
  /** One session; `at` is the session moment to show (an event sequence). */
  session(workspaceId: string, sessionId: string, at?: number | null): string;
  /** The workspace's inbox. */
  inbox(workspaceId: string): string;
  /** The workspace's settings, or absent when the product has no such page. */
  settings?(workspaceId: string): string;
  /**
   * The workspace or session a page shows, read from its path and query
   * (`?a=b`, or "" for none), or null for any other page: those stay in the
   * browser and aren't reopened. A workspace-less session link has a null
   * `workspaceId`.
   */
  match(
    path: string,
    query: string,
  ): { workspaceId: string | null; sessionId: string | null; at?: number | null } | null;
}

const WEB_URL = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/iu;
const ID = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";
const SESSION_PATH = new RegExp(`^/workspaces/${ID}/sessions/${ID}/?$`, "u");
const WORKSPACE_PATH = new RegExp(`^/workspaces/${ID}(?:/sessions)?/?$`, "u");
const BARE_SESSION_PATH = new RegExp(`^/sessions/${ID}/?$`, "u");
const SCHEME = /^[a-z][a-z0-9+.-]*$/u;

/** The `at` query parameter: a positive event sequence, or null. */
export function sessionMoment(query: string): number | null {
  const raw = queryParam(query, "at");
  return raw && /^[1-9][0-9]{0,15}$/u.test(raw) ? Number(raw) : null;
}

/** Opengeni's own web app. */
export const OPENGENI_WEB_PATHS: AppWebPaths = {
  home: (workspaceId) => `/workspaces/${workspaceId}/sessions`,
  session: (workspaceId, sessionId, at) =>
    `/workspaces/${workspaceId}/sessions/${sessionId}${at ? `?at=${at}` : ""}`,
  inbox: (workspaceId) => `/workspaces/${workspaceId}/inbox`,
  settings: (workspaceId) => `/workspaces/${workspaceId}/settings`,
  match(path, query) {
    const session = SESSION_PATH.exec(path);
    if (session)
      return { workspaceId: session[1]!, sessionId: session[2]!, at: sessionMoment(query) };
    const bare = BARE_SESSION_PATH.exec(path);
    if (bare) return { workspaceId: null, sessionId: bare[1]!, at: sessionMoment(query) };
    const workspace = WORKSPACE_PATH.exec(path);
    if (workspace) return { workspaceId: workspace[1]!, sessionId: null, at: null };
    return null;
  },
};

/** How a product's app reads its links. Both default to Opengeni's own. */
export interface AppLinkOptions {
  /** The app's custom URL scheme, e.g. "opengeni" for `opengeni://open?url=…`. */
  scheme?: string;
  /** The product web app's pages. */
  paths?: AppWebPaths;
}

function appScheme(scheme: string | undefined): string {
  const value = scheme ?? "opengeni";
  if (!SCHEME.test(value)) throw new Error("Invalid app scheme");
  return value;
}

function queryParam(query: string | undefined, name: string): string | null {
  for (const part of (query ?? "").replace(/^\?/u, "").split("&")) {
    const [key, value = ""] = part.split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.replace(/\+/gu, " "));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The web link a raw URL points at, unwrapping the web's "Open in app" handoff
 * (`<scheme>://open?url=…`).
 */
export function parseAppLink(raw: string, options: AppLinkOptions = {}): AppLink | null {
  const trimmed = raw.trim();
  const handoffPrefix = `${appScheme(options.scheme)}://open`;
  let webUrl: string | null = trimmed;
  if (trimmed.slice(0, handoffPrefix.length).toLowerCase() === handoffPrefix) {
    const rest = /^\/?\?(.*)$/u.exec(trimmed.slice(handoffPrefix.length));
    if (!rest) return null;
    webUrl = queryParam(rest[1], "url");
  }
  if (!webUrl) return null;
  const match = WEB_URL.exec(webUrl);
  if (!match) return null;
  const origin = normalizeServerUrl(match[1]!);
  if (!origin) return null;
  const page = (options.paths ?? OPENGENI_WEB_PATHS).match(match[2] ?? "/", match[3] ?? "");
  if (!page || (!page.workspaceId && !page.sessionId)) return null;
  return {
    origin,
    workspaceId: page.workspaceId,
    sessionId: page.sessionId,
    at: page.sessionId ? (page.at ?? null) : null,
    webUrl,
  };
}

/**
 * The signed-in account a link belongs to, or null when the app has none on
 * that deployment (the browser opens it instead). With several accounts on the
 * same deployment: the one last used in the link's workspace, else the active
 * one, else the first.
 */
export function accountForAppLink<Account extends AppLinkAccount>(
  link: AppLink,
  accounts: readonly Account[],
  activeId: string | null,
): Account | null {
  const candidates = accounts.filter(
    (account) => !account.signedOut && normalizeServerUrl(account.baseUrl) === link.origin,
  );
  return (
    (link.workspaceId
      ? candidates.find((account) => account.workspaceId === link.workspaceId)
      : undefined) ??
    candidates.find((account) => account.id === activeId) ??
    candidates[0] ??
    null
  );
}

/** The web's handoff link that opens a web page in the app. */
export function appHandoffUrl(webUrl: string, scheme?: string): string {
  return `${appScheme(scheme)}://open?url=${encodeURIComponent(webUrl)}`;
}

/** A browser's requested destination, not permission to use the computer. */
export interface ComputerConnectLink extends AppLink {
  subjectId: string;
}

/** No credentials travel in this link. The app signs in and confirms locally. */
export function computerConnectUrl(input: {
  webUrl: string;
  subjectId: string;
  scheme?: string;
  /** The product web app's pages; `webUrl` must be a workspace or session page. */
  paths?: AppWebPaths;
}): string {
  const scheme = appScheme(input.scheme);
  const url = new URL(`${scheme}://connect`);
  url.searchParams.set("url", input.webUrl);
  url.searchParams.set("subject", input.subjectId);
  if (!parseComputerConnectLink(url.toString(), scheme, input.paths))
    throw new Error("Invalid computer destination");
  return url.toString();
}

export function parseComputerConnectLink(
  raw: string,
  scheme = "opengeni",
  paths?: AppWebPaths,
): ComputerConnectLink | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== `${scheme}:` ||
      url.host !== "connect" ||
      !["", "/"].includes(url.pathname)
    )
      return null;
    const subjectId = url.searchParams.get("subject");
    const target = new URL(url.searchParams.get("url") ?? "");
    // Handoffs carry a destination only, never arbitrary queries, fragments or credentials.
    if (target.username || target.password || target.search || target.hash) return null;
    if (!["https:", "http:"].includes(target.protocol)) return null;
    const link = parseAppLink(target.toString(), { scheme, ...(paths ? { paths } : {}) });
    if (
      !link?.workspaceId ||
      !subjectId ||
      subjectId.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(subjectId)
    )
      return null;
    return { ...link, subjectId };
  } catch {
    return null;
  }
}
