import {
  BrowserControlRequestError,
  BrowserControlTransportError,
  exposedPortAllowsHostFetch,
  exposedPortEndpointFromUrl,
} from "@opengeni/runtime/sandbox";

/** Modal/Daytona/Blaxel tunnels serve browserd at `/`, so a cached
 * controller-only session can host-fetch JSON. OpenSandbox's lifecycle proxy
 * prefixes `/v1/sandboxes/<id>/proxy/<port>` and rewrites Authorization; JSON
 * must stay on an exec-capable in-box curl session. OSEP-0011 signed URIs are
 * Authorization-preserving and host-fetch like a native tunnel. */
export function controllerCacheAllowsHostFetch(url: string): boolean {
  try {
    return exposedPortAllowsHostFetch(exposedPortEndpointFromUrl(url));
  } catch {
    return false;
  }
}

/** Prefer a lease-fenced controller endpoint for the idempotent create path.
 * Only a transport-class failure invalidates the cache and provisions once;
 * semantic failures belong to the caller and must never be replayed. */
export async function withCachedController<C, T>(options: {
  cachedUrl: string | null;
  createCachedClient: (url: string) => C;
  prepareCachedClient?: (client: C) => Promise<void>;
  invalidateCachedUrl: () => Promise<unknown>;
  provisionClient: () => Promise<C>;
  use: (client: C) => Promise<T>;
}): Promise<T> {
  if (options.cachedUrl) {
    try {
      const client = options.createCachedClient(options.cachedUrl);
      await options.prepareCachedClient?.(client);
      return await options.use(client);
    } catch (error) {
      if (!isRetryableControllerTransport(error)) throw error;
      await options.invalidateCachedUrl().catch(() => undefined);
    }
  }
  return await options.use(await options.provisionClient());
}

export function isRetryableControllerTransport(error: unknown): boolean {
  return (
    error instanceof BrowserControlTransportError ||
    (error instanceof BrowserControlRequestError && error.retryable)
  );
}
