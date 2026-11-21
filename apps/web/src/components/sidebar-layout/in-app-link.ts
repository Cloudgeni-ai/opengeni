/**
 * A sidebar link to a page of this Opengeni (an agent, a chat, a setting) as
 * an in-app path, so it opens in place; null for an outside link, which opens
 * in a new tab. A same-origin path the app has no page for (a download, a
 * sign-in start) is outside too, so it still loads from the server.
 */
export function inAppLinkPath(
  url: string,
  origin: string,
  hasPage: (pathname: string) => boolean,
): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin || !hasPage(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
