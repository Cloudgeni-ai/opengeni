import type { SessionEvent } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionClientLike } from "../client";

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
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const activeLoadRef = useRef(load);
  activeLoadRef.current = load;
  const requestAbortRef = useRef<AbortController | null>(null);
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

  const run = useCallback(async () => {
    // A callback retained by a completed mutation from the previous query must
    // not supersede or settle the current query's request.
    if (activeLoadRef.current !== load) return;
    const ticket = ++generation.current;
    requestAbortRef.current?.abort();
    const requestAbort = new AbortController();
    requestAbortRef.current = requestAbort;
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
      if (requestAbortRef.current === requestAbort) {
        requestAbortRef.current = null;
      }
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void run();
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      return () => {
        generation.current += 1;
        requestAbortRef.current?.abort();
      };
    }
    const timer = setInterval(() => void run(), pollIntervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
      requestAbortRef.current?.abort();
    };
  }, [run, enabled, pollIntervalMs]);

  const identityMatches = stateIdentity.load === load;
  return {
    data: identityMatches ? data : null,
    loading: identityMatches ? loading : enabled,
    error: identityMatches ? error : null,
    refresh: run,
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
  if (!Object.is(identityRef.current, identity)) {
    identityRef.current = identity;
    generation.current += 1;
    inFlight.current = 0;
  }
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
        return await operation();
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
  client: SessionClientLike,
  workspaceId: string,
  sessionId: string | null | undefined,
  match: (event: SessionEvent) => boolean,
  onEvent: (event: SessionEvent) => void,
  options: SessionEventFeedOptions = {},
): void {
  const enabled = options.enabled ?? true;
  const events = options.events;
  const sharedFeed = events !== undefined;
  const matchRef = useRef(match);
  matchRef.current = match;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const consumedRef = useRef(0);
  const feedKeyRef = useRef<string | null>(null);

  // Shared-log mode: scan only the unseen tail on every append.
  useEffect(() => {
    if (!sharedFeed || !enabled || !sessionId) {
      return;
    }
    const feedKey = `${workspaceId}\u0000${sessionId}`;
    const firstSequence = events[0]?.sequence ?? 0;
    // A new session target or a log reset (sequence restarted below the
    // cursor) restarts consumption from the top of the shared log.
    if (feedKeyRef.current !== feedKey || firstSequence > consumedRef.current + 1) {
      feedKeyRef.current = feedKey;
      consumedRef.current = 0;
    }
    for (const event of events) {
      if (event.sequence <= consumedRef.current) {
        continue;
      }
      consumedRef.current = event.sequence;
      if (matchRef.current(event)) {
        onEventRef.current(event);
      }
    }
  }, [sharedFeed, enabled, events, workspaceId, sessionId]);

  // Self-stream mode: tail from the session's current lastSequence.
  useEffect(() => {
    if (sharedFeed || !enabled || !sessionId) {
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
  }, [sharedFeed, enabled, client, workspaceId, sessionId]);
}

/** Debounce rapid event bursts into one trailing call (default 150ms). */
export function useDebouncedCallback(callback: () => void, delayMs = 150): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
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
