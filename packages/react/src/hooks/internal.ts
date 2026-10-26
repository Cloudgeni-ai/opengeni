import {
  isMaintenanceError,
  isTransientRequestError,
  observedSessionSequence,
  type SessionEvent,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EmbeddedSessionEventClientLike } from "../client";
import { normalizeError } from "../lib/error-message";

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
 * How a read hook rides out transient failures (a transport error or a
 * 502/503/504, as during an API rolling deploy). While the failures last less
 * than `quietWindowMs`, the hook keeps its loading state or its last data and
 * retries with backoff; after that it surfaces the error but keeps retrying
 * every `backgroundDelayMs`, and clears the error when a read succeeds.
 * Definitive errors (401, 403, 404, other statuses) surface immediately.
 */
export type TransientReadRetryOptions = {
  quietWindowMs?: number | undefined;
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  backgroundDelayMs?: number | undefined;
};

export type TransientReadRetryPolicy = {
  quietWindowMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backgroundDelayMs: number;
};

export const DEFAULT_TRANSIENT_READ_RETRY: Readonly<TransientReadRetryPolicy> = Object.freeze({
  quietWindowMs: 20_000,
  initialDelayMs: 1_000,
  maxDelayMs: 4_000,
  backgroundDelayMs: 15_000,
});

type TransientReadStreak = { since: number; attempts: number; surfaced: boolean };

/**
 * Upper bound between retries while the API answers with the maintenance
 * marker. A park can last minutes; reads keep checking at this pace so the
 * page recovers soon after the update finishes.
 */
export const MAINTENANCE_READ_RETRY_MAX_DELAY_MS = 8_000;

function jittered(delayMs: number): number {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

/**
 * The decision for one transient read failure: stay quiet and retry soon, or
 * surface the error (once per streak) and keep retrying in the background.
 */
export function transientReadRetryStep(
  streak: TransientReadStreak,
  now: number,
  policy: TransientReadRetryPolicy,
  cause?: unknown,
): { quiet: boolean; delayMs: number } {
  streak.attempts += 1;
  if (cause !== undefined && isMaintenanceError(cause)) {
    // A planned update, not an outage: stay quiet for as long as the marker
    // lasts. The quiet window restarts when the marker goes away, so a failure
    // that outlasts the update still surfaces after the usual window.
    streak.since = now;
    const delayMs = Math.min(
      MAINTENANCE_READ_RETRY_MAX_DELAY_MS,
      policy.initialDelayMs * 2 ** (streak.attempts - 1),
    );
    return { quiet: true, delayMs: Math.max(0, jittered(delayMs)) };
  }
  const quiet = now - streak.since < policy.quietWindowMs;
  const delayMs = quiet
    ? Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (streak.attempts - 1))
    : policy.backgroundDelayMs;
  return { quiet, delayMs: Math.max(0, jittered(delayMs)) };
}

/**
 * Shared fetch + optional polling loop for the list/read hooks. Stale
 * responses (superseded by a newer load or an unmount) are dropped.
 * Transient failures are retried quietly (see {@link TransientReadRetryOptions}).
 */
export function usePolledValue<T>(
  load: (signal?: AbortSignal) => Promise<T>,
  options: {
    pollIntervalMs?: number | undefined;
    enabled?: boolean | undefined;
    /** Quiet retry of transient failures; on by default, `false` surfaces them at once. */
    transientRetry?: TransientReadRetryOptions | false | undefined;
  } = {},
): AsyncListState<T> {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs;
  const transientRetryRef = useRef<TransientReadRetryPolicy | null>(null);
  transientRetryRef.current =
    options.transientRetry === false
      ? null
      : {
          quietWindowMs:
            options.transientRetry?.quietWindowMs ?? DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs,
          initialDelayMs:
            options.transientRetry?.initialDelayMs ?? DEFAULT_TRANSIENT_READ_RETRY.initialDelayMs,
          maxDelayMs: options.transientRetry?.maxDelayMs ?? DEFAULT_TRANSIENT_READ_RETRY.maxDelayMs,
          backgroundDelayMs:
            options.transientRetry?.backgroundDelayMs ??
            DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs,
        };
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
  // The current run of consecutive transient failures, and its pending retry.
  const transientStreakRef = useRef<TransientReadStreak | null>(null);
  const transientRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Retries run only while the query is enabled and the page is live.
  const retryLiveRef = useRef(false);
  const cancelTransientRetry = useCallback(() => {
    if (transientRetryTimerRef.current !== null) {
      clearTimeout(transientRetryTimerRef.current);
      transientRetryTimerRef.current = null;
    }
  }, []);
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
          transientStreakRef.current = null;
          cancelTransientRetry();
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
          const policy = transientRetryRef.current;
          if (policy && retryLiveRef.current && isTransientRequestError(cause)) {
            // Keep the loading state or the last data on screen while a
            // deploy or network blip passes; retry, and surface the error
            // only once it outlasts the quiet window.
            const now = Date.now();
            const streak = (transientStreakRef.current ??= {
              since: now,
              attempts: 0,
              surfaced: false,
            });
            const step = transientReadRetryStep(streak, now, policy, cause);
            if (!step.quiet) {
              // One stable error per streak: background retries that fail
              // the same way must not re-announce it.
              if (!streak.surfaced) setError(normalizeError(cause));
              streak.surfaced = true;
              setLoading(false);
            }
            cancelTransientRetry();
            transientRetryTimerRef.current = setTimeout(() => {
              transientRetryTimerRef.current = null;
              if (retryLiveRef.current) void run();
            }, step.delayMs);
          } else {
            transientStreakRef.current = null;
            cancelTransientRetry();
            setError(normalizeError(cause));
            setLoading(false);
          }
        }
      } finally {
        if (requestAbortRef.current === requestAbort) requestAbortRef.current = null;
        if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
      }
    })();
    inFlightRef.current = { load, promise };
    return promise;
  }, [cancelTransientRetry, load]);

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

  // The read lifecycle: a query (re)start reads at once and its end cancels
  // the read in flight. The poll interval is not part of the query, so
  // changing it (for example when live list hints take over from polling)
  // never aborts or repeats a read; only the polling effect below reschedules.
  useEffect(() => {
    // Every (re)start begins a fresh streak; a pending retry belongs to the
    // previous query or visibility period.
    transientStreakRef.current = null;
    cancelTransientRetry();
    if (!enabled || !pageLive) {
      retryLiveRef.current = false;
      setLoading(false);
      generation.current += 1;
      requestAbortRef.current?.abort();
      inFlightRef.current = null;
      trailingRefreshRef.current = null;
      return;
    }
    retryLiveRef.current = true;
    setLoading(true);
    void run();
    return () => {
      retryLiveRef.current = false;
      cancelTransientRetry();
      generation.current += 1;
      requestAbortRef.current?.abort();
      inFlightRef.current = null;
      trailingRefreshRef.current = null;
    };
  }, [run, enabled, pageLive, cancelTransientRetry]);

  // Polling: each read is followed by the next one interval later. The first
  // interval starts when the read in flight settles (or now, when none is).
  useEffect(() => {
    if (!enabled || !pageLive || pollIntervalMs === undefined || pollIntervalMs <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        timer = null;
        void run().finally(schedule);
      }, pollIntervalMs);
    };
    const pending = inFlightRef.current;
    if (pending?.load === load) void pending.promise.finally(schedule);
    else schedule();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [run, load, enabled, pageLive, pollIntervalMs]);

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
          setMutationError(normalizeError(cause));
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
 * What a read hook's authoritative value reflects, for {@link useSessionEventTrigger}:
 *
 * - a number: every session event at or below this sequence (the session
 *   detail's `lastSequence`, or a projection's `observedSessionSequence`);
 * - `"reading"`: the first read for this conversation is still in flight;
 * - `null` (or omitted): unknown, so every matching event refreshes.
 */
export type SessionReadThrough = number | "reading" | null;

/** The sequence a projection read reflects, as {@link SessionReadThrough}. */
export function projectionReadThrough(
  value: unknown,
  firstReadInFlight: boolean,
): SessionReadThrough {
  if (value === null || value === undefined) return firstReadInFlight ? "reading" : null;
  return observedSessionSequence(value) ?? null;
}

export type SessionEventTriggerOptions = SessionEventFeedOptions & {
  /**
   * Shared-feed mode: deliver an event only when the hook's own read does not
   * already reflect it. While the first read is in flight, matching events
   * wait for it and the newest is delivered once if the read predates it.
   */
  readThrough?: SessionReadThrough | undefined;
  /**
   * Re-read the hook's projection. Called instead of delivering an event when
   * the feed's window starts after the sequence the read reflects, so events
   * between them (which could have changed the projection) were never seen.
   */
  refresh?: (() => void) | undefined;
};

type HeldBatch = { latestMatch: SessionEvent | undefined; windowStart: number };

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
  options: SessionEventTriggerOptions = {},
  reconcileBeforeLive?: (() => void | Promise<void>) | undefined,
): void {
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const liveEnabled = enabled && pageLive;
  const events = options.events;
  const sharedFeed = events !== undefined;
  const readThrough = options.readThrough ?? null;
  const matchRef = useRef(match);
  const onEventRef = useRef(onEvent);
  const reconcileBeforeLiveRef = useRef(reconcileBeforeLive);
  const readThroughRef = useRef(readThrough);
  const refreshRef = useRef(options.refresh);
  useLayoutEffect(() => {
    matchRef.current = match;
    onEventRef.current = onEvent;
    reconcileBeforeLiveRef.current = reconcileBeforeLive;
    readThroughRef.current = readThrough;
    refreshRef.current = options.refresh;
  }, [match, onEvent, reconcileBeforeLive, readThrough, options.refresh]);
  const consumedRef = useRef(0);
  const feedKeyRef = useRef<string | null>(null);
  const sharedFeedHasEventsRef = useRef(false);
  // The newest matching event that arrived while the first read was in flight,
  // and the latest window start the feed reported meanwhile.
  const awaitingReadRef = useRef<HeldBatch | null>(null);
  const deliverBatch = useCallback((batch: HeldBatch) => {
    const through = readThroughRef.current;
    if (through === "reading") {
      const waiting = awaitingReadRef.current;
      const latest =
        waiting?.latestMatch &&
        (!batch.latestMatch || waiting.latestMatch.sequence > batch.latestMatch.sequence)
          ? waiting.latestMatch
          : batch.latestMatch;
      awaitingReadRef.current = {
        latestMatch: latest,
        windowStart: Math.max(waiting?.windowStart ?? 0, batch.windowStart),
      };
      return;
    }
    if (typeof through === "number") {
      // Events between the read and the window's first event were never seen.
      if (batch.windowStart > through + 1 && refreshRef.current) {
        refreshRef.current();
        return;
      }
      if (batch.latestMatch && batch.latestMatch.sequence > through) {
        onEventRef.current(batch.latestMatch);
      }
      return;
    }
    if (batch.latestMatch) onEventRef.current(batch.latestMatch);
  }, []);
  const deliver = useCallback(
    (event: SessionEvent) => deliverBatch({ latestMatch: event, windowStart: 0 }),
    [deliverBatch],
  );
  // The first read landed: settle what waited for it against what it reflects.
  useEffect(() => {
    if (readThrough === "reading") return;
    const waiting = awaitingReadRef.current;
    awaitingReadRef.current = null;
    if (waiting && sharedFeed && liveEnabled) deliverBatch(waiting);
  }, [deliverBatch, liveEnabled, readThrough, sharedFeed]);

  // Shared-log mode: scan only the unseen tail on every append.
  useEffect(() => {
    if (!sharedFeed || !liveEnabled || !sessionId) {
      return;
    }
    const feedKey = `${workspaceId}\u0000${sessionId}`;
    const firstSequence = events[0]?.sequence ?? 0;
    if (feedKeyRef.current !== feedKey) {
      feedKeyRef.current = feedKey;
      awaitingReadRef.current = null;
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
      deliverBatch({ latestMatch, windowStart: firstSequence });
      return;
    }
    sharedFeedHasEventsRef.current ||= events.length > 0;
    for (const event of events) {
      if (event.sequence <= consumedRef.current) {
        continue;
      }
      consumedRef.current = event.sequence;
      if (matchRef.current(event)) {
        deliver(event);
      }
    }
  }, [sharedFeed, liveEnabled, events, workspaceId, sessionId, deliver, deliverBatch]);

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
