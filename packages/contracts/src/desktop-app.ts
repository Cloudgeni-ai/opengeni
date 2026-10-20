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
