import {
  BrowserControlRequestError,
  BrowserControlTransportError,
} from "@opengeni/runtime/sandbox";

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
