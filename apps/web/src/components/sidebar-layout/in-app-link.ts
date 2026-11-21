/**
 * A sidebar link to a page of this Opengeni (an agent, a chat, a setting) as
 * an in-app path, so it opens in place; null for an outside link, which opens
 * in a new tab.
 */
export function inAppLinkPath(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
  } catch {
    return null;
  }
}
