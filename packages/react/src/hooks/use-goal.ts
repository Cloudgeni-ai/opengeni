import { OpenGeniApiError, type SessionEvent, type SessionGoal } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useDebouncedCallback,
  useMutationRunner,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Event types that change the session goal (set/updated/completed/paused/...). */
export function isGoalEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type.startsWith("goal.");
}

export type UseGoalOptions = ClientOverride &
  SessionEventFeedOptions & {
    /** Optional safety-net polling (ms). Off by default — goal.* events drive updates. */
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
 * `goal: null` (the 404 is absorbed). Live-updates on `goal.*` events —
 * pass `options.events` from `useSessionEvents` to reuse its stream.
 */
export function useGoal(
  sessionId: string | null | undefined,
  options: UseGoalOptions = {},
): UseGoalResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedEvents = options.events;
  const sharedFeed = sharedEvents !== undefined;
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useMutationRunner();
  const generation = useRef(0);
  const targetKeyRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const ticket = ++generation.current;
    try {
      const fetched = await client.getGoal(workspaceId, sessionId);
      if (ticket === generation.current) {
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
        setGoal(null);
        setError(null);
      } else {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
      setLoading(false);
    }
  }, [client, workspaceId, sessionId]);

  useEffect(() => {
    const targetKey = `${workspaceId} ${sessionId ?? ""}`;
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      setGoal(null);
      setError(null);
    }
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (sharedFeed) {
      setLoading(false);
      return () => {
        generation.current += 1;
      };
    }
    setLoading(true);
    void load();
    const pollIntervalMs = options.pollIntervalMs;
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      return () => {
        generation.current += 1;
      };
    }
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [load, enabled, workspaceId, sessionId, options.pollIntervalMs, sharedFeed]);

  const scheduleRefresh = useDebouncedCallback(() => void load());
  useSessionEventTrigger(client, workspaceId, sessionId, isGoalEvent, scheduleRefresh, {
    enabled,
    ...(sharedEvents !== undefined ? { events: sharedEvents } : {}),
  });

  const pause = useCallback(
    async (rationale?: string): Promise<SessionGoal | null> => {
      if (!sessionId) {
        return null;
      }
      const result = await mutation.run(() =>
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
    [client, workspaceId, sessionId, mutation.run],
  );

  const resume = useCallback(async (): Promise<SessionGoal | null> => {
    if (!sessionId) {
      return null;
    }
    const result = await mutation.run(() =>
      client.updateGoal(workspaceId, sessionId, { status: "active" }),
    );
    if (result) {
      setGoal(result);
    }
    return result;
  }, [client, workspaceId, sessionId, mutation.run]);

  const clearGoal = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    // deleteGoal resolves void, so distinguish success (a truthy sentinel) from
    // mutation.run's null-on-failure. Only a SUCCESSFUL delete hides the goal:
    // a failed one leaves the pill up so its mutationError renders. And invalidate
    // any in-flight load first so a slower getGoal started before the delete can't
    // commit and repopulate the just-cleared goal.
    const ok = await mutation.run(async () => {
      await client.deleteGoal(workspaceId, sessionId);
      return true as const;
    });
    if (ok) {
      generation.current += 1;
      setGoal(null);
      setError(null);
    }
  }, [client, workspaceId, sessionId, mutation.run]);

  return {
    goal,
    isActive: goal?.status === "active",
    isPaused: goal?.status === "paused",
    isCompleted: goal?.status === "completed",
    loading,
    error,
    refresh: load,
    pause,
    resume,
    clearGoal,
    deleteGoal: clearGoal,
    updating: mutation.mutating,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}
