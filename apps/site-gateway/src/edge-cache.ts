/**
 * The colo-local Workers cache (`caches.default`). Absent outside workerd
 * (unit tests), in which case callers skip caching. Keys use an internal,
 * unroutable hostname so they never collide with a real request URL.
 */
export const INTERNAL_CACHE_ORIGIN = "https://site-gateway.internal";

export function edgeCache(): Cache | null {
  const storage = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return storage?.default ?? null;
}

export function internalCacheKey(path: string): Request {
  return new Request(`${INTERNAL_CACHE_ORIGIN}${path}`);
}
