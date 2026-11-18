/**
 * The web console running inside an Opengeni desktop app.
 *
 * A sign-in the console starts there finishes in the person's own browser
 * (providers refuse embedded app windows). The console marks its API requests
 * with this header so a flow that ends in that browser can hand the person
 * back to the app instead of leaving them on a web page. It only changes where
 * the person's own browser goes afterwards; it never grants or narrows access.
 */
export const OPENGENI_DESKTOP_APP_HEADER = "x-opengeni-desktop-app";

/** The console page that hands a finished browser flow back to the desktop app. */
export const DESKTOP_APP_RETURN_PATH = "/desktop-return";

/**
 * Where a flow started in the desktop app should send the browser when it
 * finishes: the console's hand-back page carrying the original destination.
 * Only a destination on the requesting console's own origin is wrapped;
 * anything else (an embedding product's page, a malformed origin) is returned
 * unchanged, as is a destination that is already the hand-back page.
 */
export function desktopAppReturnUrl(returnUrl: string, consoleOrigin: string | null): string {
  if (!consoleOrigin) return returnUrl;
  let target: URL;
  let origin: string;
  try {
    target = new URL(returnUrl);
    origin = new URL(consoleOrigin).origin;
  } catch {
    return returnUrl;
  }
  if (target.origin !== origin || target.pathname === DESKTOP_APP_RETURN_PATH) return returnUrl;
  const handBack = new URL(DESKTOP_APP_RETURN_PATH, origin);
  handBack.searchParams.set("url", returnUrl);
  return handBack.toString();
}

/**
 * The same hand-back for flows that name their destination as a console path
 * (`/workspaces/…`) and add their outcome parameters to it when they finish;
 * the hand-back page carries those parameters on to the destination. A path
 * that is not console-relative, or is already the hand-back page, is returned
 * unchanged.
 */
export function desktopAppReturnPath(returnPath: string): string {
  if (!returnPath.startsWith("/") || returnPath.startsWith("//")) return returnPath;
  const base = "https://console.invalid";
  if (new URL(returnPath, base).pathname === DESKTOP_APP_RETURN_PATH) return returnPath;
  return `${DESKTOP_APP_RETURN_PATH}?${new URLSearchParams({ url: returnPath }).toString()}`;
}

/**
 * The console page a sign-in started in the desktop app goes through when
 * the person's browser is not signed in to Opengeni. Such a sign-in may only
 * finish in a browser signed in as the person who started it, so instead of
 * failing, the browser signs in here first and then finishes it.
 */
export const OAUTH_SIGN_IN_TO_FINISH_PATH = "/connect-continue";

/**
 * The server steps a browser may resume after signing in: the OAuth
 * callbacks and the Nango connect page. Nothing else, so the page can't be
 * used to send someone elsewhere.
 */
export const OAUTH_SIGN_IN_TO_FINISH_STEPS = [
  "/v1/integrations/oauth/callback",
  "/v1/integrations/provider-oauth/callback",
  "/v1/integrations/nango/connect",
] as const;

/** The console path that signs the browser in and then resumes `step` (a full URL or a path). */
export function oauthSignInToFinishPath(step: string): string {
  const url = new URL(step, "https://console.invalid");
  return `${OAUTH_SIGN_IN_TO_FINISH_PATH}?${new URLSearchParams({ next: `${url.pathname}${url.search}` }).toString()}`;
}

/**
 * The step a `/connect-continue` page resumes, as a URL on `origin`, or null
 * when the link names anything but one of the allowed steps.
 */
export function oauthSignInToFinishTarget(search: string, origin: string): string | null {
  const raw = new URLSearchParams(search).get("next");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  let target: URL;
  try {
    target = new URL(raw, origin);
  } catch {
    return null;
  }
  if (target.origin !== new URL(origin).origin) return null;
  if (!(OAUTH_SIGN_IN_TO_FINISH_STEPS as readonly string[]).includes(target.pathname)) return null;
  return target.toString();
}
