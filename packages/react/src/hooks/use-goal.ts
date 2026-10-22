import {
  OpenGeniApiError,
  observedSessionSequence,
  type SessionEvent,
  type SessionGoal,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEmbeddedGoal, type EmbeddedGoalClientOverride } from "../session-context";
import { normalizeError } from "../lib/error-message";
import { deniesRetainedView, useRetainedSessionView } from "./session-view-cache";
import {
  projectionReadThrough,
  useDebouncedCallback,
  useMutationRunner,
  usePageLiveActivity,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Event types that change the session goal (set/updated/completed/paused/...). */
export function isGoalEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type.startsWith("goal.");
}

/**
 * Events that can change the server-authoritative continuation projection.
 * The projection is derived from durable turn, session, control, and system
 * update state, so those events refresh the goal without model polling.
 */
export function isGoalRefreshEvent(event: Pick<SessionEvent, "type">): boolean {
  const type = event.type;
  return (
    isGoalEvent(event) ||
    type.startsWith("turn.") ||
    type.startsWith("session.") ||
    type.startsWith("system.update.") ||
    type.startsWith("workspace.inference.") ||
    type.startsWith("user.")
  );
}

export type UseGoalOptions = EmbeddedGoalClientOverride &
  SessionEventFeedOptions & {
    /** Optional safety-net polling (ms). Off by default — event refreshes drive updates. */
    pollIntervalMs?: number | undefined;
  };

export type UseGoalResult = {
  /** The session goal, or null when the session has none. */
  goal: SessionGoal | null;
  /** Convenience flags over `goal.status`. */
  isActive: boolean;
  isPaused: boolean;
  isCompleted: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Pause the goal loop (PATCH status=paused). */
  pause: (rationale?: string) => Promise<SessionGoal | null>;
  /** Resume a paused goal: resets counters and re-arms continuations. */
  resume: () => Promise<SessionGoal | null>;
  /** Clear the session goal; goal-less sessions remain a successful no-op. */
  clearGoal: () => Promise<void>;
  /** Alias for `clearGoal`. */
  deleteGoal: () => Promise<void>;
  /** True while a pause/resume/clear is in flight. */
  updating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * The session's goal: state, the autonomy counters (`autoContinuations`,
 * `noProgressStreak`), and pause/resume control. A goal-less session yields
 * `goal: null`: read through `findGoal` as a successful null when the client
 * has it, otherwise from an absorbed 404. Live-updates on goal, turn, session,
 * control, and system-update events — pass `options.events` from
 * `useSessionEvents` to reuse its stream.
 */
export function useGoal(
  sessionId: string | null | undefined,
  options: UseGoalOptions = {},
): UseGoalResult {
  const { client, workspaceId } = useEmbeddedGoal(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedEvents = options.events;
  const sharedFeed = sharedEvents !== undefined;
  const pageLive = usePageLiveActivity();
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  // The latest read (or a delete) established that this conversation has no goal.
  const [readAbsent, setReadAbsent] = useState(false);
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();
  const generation = useRef(0);
  const targetKeyRef = useRef<string | null>(null);
  // True after the server answered that no goal exists. Only a goal event can
  // create a goal, so turn/session traffic must not refetch while none exists.
  const goalAbsentRef = useRef(false);
  // Refresh events not yet covered by a read: "goal" when any was a goal.*
  // event. Events that arrive while a read is in flight are decided when it
  // settles, so the stream's opening burst never re-reads a goal-less session.
  const pendingRefreshRef = useRef<"none" | "refresh" | "goal">("none");
  const sharedEventsRef = useRef(sharedEvents);
  useLayoutEffect(() => {
    sharedEventsRef.current = sharedEvents;
  }, [sharedEvents]);
  const loadAbort = useRef<AbortController | null>(null);
  const scheduleRefreshRef = useRef<() => void>(() => undefined);

  const retireLoads = useCallback(() => {
    generation.current += 1;
    loadAbort.current?.abort();
    loadAbort.current = null;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const ticket = ++generation.current;
    pendingRefreshRef.current = "none";
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    let fetchedGoal: SessionGoal | null = null;
    try {
      // findGoal reads a goal-less session as a successful null, so no failed
      // request reaches the browser console. Custom clients without it keep
      // getGoal, whose 404 is absorbed below (as it is from older servers).
      const fetched =
        typeof client.findGoal === "function"
          ? await client.findGoal(workspaceId, sessionId, { signal: controller.signal })
          : await client.getGoal(workspaceId, sessionId, { signal: controller.signal });
      fetchedGoal = fetched;
      if (ticket === generation.current) {
        goalAbsentRef.current = fetched === null;
        setReadAbsent(fetched === null);
        setGoal(fetched);
        setError(null);
        setLoading(false);
      }
    } catch (cause) {
      if (ticket !== generation.current) {
        return;
      }
      if (cause instanceof OpenGeniApiError && cause.status === 404) {
        // No goal is a normal state, not an error.
        goalAbsentRef.current = true;
        setReadAbsent(true);
        setGoal(null);
        setError(null);
      } else {
        setError(normalizeError(cause));
      }
      setLoading(false);
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
    if (ticket !== generation.current || pendingRefreshRef.current === "none") {
      return;
    }
    // Events arrived during this read, but a goal read that reports the session
    // sequence it reflects already includes every one at or below it. Only a
    // shared feed shows which events those were; a self-stream re-reads.
    const readThrough = fetchedGoal ? observedSessionSequence(fetchedGoal) : undefined;
    if (readThrough !== undefined && sharedEventsRef.current !== undefined) {
      const events = sharedEventsRef.current;
      const newest = events[events.length - 1];
      if (!newest || newest.sequence <= readThrough) {
        pendingRefreshRef.current = "none";
        return;
      }
    }
    // Events arrived during this read. A shared feed's first batch reports only
    // its latest match, so a goal.* event behind newer turn traffic is visible
    // only in the log: re-read when its latest goal event is not a clear.
    if (goalAbsentRef.current && pendingRefreshRef.current === "refresh") {
      const events = sharedEventsRef.current ?? [];
      let latestGoalEvent: SessionEvent | undefined;
      for (let index = events.length - 1; index >= 0 && !latestGoalEvent; index -= 1) {
        const event = events[index];
        if (event && isGoalEvent(event)) latestGoalEvent = event;
      }
      if (!latestGoalEvent || latestGoalEvent.type === "goal.cleared") {
        pendingRefreshRef.current = "none";
        return;
      }
      pendingRefreshRef.current = "goal";
    }
    scheduleRefreshRef.current();
  }, [client, workspaceId, sessionId]);

  useEffect(() => {
    const targetKey = `${workspaceId} ${sessionId ?? ""}`;
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      goalAbsentRef.current = false;
      pendingRefreshRef.current = "none";
      setReadAbsent(false);
      setGoal(null);
      setError(null);
    }
    if (!enabled || !pageLive) {
      retireLoads();
      setLoading(false);
      return;
    }
    if (sharedFeed) {
      // A shared log supplies invalidations, not the authoritative goal snapshot.
      setLoading(true);
      void load();
      return () => {
        retireLoads();
      };
    }
    setLoading(true);
    const pollIntervalMs = options.pollIntervalMs;
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      void load();
      return () => {
        retireLoads();
      };
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        timer = null;
        void load().finally(schedule);
      }, pollIntervalMs);
    };
    void load().finally(schedule);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      retireLoads();
    };
  }, [
    load,
    enabled,
    pageLive,
    workspaceId,
    sessionId,
    options.pollIntervalMs,
    retireLoads,
    sharedFeed,
  ]);

  const scheduleRefresh = useDebouncedCallback(() => {
    const pending = pendingRefreshRef.current;
    // An in-flight read settles pending events itself.
    if (pending === "none" || loadAbort.current !== null) return;
    if (pending === "refresh" && goalAbsentRef.current) {
      pendingRefreshRef.current = "none";
      return;
    }
    void load();
  });
  useLayoutEffect(() => {
    scheduleRefreshRef.current = scheduleRefresh;
  }, [scheduleRefresh]);
  const isRefreshEvent = useCallback(
    (event: SessionEvent) =>
      goalAbsentRef.current ? isGoalEvent(event) : isGoalRefreshEvent(event),
    [],
  );
  const refreshGoal = useCallback(() => {
    pendingRefreshRef.current = "goal";
    scheduleRefresh();
  }, [scheduleRefresh]);
  const onRefreshEvent = useCallback(
    (event: SessionEvent) => {
      if (isGoalEvent(event)) pendingRefreshRef.current = "goal";
      else if (pendingRefreshRef.current === "none") pendingRefreshRef.current = "refresh";
      scheduleRefresh();
    },
    [scheduleRefresh],
  );
  useSessionEventTrigger(client, workspaceId, sessionId, isRefreshEvent, onRefreshEvent, {
    enabled,
    ...(sharedEvents !== undefined ? { events: sharedEvents } : {}),
    // The load settles events that arrive during its read itself (above).
    readThrough: projectionReadThrough(goal, false),
    refresh: refreshGoal,
  });
  // Until the first read lands, show the goal as it was when this conversation
  // was last left (only when the host retains reads).
  const retainedGoal = useRetainedSessionView(
    client,
    workspaceId,
    sessionId,
    "goal",
    loading ? null : goal,
    { enabled, discard: readAbsent || deniesRetainedView(error) },
  );
  const visibleGoal = loading ? (goal ?? retainedGoal) : goal;

  // A retained goal is shown before this open's read lands. A command issued
  // then waits for that read and runs only if the goal it was aimed at is
  // still the current objective; another actor may have replaced it meanwhile.
  const goalRef = useRef(goal);
  const shownRetainedRef = useRef<SessionGoal | null>(null);
  const readWaitersRef = useRef<Array<() => void>>([]);
  useLayoutEffect(() => {
    goalRef.current = goal;
    shownRetainedRef.current = loading && goal === null ? retainedGoal : null;
  });
  useEffect(() => {
    if (loading) return;
    const waiters = readWaitersRef.current;
    readWaitersRef.current = [];
    for (const resolve of waiters) resolve();
  }, [loading]);
  useEffect(
    () => () => {
      // Leaving the conversation settles waiting commands as not applicable.
      goalRef.current = null;
      const waiters = readWaitersRef.current;
      readWaitersRef.current = [];
      for (const resolve of waiters) resolve();
    },
    [workspaceId, sessionId],
  );
  const aimedAtCurrentGoal = useCallback(async (): Promise<boolean> => {
    const shown = shownRetainedRef.current;
    if (!shown) return true;
    await new Promise<void>((resolve) => readWaitersRef.current.push(resolve));
    const fresh = goalRef.current;
    return (
      fresh !== null && fresh.id === shown.id && fresh.objectiveRevision === shown.objectiveRevision
    );
  }, []);

  const pause = useCallback(
    async (rationale?: string): Promise<SessionGoal | null> => {
      if (!sessionId || !(await aimedAtCurrentGoal())) {
        return null;
      }
      const result = await run(() =>
        client.updateGoal(workspaceId, sessionId, {
          status: "paused",
          ...(rationale !== undefined ? { rationale } : {}),
        }),
      );
      if (result) {
        setGoal(result);
      }
      return result;
    },
    [client, workspaceId, sessionId, run, aimedAtCurrentGoal],
  );

  const resume = useCallback(async (): Promise<SessionGoal | null> => {
    if (!sessionId || !(await aimedAtCurrentGoal())) {
      return null;
    }
    const result = await run(() => client.updateGoal(workspaceId, sessionId, { status: "active" }));
    if (result) {
      setGoal(result);
    }
    return result;
  }, [client, workspaceId, sessionId, run, aimedAtCurrentGoal]);

  const clearGoal = useCallback(async (): Promise<void> => {
    if (!sessionId || !(await aimedAtCurrentGoal())) {
      return;
    }
    // deleteGoal resolves void, so distinguish success (a truthy sentinel) from
    // mutation.run's null-on-failure. Only a SUCCESSFUL delete hides the goal:
    // a failed one leaves the pill up so its mutationError renders. And invalidate
    // any in-flight load first so a slower getGoal started before the delete can't
    // commit and repopulate the just-cleared goal.
    const ok = await run(async () => {
      await client.deleteGoal(workspaceId, sessionId);
      return true as const;
    });
    if (ok) {
      retireLoads();
      setReadAbsent(true);
      setGoal(null);
      setError(null);
    }
  }, [client, workspaceId, sessionId, run, retireLoads, aimedAtCurrentGoal]);

  return {
    goal: visibleGoal,
    isActive: visibleGoal?.status === "active",
    isPaused: visibleGoal?.status === "paused",
    isCompleted: visibleGoal?.status === "completed",
    loading: loading && retainedGoal === null,
    error,
    refresh: load,
    pause,
    resume,
    clearGoal,
    deleteGoal: clearGoal,
    updating: mutating,
    mutationError,
    clearMutationError,
  };
}
