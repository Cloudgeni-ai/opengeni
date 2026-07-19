import type {
  ComposerDraft,
  EffectiveSessionControl,
  SessionEvent,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionTurn,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import {
  useDebouncedCallback,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Events that can change the authoritative prompt queue or effective control. */
export function isTurnQueueEvent(event: Pick<SessionEvent, "type">): boolean {
  return (
    event.type.startsWith("turn.") ||
    event.type.startsWith("session.queue.") ||
    event.type.startsWith("session.control.") ||
    event.type.startsWith("workspace.inference.")
  );
}

export type QueueMutationKind = "move" | "edit" | "steer" | "delete";

export type UseTurnQueueOptions = ClientOverride &
  SessionEventFeedOptions & {
    pollIntervalMs?: number | undefined;
  };

export type UseTurnQueueResult = {
  snapshot: SessionQueueSnapshot | null;
  /** Human/API prompts exactly in server execution order. Never client-sorted. */
  queue: SessionTurn[];
  effectiveControl: EffectiveSessionControl | null;
  /** Saved queue work is waiting only for its predecessor to reach quiescence. */
  stoppingPreviousAttempt: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  moveTurn: (turnId: string, beforeTurnId: string | null) => Promise<boolean>;
  /** Atomically withdraw a waiting prompt into the private durable composer draft. */
  editTurn: (
    turnId: string,
    options: { expectedDraftRevision: number; replaceDraft: boolean },
  ) => Promise<ComposerDraft | null>;
  /** Advance the same durable waiting prompt; no duplicate prompt is created. */
  steerTurn: (turnId: string) => Promise<boolean>;
  removeTurn: (turnId: string) => Promise<boolean>;
  pendingByTurn: Readonly<Record<string, QueueMutationKind>>;
  mutationFor: (turnId: string) => QueueMutationKind | null;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * The one authoritative human prompt queue. Every mutation carries the exact
 * server versions the operator saw and accepts only monotonic snapshots. A
 * conflict immediately reloads server truth; the client never invents order.
 */
export function useTurnQueue(
  sessionId: string | null | undefined,
  options: UseTurnQueueOptions = {},
): UseTurnQueueResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const [snapshot, setSnapshot] = useState<SessionQueueSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [pendingByTurn, setPendingByTurn] = useState<Record<string, QueueMutationKind>>({});
  const pendingRef = useRef<Record<string, QueueMutationKind>>({});
  const readGeneration = useRef(0);
  const targetKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef<SessionQueueSnapshot | null>(null);

  const acceptSnapshot = useCallback((next: SessionQueueSnapshot | null): boolean => {
    const current = snapshotRef.current;
    if (
      next &&
      current &&
      (next.version < current.version ||
        next.effectiveControl.controlVersion < current.effectiveControl.controlVersion)
    ) {
      return false;
    }
    snapshotRef.current = next;
    setSnapshot(next);
    return true;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    const ticket = ++readGeneration.current;
    try {
      const fetched = await client.getQueue(workspaceId, sessionId);
      if (ticket === readGeneration.current) {
        acceptSnapshot(fetched);
        setError(null);
        setLoading(false);
      }
    } catch (cause) {
      if (ticket === readGeneration.current) {
        setError(asError(cause));
        setLoading(false);
      }
    }
  }, [client, workspaceId, sessionId, acceptSnapshot]);

  useEffect(() => {
    const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      readGeneration.current += 1;
      acceptSnapshot(null);
      setError(null);
      setMutationError(null);
      setPendingByTurn({});
      pendingRef.current = {};
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
        readGeneration.current += 1;
      };
    }
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => {
      clearInterval(timer);
      readGeneration.current += 1;
    };
  }, [load, enabled, workspaceId, sessionId, options.pollIntervalMs, acceptSnapshot]);

  useEffect(() => {
    if (enabled && workspaceControlEvent) void load();
  }, [enabled, load, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "queue", load);
  }, [enabled, load, registerSessionReconciler, sessionId]);

  const scheduleRefresh = useDebouncedCallback(() => void load());
  useSessionEventTrigger(client, workspaceId, sessionId, isTurnQueueEvent, scheduleRefresh, {
    enabled,
    ...(options.events !== undefined ? { events: options.events } : {}),
  });

  const mutate = useCallback(
    async (
      turnId: string,
      kind: QueueMutationKind,
      command: (
        current: SessionQueueSnapshot,
        turn: SessionTurn,
      ) => Promise<SessionQueueMutationResponse>,
    ): Promise<SessionQueueMutationResponse | null> => {
      if (!sessionId || pendingRef.current[turnId]) return null;
      const current = snapshotRef.current;
      const turn = current?.items.find((candidate) => candidate.id === turnId);
      if (!current || !turn) return null;
      pendingRef.current = { ...pendingRef.current, [turnId]: kind };
      setPendingByTurn(pendingRef.current);
      setMutationError(null);
      try {
        const result = await command(current, turn);
        acceptSnapshot(result.snapshot);
        return result;
      } catch (cause) {
        setMutationError(asError(cause));
        await load();
        return null;
      } finally {
        if (turnId in pendingRef.current) {
          const next = { ...pendingRef.current };
          delete next[turnId];
          pendingRef.current = next;
          setPendingByTurn(next);
        }
      }
    },
    [acceptSnapshot, load, sessionId],
  );

  const moveTurn = useCallback(
    async (turnId: string, beforeTurnId: string | null): Promise<boolean> => {
      const result = await mutate(turnId, "move", (current) =>
        client.moveQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId: operationKey(),
          expectedQueueVersion: current.version,
          beforeTurnId,
        }),
      );
      return result !== null;
    },
    [client, mutate, sessionId, workspaceId],
  );

  const editTurn = useCallback(
    async (
      turnId: string,
      edit: { expectedDraftRevision: number; replaceDraft: boolean },
    ): Promise<ComposerDraft | null> => {
      const result = await mutate(turnId, "edit", (_current, turn) =>
        client.editQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId: operationKey(),
          expectedTurnVersion: turn.version,
          expectedDraftRevision: edit.expectedDraftRevision,
          replaceDraft: edit.replaceDraft,
        }),
      );
      return result?.draft ?? null;
    },
    [client, mutate, sessionId, workspaceId],
  );

  const steerTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      const result = await mutate(turnId, "steer", (current, turn) =>
        client.steerQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId: operationKey(),
          expectedTurnVersion: turn.version,
          controlEtag: current.effectiveControl.controlEtag,
        }),
      );
      return result !== null;
    },
    [client, mutate, sessionId, workspaceId],
  );

  const removeTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      const result = await mutate(turnId, "delete", (_current, turn) =>
        client.deleteQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId: operationKey(),
          expectedTurnVersion: turn.version,
          reason: "Deleted from the prompt queue",
        }),
      );
      return result !== null;
    },
    [client, mutate, sessionId, workspaceId],
  );

  const mutationFor = useCallback(
    (turnId: string): QueueMutationKind | null => pendingByTurn[turnId] ?? null,
    [pendingByTurn],
  );
  const mutating = useMemo(() => Object.keys(pendingByTurn).length > 0, [pendingByTurn]);

  return {
    snapshot,
    queue: snapshot?.items ?? [],
    effectiveControl: snapshot?.effectiveControl ?? null,
    stoppingPreviousAttempt: snapshot?.stoppingPreviousAttempt ?? false,
    loading,
    error,
    refresh: load,
    moveTurn,
    editTurn,
    steerTurn,
    removeTurn,
    pendingByTurn,
    mutationFor,
    mutating,
    mutationError,
    clearMutationError: useCallback(() => setMutationError(null), []),
  };
}

function operationKey(): string {
  return globalThis.crypto.randomUUID();
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
