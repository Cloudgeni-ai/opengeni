import { isSidebarAppPath } from "@opengeni/contracts/sidebar-layout";

const ATTRIBUTE = /\b(?:href|data-route|data-page)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
const ASSET = /\.(?:css|js|mjs|json|png|jpe?g|gif|svg|webp|ico|pdf|zip|csv|txt|xml|woff2?)$/iu;
const MAX_PAGES = 30;

/**
 * The pages an app's HTML points at, as sidebar paths: its own links and
 * declared routes (`href`, `data-route`, `data-page`), without outside
 * addresses, anchors or files. Best effort; anything else can still be typed.
 */
export function appPagePaths(html: string): string[] {
  const pages = new Set<string>();
  for (const match of html.matchAll(ATTRIBUTE)) {
    const path = toPagePath((match[1] ?? match[2] ?? "").trim());
    if (path && path !== "/") pages.add(path);
    if (pages.size >= MAX_PAGES) break;
  }
  return [...pages].sort((a, b) => a.localeCompare(b));
}

function toPagePath(raw: string): string | null {
  if (!raw || /^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith("//")) return null;
  // A hash route stays one, opened from the app's home: "#/board" is "/#/board".
  if (raw.startsWith("#/")) return isSidebarAppPath(`/${raw}`) ? `/${raw}` : null;
  let value = raw;
  if (value.startsWith("#") || value.startsWith("?")) return null;
  if (value.startsWith("./")) value = value.slice(1);
  else if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/[?#].*$/u, "").replace(/\/index\.html?$/iu, "/");
  if (ASSET.test(value) || value.startsWith("/..")) return null;
  return isSidebarAppPath(value) ? value : null;
}

/** A typed page as a sidebar path ("releases" becomes "/releases"), or null. */
export function typedPagePath(query: string): string | null {
  const value = query.trim();
  if (!value) return null;
  const path = value.startsWith("/") ? value : `/${value}`;
  return isSidebarAppPath(path) ? path : null;
}
