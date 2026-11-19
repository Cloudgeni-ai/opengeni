/**
 * Opengeni Console's sign-in handoff: a person signed out on a Console host
 * (console.opengeni.ai, staging.console.opengeni.ai) signs in with the app
 * host's sign-in, and the app hands Console a one-time code it redeems for its
 * own host-only session. Dependency-free so the web app's boot path and the
 * API share one definition of a Console host and of a safe return path.
 */

/** The API routes. `start` and `callback` run on the Console host, `authorize` on the app host. */
export const CONSOLE_SIGN_IN_API_PATH = "/v1/console-sign-in";

/** The app host's web page that signs the person in and hands them back to Console. */
export const CONSOLE_SIGN_IN_APP_PATH = "/console-sign-in";

/** Console's own pages, where a handoff may return to. */
export const CONSOLE_SIGN_IN_DEFAULT_RETURN = "/console";

/**
 * The query parameter a Console page carries when a handoff didn't sign the
 * person in: `failed` (expired, reused or another browser's code, or the
 * account may not sign in) or `unavailable` (this deployment can't hand off).
 * Console then shows its signed-out page instead of starting another handoff.
 */
export const CONSOLE_SIGN_IN_OUTCOME_PARAM = "console_sign_in";
export type ConsoleSignInOutcome = "failed" | "unavailable";

/** Longest return path accepted, in characters. */
export const CONSOLE_SIGN_IN_RETURN_MAX_LENGTH = 2_048;

/**
 * Console's own hosts: a host whose first or second label is `console`
 * (console.opengeni.ai, staging.console.opengeni.ai), never consolex.* or app.*.
 */
export function isConsoleHostname(hostname: string): boolean {
  const labels = hostname.toLowerCase().replace(/\.$/u, "").split(".");
  return (
    (labels.length >= 2 && labels[0] === "console") ||
    (labels.length >= 3 && labels[1] === "console")
  );
}

const RETURN_BASE = "https://console-return.invalid";

/**
 * The Console page a handoff returns to: a relative `/console` path with its
 * query (so `?org=` and the page's own state survive), never another origin,
 * a protocol-relative or backslash path, a fragment, or a path outside
 * Console. Anything else returns Console's Overview.
 */
export function consoleSignInReturnPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  if (raw.length > CONSOLE_SIGN_IN_RETURN_MAX_LENGTH) return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  // Only an absolute path, and nothing a URL parser might read as a host.
  if (!raw.startsWith("/") || raw.startsWith("//")) return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  // oxlint-disable-next-line no-control-regex -- control characters are refused on purpose
  if (/[\\\u0000-\u001f\u007f]/u.test(raw)) return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  let url: URL;
  try {
    url = new URL(raw, RETURN_BASE);
  } catch {
    return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  }
  if (url.origin !== RETURN_BASE) return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  const { pathname } = url;
  if (
    pathname !== CONSOLE_SIGN_IN_DEFAULT_RETURN &&
    !pathname.startsWith(`${CONSOLE_SIGN_IN_DEFAULT_RETURN}/`)
  ) {
    return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  }
  if (pathname.includes("//")) return CONSOLE_SIGN_IN_DEFAULT_RETURN;
  url.searchParams.delete(CONSOLE_SIGN_IN_OUTCOME_PARAM);
  const search = url.searchParams.toString();
  return search ? `${pathname}?${search}` : pathname;
}
