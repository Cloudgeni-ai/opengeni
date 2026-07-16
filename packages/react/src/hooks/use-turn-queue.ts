import type { SessionEvent, SessionQueueSnapshot, SessionTurn } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useDebouncedCallback,
  useMutationRunner,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Events that can change the authoritative prompt queue or its pause gates. */
export function isTurnQueueEvent(event: Pick<SessionEvent, "type">): boolean {
  return (
    event.type.startsWith("turn.") ||
    event.type.startsWith("session.queue.") ||
    event.type.startsWith("session.control.") ||
    event.type.startsWith("workspace.inference.")
  );
}

export type UseTurnQueueOptions = ClientOverride &
  SessionEventFeedOptions & {
    pollIntervalMs?: number | undefined;
  };

export type UseTurnQueueResult = {
  snapshot: SessionQueueSnapshot | null;
  /** Human/API prompts exactly in server execution order. Never client-sorted. */
  queue: SessionTurn[];
  controlState: SessionQueueSnapshot["controlState"] | null;
  controlGeneration: number | null;
  workspaceInferenceState: SessionQueueSnapshot["workspaceInferenceState"] | null;
  workspaceInferenceGeneration: number | null;
  workspaceRunExceptionGeneration: number | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Delete a waiting prompt before the worker claims it. */
  removeTurn: (turnId: string) => Promise<boolean>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * The single authoritative waiting-prompt queue. The server owns ordering; the
 * client renders the returned array verbatim and supports deletion only.
 */
export function useTurnQueue(
  sessionId: string | null | undefined,
  options: UseTurnQueueOptions = {},
): UseTurnQueueResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const [snapshot, setSnapshot] = useState<SessionQueueSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner();
  const generation = useRef(0);
  const targetKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef<SessionQueueSnapshot | null>(null);

  const replaceSnapshot = useCallback((next: SessionQueueSnapshot | null): void => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    const ticket = ++generation.current;
    try {
      const fetched = await client.getQueue(workspaceId, sessionId);
      if (ticket === generation.current) {
        replaceSnapshot(fetched);
        setError(null);
        setLoading(false);
      }
    } catch (cause) {
      if (ticket === generation.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setLoading(false);
      }
    }
  }, [client, workspaceId, sessionId, replaceSnapshot]);

  useEffect(() => {
    const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      replaceSnapshot(null);
      setError(null);
    }
    if (!enabled) {
      setLoading(false);
      return;
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
  }, [load, enabled, workspaceId, sessionId, options.pollIntervalMs, replaceSnapshot]);

  const scheduleRefresh = useDebouncedCallback(() => void load());
  useSessionEventTrigger(client, workspaceId, sessionId, isTurnQueueEvent, scheduleRefresh, {
    enabled,
    ...(options.events !== undefined ? { events: options.events } : {}),
  });

  const removeTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      if (!sessionId) return false;
      const current = snapshotRef.current;
      const item = current?.items.find((turn) => turn.id === turnId);
      if (!current || !item) return false;
      const result = await run(() =>
        client.cancelQueueItem(workspaceId, sessionId, turnId, {
          expectedQueueVersion: current.version,
          expectedItemVersion: item.version,
        }),
      );
      if (!result) {
        void load();
        return false;
      }
      replaceSnapshot(result.snapshot);
      return true;
    },
    [client, workspaceId, sessionId, run, load, replaceSnapshot],
  );

  return {
    snapshot,
    queue: snapshot?.items ?? [],
    controlState: snapshot?.controlState ?? null,
    controlGeneration: snapshot?.controlGeneration ?? null,
    workspaceInferenceState: snapshot?.workspaceInferenceState ?? null,
    workspaceInferenceGeneration: snapshot?.workspaceInferenceGeneration ?? null,
    workspaceRunExceptionGeneration: snapshot?.workspaceRunExceptionGeneration ?? null,
    loading,
    error,
    refresh: load,
    removeTurn,
    mutating,
    mutationError,
    clearMutationError,
  };
}
