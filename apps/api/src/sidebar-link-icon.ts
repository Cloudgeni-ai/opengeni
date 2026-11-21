// The site icon of an outside sidebar link (docs/sidebar-layout.md), for
// links without an icon of their own. The console never loads images from
// other sites (its CSP allows only its own), so the API fetches the site's
// /favicon.ico on the person's behalf, through the outbound policy that
// refuses private and special-use addresses, and keeps it for a day.
import {
  pinnedFetch,
  readResponseBodyBounded,
  type OutboundNetworkSettings,
  type PinnedFetchOptions,
} from "@opengeni/network";

export const SIDEBAR_LINK_ICON_MAX_BYTES = 100 * 1024;
const TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 2;
const CACHE_MAX = 500;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 60 * 1000;

export type SidebarLinkIcon = { bytes: Uint8Array; contentType: string };

const cache = new Map<string, { icon: SidebarLinkIcon | null; expires: number }>();
// Reads in flight, so many people opening one site's link fetch it once.
const pending = new Map<string, Promise<SidebarLinkIcon | null>>();

/** The image type of `bytes` by its first bytes; SVG and anything else is refused. */
export function sniffSidebarLinkIcon(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index];
  if (at(0) === 0 && at(1) === 0 && (at(2) === 1 || at(2) === 2) && at(3) === 0)
    return "image/x-icon";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  return null;
}

async function fetchIcon(
  origin: string,
  settings: OutboundNetworkSettings,
  options: PinnedFetchOptions,
): Promise<SidebarLinkIcon | null> {
  let url = `${origin}/favicon.ico`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await pinnedFetch(
      url,
      { headers: { accept: "image/*" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      settings,
      { label: "Sidebar link icon", requireHttpsOutsideLocalTest: true, ...options },
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) return null;
      const next = new URL(location, url);
      // Only the default https port, so the route can't probe other ports.
      if (next.protocol !== "https:" || next.port !== "") return null;
      url = next.toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readResponseBodyBounded(
      response,
      SIDEBAR_LINK_ICON_MAX_BYTES,
      "Sidebar link icon",
    );
    const contentType = sniffSidebarLinkIcon(bytes);
    return contentType ? { bytes, contentType } : null;
  }
  return null;
}

/** The icon of the site `url` is on, or null when it has none the console can show. */
export async function readSidebarLinkIcon(
  url: string,
  settings: OutboundNetworkSettings,
  options: PinnedFetchOptions = {},
  now = Date.now(),
): Promise<SidebarLinkIcon | null> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.port !== "") return null;
  const origin = parsed.origin;
  const kept = cache.get(origin);
  if (kept && kept.expires > now) return kept.icon;
  const inFlight = pending.get(origin);
  if (inFlight) return await inFlight;
  const read = fetchIcon(origin, settings, options).catch(() => null);
  pending.set(origin, read);
  let icon: SidebarLinkIcon | null;
  try {
    icon = await read;
  } finally {
    pending.delete(origin);
  }
  cache.delete(origin);
  cache.set(origin, { icon, expires: now + (icon ? FOUND_TTL_MS : MISSING_TTL_MS) });
  // The oldest entry goes first.
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return icon;
}

/** For tests: forget every kept icon. */
export function resetSidebarLinkIcons(): void {
  cache.clear();
  pending.clear();
}
