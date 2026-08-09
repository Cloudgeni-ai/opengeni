import type { SessionEvent } from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EmbeddedSessionEventClientLike } from "../client";

const HIDDEN_STREAM_GRACE_MS = 2_000;

/**
 * Keep live browser work active while the page is visible, then suspend it
 * after a short hidden-tab grace period. Returning to the page re-enables the
 * caller, which must reconcile durable state before resuming live delivery.
 */
export function usePageLiveActivity(hiddenGraceMs = HIDDEN_STREAM_GRACE_MS): boolean {
  // Keep the server and initial browser render identical; the effect applies
  // visibility after mount and preserves the intentional hidden-tab grace.
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelHiddenTimer = () => {
      if (hiddenTimer !== null) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
    };
    const sync = () => {
      cancelHiddenTimer();
      if (document.visibilityState !== "hidden") {
        setActive(true);
        return;
      }
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        if (document.visibilityState === "hidden") setActive(false);
      }, hiddenGraceMs);
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pageshow", sync);
    sync();
    return () => {
      cancelHiddenTimer();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, [hiddenGraceMs]);

  return active;
}

export type AsyncListState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/**
 * Shared fetch + optional polling loop for the list/read hooks. Stale
 * responses (superseded by a newer load or an unmount) are dropped.
 */
export function usePolledValue<T>(
  load: (signal?: AbortSignal) => Promise<T>,
  options: { pollIntervalMs?: number | undefined; enabled?: boolean | undefined } = {},
): AsyncListState<T> {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs;
  const pageLive = usePageLiveActivity();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const activeLoadRef = useRef(load);
  useLayoutEffect(() => {
    activeLoadRef.current = load;
  }, [load]);
  const requestAbortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<{ load: typeof load; promise: Promise<void> } | null>(null);
  const trailingRefreshRef = useRef<{ load: typeof load; promise: Promise<void> } | null>(null);
  const [stateIdentity, setStateIdentity] = useState<{ load: typeof load }>(() => ({ load }));

  // A new loader identity means a new query (different session/workspace/...):
  // drop the previous result instead of showing it as the new query's data.
  useEffect(() => {
    if (stateIdentity.load !== load) {
      setStateIdentity({ load });
      setData(null);
      setError(null);
    }
  }, [load, stateIdentity.load]);

  const run = useCallback((): Promise<void> => {
    // A callback retained by a completed mutation from the previous query must
    // not supersede or settle the current query's request.
    if (activeLoadRef.current !== load) return Promise.resolve();
    const existing = inFlightRef.current;
    if (existing?.load === load) return existing.promise;
    const ticket = ++generation.current;
    const requestAbort = new AbortController();
    requestAbortRef.current = requestAbort;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const result = await load(requestAbort.signal);
        if (
          ticket === generation.current &&
          activeLoadRef.current === load &&
          !requestAbort.signal.aborted
        ) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      } catch (cause) {
        if (
          ticket === generation.current &&
          activeLoadRef.current === load &&
          !requestAbort.signal.aborted
        ) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        }
      } finally {
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
        if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
      }
    })();
    inFlightRef.current = { load, promise };
    return promise;
  }, [load]);

  const refresh = useCallback((): Promise<void> => {
    const existing = inFlightRef.current;
    if (existing?.load !== load) return run();
    const trailing = trailingRefreshRef.current;
    if (trailing?.load === load) return trailing.promise;
    let promise!: Promise<void>;
    promise = existing.promise.then(async () => {
      if (trailingRefreshRef.current?.promise === promise) {
        trailingRefreshRef.current = null;
      }
      if (activeLoadRef.current === load) await run();
    });
    trailingRefreshRef.current = { load, promise };
    return promise;
  }, [load, run]);

  useEffect(() => {
    if (!enabled || !pageLive) {
      setLoading(false);
      generation.current += 1;
      requestAbortRef.current?.abort();
      inFlightRef.current = null;
      trailingRefreshRef.current = null;
      return;
    }
    setLoading(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (cancelled || pollIntervalMs === undefined || pollIntervalMs <= 0) return;
      timer = setTimeout(() => {
        timer = null;
        void run().finally(schedule);
      }, pollIntervalMs);
    };
    void run().finally(schedule);
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      return () => {
        cancelled = true;
        generation.current += 1;
        requestAbortRef.current?.abort();
        inFlightRef.current = null;
        trailingRefreshRef.current = null;
      };
    }
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      generation.current += 1;
      requestAbortRef.current?.abort();
      inFlightRef.current = null;
      trailingRefreshRef.current = null;
    };
  }, [run, enabled, pageLive, pollIntervalMs]);

  const identityMatches = stateIdentity.load === load;
  return {
    data: identityMatches ? data : null,
    loading: identityMatches ? loading : enabled,
    error: identityMatches ? error : null,
    refresh,
  };
}

export type MutationState = {
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * Shared async mutation runner for the write hooks. `run` resolves with the
 * operation's value, or `null` after capturing the error in `mutationError`
 * (callers then roll back optimistic state).
 */
export function useMutationRunner(identity: unknown = undefined): MutationState & {
  run: <T>(operation: () => Promise<T>) => Promise<T | null>;
} {
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [stateIdentity, setStateIdentity] = useState<unknown>(() => identity);
  const inFlight = useRef(0);
  const generation = useRef(0);
  const identityRef = useRef(identity);
  useLayoutEffect(() => {
    if (Object.is(identityRef.current, identity)) return;
    identityRef.current = identity;
    generation.current += 1;
    inFlight.current = 0;
  }, [identity]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!Object.is(stateIdentity, identity)) {
      setStateIdentity(() => identity);
      setMutating(false);
      setMutationError(null);
    }
  }, [identity, stateIdentity]);
  const run = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | null> => {
      const ownedIdentity = identity;
      const ownedGeneration = generation.current;
      if (!Object.is(identityRef.current, ownedIdentity)) return null;
      inFlight.current += 1;
      if (mounted.current) {
        setMutating(true);
        setMutationError(null);
      }
      try {
        const result = await operation();
        if (
          !mounted.current ||
          generation.current !== ownedGeneration ||
          !Object.is(identityRef.current, ownedIdentity)
        ) {
          return null;
        }
        return result;
      } catch (cause) {
        if (
          mounted.current &&
          generation.current === ownedGeneration &&
          Object.is(identityRef.current, ownedIdentity)
        ) {
          setMutationError(cause instanceof Error ? cause : new Error(String(cause)));
        }
        return null;
      } finally {
        if (
          generation.current === ownedGeneration &&
          Object.is(identityRef.current, ownedIdentity)
        ) {
          inFlight.current -= 1;
          if (mounted.current && inFlight.current === 0) {
            setMutating(false);
          }
        }
      }
    },
    [identity],
  );
  const identityMatches = Object.is(stateIdentity, identity);
  return {
    mutating: identityMatches && mutating,
    mutationError: identityMatches ? mutationError : null,
    clearMutationError: useCallback(() => {
      if (Object.is(identityRef.current, identity)) setMutationError(null);
    }, [identity]),
    run,
  };
}

export type SessionEventFeedOptions = {
  /**
   * Share an existing event log (from `useSessionEvents`) instead of opening
   * a second stream. When omitted the hook tails the session's event stream
   * itself, starting at the current `lastSequence`.
   */
  events?: SessionEvent[] | undefined;
  enabled?: boolean | undefined;
};

/**
 * Invoke `onEvent` for every session event matching `match` — the live-update
 * primitive behind `useTurnQueue` and `useGoal`. Either watches a shared
 * `events` log or tails the stream directly (reconnect handled by the SDK).
 */
export function useSessionEventTrigger(
  client: EmbeddedSessionEventClientLike,
  workspaceId: string,
  sessionId: string | null | undefined,
  match: (event: SessionEvent) => boolean,
  onEvent: (event: SessionEvent) => void,
  options: SessionEventFeedOptions = {},
  reconcileBeforeLive?: (() => void | Promise<void>) | undefined,
): void {
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const liveEnabled = enabled && pageLive;
  const events = options.events;
  const sharedFeed = events !== undefined;
  const matchRef = useRef(match);
  const onEventRef = useRef(onEvent);
  const reconcileBeforeLiveRef = useRef(reconcileBeforeLive);
  useLayoutEffect(() => {
    matchRef.current = match;
    onEventRef.current = onEvent;
    reconcileBeforeLiveRef.current = reconcileBeforeLive;
  }, [match, onEvent, reconcileBeforeLive]);
  const consumedRef = useRef(0);
  const feedKeyRef = useRef<string | null>(null);
  const sharedFeedHasEventsRef = useRef(false);

  // Shared-log mode: scan only the unseen tail on every append.
  useEffect(() => {
    if (!sharedFeed || !liveEnabled || !sessionId) {
      return;
    }
    const feedKey = `${workspaceId}\u0000${sessionId}`;
    const firstSequence = events[0]?.sequence ?? 0;
    if (feedKeyRef.current !== feedKey) {
      feedKeyRef.current = feedKey;
      sharedFeedHasEventsRef.current = events.length > 0;
      // The caller has already loaded its authoritative initial projection.
      // Seed from the shared log's current tail so mounting a large historical
      // session cannot replay every old event as a new live trigger.
      consumedRef.current = events.at(-1)?.sequence ?? 0;
      return;
    }
    const firstNonEmptyBatch = !sharedFeedHasEventsRef.current && events.length > 0;
    if (firstNonEmptyBatch || firstSequence > consumedRef.current + 1) {
      // The usual shared feed mounts empty, then receives a historical tail.
      // A later discontinuity can likewise replace the retained browser
      // window. In either case, reconcile once from the latest relevant event
      // instead of replaying the whole retained window as live traffic.
      sharedFeedHasEventsRef.current = events.length > 0;
      consumedRef.current = events.at(-1)?.sequence ?? consumedRef.current;
      let latestMatch: SessionEvent | undefined;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event && matchRef.current(event)) {
          latestMatch = event;
          break;
        }
      }
      if (latestMatch) {
        onEventRef.current(latestMatch);
      }
      return;
    }
    sharedFeedHasEventsRef.current ||= events.length > 0;
    for (const event of events) {
      if (event.sequence <= consumedRef.current) {
        continue;
      }
      consumedRef.current = event.sequence;
      if (matchRef.current(event)) {
        onEventRef.current(event);
      }
    }
  }, [sharedFeed, liveEnabled, events, workspaceId, sessionId]);

  // Self-stream mode: tail from the session's current lastSequence.
  useEffect(() => {
    if (sharedFeed || !liveEnabled || !sessionId) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await client.getSession(workspaceId, sessionId);
        if (controller.signal.aborted) {
          return;
        }
        const stream = client.streamEvents(workspaceId, sessionId, {
          after: session.lastSequence,
          signal: controller.signal,
          onOpen: () => {
            // Start reconciliation without delaying consumption of live SSE.
            void Promise.resolve()
              .then(() => reconcileBeforeLiveRef.current?.())
              .catch(() => undefined);
          },
        });
        for await (const event of stream) {
          if (matchRef.current(event)) {
            onEventRef.current(event);
          }
        }
      } catch {
        // Live updates are best-effort: the read hooks still expose refresh()
        // and the initial load already populated state.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [sharedFeed, liveEnabled, client, workspaceId, sessionId]);
}

/** Debounce rapid event bursts into one trailing call (default 150ms). */
export function useDebouncedCallback(callback: () => void, delayMs = 150): () => void {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);
  return useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      callbackRef.current();
    }, delayMs);
  }, [delayMs]);
}
