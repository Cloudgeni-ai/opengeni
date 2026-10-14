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

/** The app's own scheme for links handed over from the web: opengeni://open?url=… */
const HANDOFF = /^opengeni:\/\/open\/?\?(.*)$/iu;
const WEB_URL = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/iu;
const ID = "([A-Za-z0-9][A-Za-z0-9_-]{0,127})";
const SESSION_PATH = new RegExp(`^/workspaces/${ID}/sessions/${ID}/?$`, "u");
const WORKSPACE_PATH = new RegExp(`^/workspaces/${ID}(?:/sessions)?/?$`, "u");
const BARE_SESSION_PATH = new RegExp(`^/sessions/${ID}/?$`, "u");

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

/** The web link a raw URL points at, unwrapping the web's "Open in app" handoff. */
export function parseAppLink(raw: string): AppLink | null {
  const trimmed = raw.trim();
  const handoff = HANDOFF.exec(trimmed);
  const webUrl = handoff ? queryParam(handoff[1], "url") : trimmed;
  if (!webUrl) return null;
  const match = WEB_URL.exec(webUrl);
  if (!match) return null;
  const origin = normalizeServerUrl(match[1]!);
  if (!origin) return null;
  const path = match[2] ?? "/";
  const atRaw = queryParam(match[3], "at");
  const at = atRaw && /^[1-9][0-9]{0,15}$/u.test(atRaw) ? Number(atRaw) : null;
  const session = SESSION_PATH.exec(path);
  if (session) return { origin, workspaceId: session[1]!, sessionId: session[2]!, at, webUrl };
  const bare = BARE_SESSION_PATH.exec(path);
  if (bare) return { origin, workspaceId: null, sessionId: bare[1]!, at, webUrl };
  const workspace = WORKSPACE_PATH.exec(path);
  if (workspace) return { origin, workspaceId: workspace[1]!, sessionId: null, at: null, webUrl };
  return null;
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
export function appHandoffUrl(webUrl: string): string {
  return `opengeni://open?url=${encodeURIComponent(webUrl)}`;
}
