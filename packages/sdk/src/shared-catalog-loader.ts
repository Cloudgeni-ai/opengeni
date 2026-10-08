/**
 * Single-flight loader for one digest-pinned tool catalog.
 *
 * - Concurrent cold callers share one request instead of each fetching.
 * - The shared request is never bound to one caller's AbortSignal: a waiter
 *   that aborts rejects alone, and its siblings still receive the catalog.
 * - A failed load is never cached; the next caller starts a new request.
 * - An explicit refresh, or a stale rejection, always obtains a catalog from a
 *   request started after that refresh/rejection. Callers rejected on the same
 *   stale digest share that one post-rejection request.
 * - A load started before an invalidation never overwrites the newer state.
 */
export type SharedCatalogLoader<T extends { digest: string }> = {
  load(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<T>;
  /** Reload after the server rejected `staleDigest` as a stale catalog. */
  reloadAfterStale(staleDigest: string, signal?: AbortSignal): Promise<T>;
  /** Drop the cached catalog when it is `digest`, without fetching. */
  invalidate(digest: string): void;
};

type InFlightLoad<T> = { epoch: number; promise: Promise<T> };

export function createSharedCatalogLoader<T extends { digest: string }>(
  /** `refresh` is true when this load follows an invalidation or explicit refresh. */
  fetchCatalog: (refresh: boolean) => Promise<T>,
): SharedCatalogLoader<T> {
  let snapshot: T | null = null;
  let epoch = 0;
  let refreshPending = false;
  let inFlight: InFlightLoad<T> | null = null;
  let staleReload: { staleDigest: string; promise: Promise<T>; settled: T | null } | null = null;

  const start = (): Promise<T> => {
    if (inFlight && inFlight.epoch === epoch) return inFlight.promise;
    const entry: { epoch: number; promise: Promise<T> | null } = { epoch, promise: null };
    const refresh = refreshPending;
    inFlight = entry as InFlightLoad<T>;
    const promise = (async () => {
      try {
        const next = await fetchCatalog(refresh);
        if (entry.epoch === epoch) {
          snapshot = next;
          refreshPending = false;
        }
        return next;
      } finally {
        if (inFlight === entry) inFlight = null;
      }
    })();
    // Every waiter observes rejection itself; never leave an unobserved one.
    promise.catch(() => undefined);
    entry.promise = promise;
    return promise;
  };

  const advance = (): void => {
    snapshot = null;
    epoch += 1;
    refreshPending = true;
  };

  return {
    async load(options = {}) {
      options.signal?.throwIfAborted();
      if (options.refresh) advance();
      if (snapshot) return snapshot;
      return await raceAbort(start(), options.signal);
    },
    async reloadAfterStale(staleDigest, signal) {
      signal?.throwIfAborted();
      // Share a post-rejection reload while it runs, or while its result is
      // still the current catalog; never reuse a superseded result.
      if (
        staleReload?.staleDigest === staleDigest &&
        (staleReload.settled === null || staleReload.settled === snapshot)
      ) {
        return await raceAbort(staleReload.promise, signal);
      }
      advance();
      const promise = start();
      const reload: { staleDigest: string; promise: Promise<T>; settled: T | null } = {
        staleDigest,
        promise,
        settled: null,
      };
      staleReload = reload;
      promise.then(
        (next) => {
          // The same digest again proves nothing newer; a later rejection must
          // start its own request rather than reuse this one.
          if (staleReload !== reload) return;
          if (next.digest === staleDigest) staleReload = null;
          else reload.settled = next;
        },
        () => {
          if (staleReload === reload) staleReload = null;
        },
      );
      return await raceAbort(promise, signal);
    },
    invalidate(digest) {
      if (snapshot?.digest === digest) advance();
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
