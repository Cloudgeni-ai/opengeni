import type { SessionEvent, SessionGoal } from "@opengeni/sdk";
import {
  createGoalStore,
  isGoalEvent as isSdkGoalEvent,
  isGoalRefreshEvent as isSdkGoalRefreshEvent,
} from "@opengeni/sdk/session";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useEmbeddedGoal, type EmbeddedGoalClientOverride } from "../session-context";
import { useOwnedExternalStore, type SessionEventFeedOptions } from "./internal";

/** Event types that change the session goal (set/updated/completed/paused/...). */
export function isGoalEvent(event: Pick<SessionEvent, "type">): boolean {
  return isSdkGoalEvent(event);
}

/** Events that can change the server-authoritative continuation projection. */
export function isGoalRefreshEvent(event: Pick<SessionEvent, "type">): boolean {
  return isSdkGoalRefreshEvent(event);
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

/** React compatibility adapter over the framework-neutral goal controller. */
export function useGoal(
  sessionId: string | null | undefined,
  options: UseGoalOptions = {},
): UseGoalResult {
  const { client, workspaceId } = useEmbeddedGoal(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedFeed = options.events !== undefined;
  const latestEvents = useRef(options.events);
  latestEvents.current = options.events;
  const store = useMemo(
    () =>
      createGoalStore({
        client,
        workspaceId,
        sessionId,
        enabled,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(sharedFeed ? { events: latestEvents.current ?? [] } : {}),
      }),
    [client, enabled, options.pollIntervalMs, sessionId, sharedFeed, workspaceId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);

  useEffect(() => {
    if (options.events !== undefined) store.applyEvents(options.events);
  }, [options.events, store]);

  return {
    goal: snapshot.value,
    isActive: snapshot.isActive,
    isPaused: snapshot.isPaused,
    isCompleted: snapshot.isCompleted,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh: store.refresh,
    pause: store.pause,
    resume: store.resume,
    clearGoal: store.clearGoal,
    deleteGoal: store.clearGoal,
    updating: snapshot.updating,
    mutationError: snapshot.mutationError,
    clearMutationError: store.clearMutationError,
  };
}
