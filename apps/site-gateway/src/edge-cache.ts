/**
 * The colo-local Workers cache (`caches.default`). Absent outside workerd
 * (unit tests), in which case callers skip caching.
 *
 * Keys are URLs on the real Site host, under the gateway-owned
 * `/_og/cache/` path that no request is ever routed to. Keying on the host
 * lets a Cloudflare purge by hostname (which the API issues on takedown)
 * drop every entry for a Site. Entries that depend on the host-map record
 * also carry its `generation`, so a new record (publish, unpublish,
 * suspension, access change) never reads an older entry.
 */
export const EDGE_CACHE_PREFIX = "/_og/cache";

export function edgeCache(): Cache | null {
  const storage = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return storage?.default ?? null;
}

/** `https://<host>/_og/cache/<kind>[/<generation>]/<parts...>` with every part encoded. */
export function edgeCacheKey(
  hostname: string,
  kind: string,
  parts: readonly (string | number)[] = [],
): Request {
  const path = [kind, ...parts].map((part) => encodeURIComponent(String(part))).join("/");
  return new Request(`https://${hostname}${EDGE_CACHE_PREFIX}/${path}`);
}
