/**
 * Single-flight loader for one digest-pinned tool catalog.
 *
 * - Concurrent cold callers share one request instead of each fetching.
 * - A waiter's AbortSignal cancels only its own wait. The shared request is
 *   cancelled once every waiter has aborted, and the next caller then starts
 *   a new request. A waiter without a signal keeps the shared request alive
 *   for every joiner until it settles (bounded by transport/server timeouts).
 * - A failed load is never cached; the next caller starts a new request.
 * - An explicit refresh, or a stale rejection, always obtains a catalog from a
 *   request started after that refresh/rejection. Callers rejected on the same
 *   stale digest share one post-rejection request while it is still current.
 * - A load started before an invalidation never overwrites the newer state.
 */
export type SharedCatalogLoader<T extends { digest: string }> = {
  load(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<T>;
  /** Reload after the server rejected `staleDigest` as a stale catalog. */
  reloadAfterStale(staleDigest: string, signal?: AbortSignal): Promise<T>;
  /** Drop the cached catalog when it is `digest`, without fetching. */
  invalidate(digest: string): void;
};

type SharedLoad<T> = {
  epoch: number;
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
};

export function createSharedCatalogLoader<T extends { digest: string }>(
  /**
   * `refresh` is true when this load follows an invalidation or explicit
   * refresh. `signal` aborts only when every waiter has abandoned the load.
   */
  fetchCatalog: (refresh: boolean, signal: AbortSignal) => Promise<T>,
): SharedCatalogLoader<T> {
  let snapshot: T | null = null;
  let epoch = 0;
  let refreshPending = false;
  let inFlight: SharedLoad<T> | null = null;
  let staleReload: {
    staleDigest: string;
    load: SharedLoad<T>;
    settled: T | null;
  } | null = null;

  const start = (): SharedLoad<T> => {
    if (inFlight && inFlight.epoch === epoch) return inFlight;
    const refresh = refreshPending;
    const load = {
      epoch,
      controller: new AbortController(),
      waiters: 0,
      settled: false,
    } as SharedLoad<T>;
    inFlight = load;
    load.promise = (async () => {
      try {
        const next = await fetchCatalog(refresh, load.controller.signal);
        // An abandoned load (every waiter aborted) never writes shared state,
        // even when its transport ignored the abort and settled late.
        if (load.epoch === epoch && !load.controller.signal.aborted) {
          snapshot = next;
          refreshPending = false;
        }
        return next;
      } finally {
        load.settled = true;
        if (inFlight === load) inFlight = null;
      }
    })();
    // Every waiter observes rejection itself; never leave an unobserved one.
    load.promise.catch(() => undefined);
    return load;
  };

  const abandon = (load: SharedLoad<T>, reason: unknown): void => {
    if (inFlight === load) inFlight = null;
    if (staleReload?.load === load) staleReload = null;
    load.controller.abort(reason);
  };

  const wait = (load: SharedLoad<T>, signal: AbortSignal | undefined): Promise<T> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    load.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = (): boolean => {
        if (released) return false;
        released = true;
        load.waiters -= 1;
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const onAbort = () => {
        if (!release()) return;
        const reason = abortReason(signal!);
        reject(reason);
        if (load.waiters === 0 && !load.settled) abandon(load, reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      load.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (error: unknown) => {
          if (release()) reject(error);
        },
      );
    });
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
      return await wait(start(), options.signal);
    },
    async reloadAfterStale(staleDigest, signal) {
      signal?.throwIfAborted();
      // Share a post-rejection reload while it is still the current load, or
      // while its result is still the current catalog; never reuse a
      // superseded load or result.
      const shared = staleReload;
      if (
        shared?.staleDigest === staleDigest &&
        (shared.settled === null ? shared.load.epoch === epoch : shared.settled === snapshot)
      ) {
        return await wait(shared.load, signal);
      }
      advance();
      const load = start();
      const reload: { staleDigest: string; load: SharedLoad<T>; settled: T | null } = {
        staleDigest,
        load,
        settled: null,
      };
      staleReload = reload;
      load.promise.then(
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
      return await wait(load, signal);
    },
    invalidate(digest) {
      if (snapshot?.digest === digest) advance();
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
