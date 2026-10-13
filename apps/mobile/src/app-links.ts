import type { StoredAccount } from "./account-store";
import { normalizeServerUrl } from "./server-url";

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
export function accountForAppLink(
  link: AppLink,
  accounts: readonly StoredAccount[],
  activeId: string | null,
): StoredAccount | null {
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

/** The app route for a session, in its own workspace so the screen below keeps its own. */
export function appSessionPath(sessionId: string, workspaceId: string, at: number | null): string {
  const query = [`workspace=${encodeURIComponent(workspaceId)}`];
  if (at) query.push(`at=${at}`);
  return `/session/${encodeURIComponent(sessionId)}?${query.join("&")}`;
}

/** The web's handoff link that opens a web page in the app. */
export function appHandoffUrl(webUrl: string): string {
  return `opengeni://open?url=${encodeURIComponent(webUrl)}`;
}
