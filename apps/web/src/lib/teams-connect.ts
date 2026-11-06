import { apiErrorDetailCode, serverRefusalText, userErrorText } from "@opengeni/react/ui/api-error";

/** Fragment tokens stay out of route searches and are removed only after a confirmed action. */
export function teamsFragmentToken(
  hash: string,
  kind: "teams_setup" | "teams_link",
): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const values = params.getAll(kind);
  const token = values.length === 1 ? values[0] : null;
  return token && token.length <= 16_384 && !/\s/.test(token) ? token : null;
}

export function teamsAuthReturnPath(
  location: Pick<Location, "pathname" | "search" | "hash">,
): string | null {
  if (location.pathname === "/teams/connect") {
    return `${location.pathname}${location.search}${location.hash}`;
  }
  if (
    /^\/workspaces\/[^/]+\/plugins\/?$/.test(location.pathname) &&
    teamsFragmentToken(location.hash, "teams_link")
  ) {
    return `${location.pathname}${location.search}${location.hash}`;
  }
  return null;
}

export function clearTeamsFragment(kind: "teams_setup" | "teams_link") {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  params.delete(kind);
  url.hash = params.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

const PENDING_SETUP_KEY = "opengeni.teams-setup";
const PENDING_SETUP_MAX_AGE_MS = 15 * 60_000;
const MICROSOFT_RETURN_PARAMS = [
  "code",
  "state",
  "session_state",
  "error",
  "error_description",
  "error_uri",
];

export type TeamsPendingSetup = { setupToken: string; workspaceId: string; replaceOwnLink?: true };
export type TeamsMicrosoftReturn =
  | { kind: "signed_in"; code: string; state: string }
  | { kind: "failed"; error: string; description: string };

/**
 * The setup proof and chosen workspace survive the Microsoft sign-in in this
 * tab's session storage, never in the URL Microsoft sees.
 */
export function savePendingTeamsSetup(
  pending: TeamsPendingSetup,
  storage: Pick<Storage, "setItem"> = window.sessionStorage,
  now = Date.now(),
): void {
  storage.setItem(PENDING_SETUP_KEY, JSON.stringify({ ...pending, savedAt: now }));
}

export function clearPendingTeamsSetup(
  storage: Pick<Storage, "removeItem"> = window.sessionStorage,
): void {
  storage.removeItem(PENDING_SETUP_KEY);
}

/** Reads the pending setup; stale or malformed entries read as none. */
export function readPendingTeamsSetup(
  storage: Pick<Storage, "getItem"> = window.sessionStorage,
  now = Date.now(),
): TeamsPendingSetup | null {
  const raw = storage.getItem(PENDING_SETUP_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TeamsPendingSetup & { savedAt: number }>;
    if (
      typeof value.setupToken !== "string" ||
      !value.setupToken ||
      value.setupToken.length > 16_384 ||
      typeof value.workspaceId !== "string" ||
      !value.workspaceId ||
      typeof value.savedAt !== "number" ||
      now - value.savedAt > PENDING_SETUP_MAX_AGE_MS ||
      value.savedAt > now
    )
      return null;
    return {
      setupToken: value.setupToken,
      workspaceId: value.workspaceId,
      ...(value.replaceOwnLink === true ? { replaceOwnLink: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** Microsoft's answer on the setup page: a code and state, or an error. */
export function teamsMicrosoftReturn(search: string): TeamsMicrosoftReturn | null {
  const params = new URLSearchParams(search);
  const single = (name: string) => {
    const values = params.getAll(name);
    return values.length === 1 && values[0] && values[0].length <= 8192 ? values[0] : null;
  };
  const error = single("error");
  if (error) return { kind: "failed", error, description: single("error_description") ?? "" };
  const code = single("code");
  const state = single("state");
  return code && state ? { kind: "signed_in", code, state } : null;
}

export function clearTeamsMicrosoftReturn() {
  const url = new URL(window.location.href);
  for (const name of MICROSOFT_RETURN_PARAMS) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** A person-facing reason for a Microsoft sign-in that returned without a code. */
export function teamsMicrosoftFailureText(failure: { error: string; description: string }) {
  if (
    failure.error === "consent_required" ||
    /AADSTS(65001|90093|90094|90095)\b/.test(failure.description)
  )
    return "Your organization needs a Global Administrator to approve Opengeni before you can sign in. Ask a Global Administrator to connect Opengeni, then try again.";
  return "Microsoft sign-in didn't finish. Try again.";
}
/**
 * True only when the API has no such route (an API older than self-serve
 * setup), not when the route exists and refused the request.
 */
export function teamsRouteMissing(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown; body?: unknown } | null;
  if (e?.status !== 404 || e.code !== "not_found" || typeof e.body !== "string") return false;
  try {
    const body = JSON.parse(e.body) as { error?: { message?: unknown } } | null;
    return body?.error?.message === "Resource not found.";
  } catch {
    return false;
  }
}

/**
 * `details.code` the API sets on a Teams setup or account-link refusal. Its
 * message says what happened and what to do next, so the page shows it as is.
 */
export const TEAMS_CONNECTION_REFUSED_CODE = "teams_connection_refused";

/** A failed Teams setup or link: the API's own refusal, or `userErrorText`. */
export function teamsErrorText(error: unknown, fallback: string): string {
  return (
    serverRefusalText(error, [TEAMS_CONNECTION_REFUSED_CODE]) ?? userErrorText(error, fallback)
  );
}

/**
 * True when setup was refused because the signed-in Opengeni account is
 * already linked to a different Teams account in the chosen workspace. Its
 * owner can unlink it and connect again.
 */
export function teamsOwnAccountLinkedElsewhere(error: unknown): boolean {
  if (apiErrorDetailCode(error) !== TEAMS_CONNECTION_REFUSED_CODE) return false;
  const details = (error as { details?: { reason?: unknown } }).details;
  return details?.reason === "opengeni_account_linked";
}
