import type {
  ComposerDraft,
  EffectiveSessionControl,
  SessionEvent,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionTurn,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
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

function queueSnapshotCovers(
  candidate: SessionQueueSnapshot | null,
  observed: SessionQueueSnapshot,
): boolean {
  return Boolean(
    candidate &&
    candidate.version >= observed.version &&
    candidate.effectiveControl.controlVersion >= observed.effectiveControl.controlVersion,
  );
}

export type QueueMutationKind = "move" | "edit" | "steer" | "delete";
const EMPTY_PENDING_BY_TURN: Readonly<Record<string, QueueMutationKind>> = {};

export type UseTurnQueueOptions = EmbeddedSessionClientOverride &
  SessionEventFeedOptions & {
    pollIntervalMs?: number | undefined;
  };

export type UseTurnQueueResult = {
  snapshot: SessionQueueSnapshot | null;
  /** Human/API prompts exactly in server execution order. Never client-sorted. */
  queue: SessionTurn[];
  effectiveControl: EffectiveSessionControl | null;
  /** The latest interrupted attempt has not yet durably proved physical quiescence. */
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
    useEmbeddedSession(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
  const [snapshot, setSnapshot] = useState<SessionQueueSnapshot | null>(null);
  const [stateTargetKey, setStateTargetKey] = useState(targetKey);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [pendingByTurn, setPendingByTurn] = useState<Record<string, QueueMutationKind>>({});
  const pendingRef = useRef<Record<string, QueueMutationKind>>({});
  const readGeneration = useRef(0);
  const targetKeyRef = useRef(targetKey);
  const snapshotRef = useRef<SessionQueueSnapshot | null>(null);

  // Revoke the old target only when the new one commits. A concurrent render
  // may suspend while the previous target remains visible and interactive.
  useLayoutEffect(() => {
    if (targetKeyRef.current === targetKey) return;
    targetKeyRef.current = targetKey;
    readGeneration.current += 1;
    snapshotRef.current = null;
    pendingRef.current = {};
    setStateTargetKey(targetKey);
    setSnapshot(null);
    setLoading(enabled);
    setError(null);
    setMutationError(null);
    setPendingByTurn({});
  }, [enabled, targetKey]);

  const acceptSnapshot = useCallback(
    (ownedTargetKey: string, next: SessionQueueSnapshot | null): boolean => {
      if (targetKeyRef.current !== ownedTargetKey) return false;
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
      setStateTargetKey(ownedTargetKey);
      setSnapshot(next);
      return true;
    },
    [],
  );

  const load = useCallback(
    async (rejectOnFailure = false): Promise<void> => {
      if (!sessionId) return;
      const ownedTargetKey = `${workspaceId}\u0000${sessionId}`;
      const ticket = ++readGeneration.current;
      try {
        const fetched = await client.getQueue(workspaceId, sessionId);
        if (targetKeyRef.current !== ownedTargetKey) return;
        const ownsLatestRead = ticket === readGeneration.current;
        if (rejectOnFailure) {
          const committed = acceptSnapshot(ownedTargetKey, fetched);
          if (!committed && !queueSnapshotCovers(snapshotRef.current, fetched)) {
            throw new TypeError("Queue reconciliation did not commit authoritative state");
          }
          setError(null);
          if (ownsLatestRead) setLoading(false);
        } else if (ownsLatestRead) {
          acceptSnapshot(ownedTargetKey, fetched);
          setError(null);
          setLoading(false);
        }
      } catch (cause) {
        if (
          targetKeyRef.current === ownedTargetKey &&
          (ticket === readGeneration.current || rejectOnFailure)
        ) {
          setError(asError(cause));
          if (ticket === readGeneration.current) setLoading(false);
        }
        if (rejectOnFailure) throw cause;
      }
    },
    [client, workspaceId, sessionId, acceptSnapshot],
  );

  useEffect(() => {
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
  }, [load, enabled, options.pollIntervalMs]);

  useEffect(() => {
    if (enabled && workspaceControlEvent) void load();
  }, [enabled, load, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "queue", load);
  }, [enabled, load, registerSessionReconciler, sessionId]);

  const scheduleRefresh = useDebouncedCallback(() => void load());
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isTurnQueueEvent,
    scheduleRefresh,
    {
      enabled,
      ...(options.events !== undefined ? { events: options.events } : {}),
    },
    async () => await load(true),
  );

  const mutate = useCallback(
    async (
      turnId: string,
      kind: QueueMutationKind,
      command: (
        current: SessionQueueSnapshot,
        turn: SessionTurn,
      ) => Promise<SessionQueueMutationResponse>,
    ): Promise<SessionQueueMutationResponse | null> => {
      const ownedTargetKey = targetKey;
      if (!sessionId || targetKeyRef.current !== ownedTargetKey || pendingRef.current[turnId]) {
        return null;
      }
      const current = snapshotRef.current;
      const turn = current?.items.find((candidate) => candidate.id === turnId);
      if (!current || !turn) return null;
      pendingRef.current = { ...pendingRef.current, [turnId]: kind };
      setStateTargetKey(ownedTargetKey);
      setPendingByTurn(pendingRef.current);
      setMutationError(null);
      try {
        const result = await command(current, turn);
        if (targetKeyRef.current !== ownedTargetKey) return null;
        acceptSnapshot(ownedTargetKey, result.snapshot);
        return result;
      } catch (cause) {
        if (targetKeyRef.current === ownedTargetKey) {
          setMutationError(asError(cause));
          await load();
        }
        return null;
      } finally {
        if (targetKeyRef.current === ownedTargetKey && turnId in pendingRef.current) {
          const next = { ...pendingRef.current };
          delete next[turnId];
          pendingRef.current = next;
          setPendingByTurn(next);
        }
      }
    },
    [acceptSnapshot, load, sessionId, targetKey],
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

  const identityMatches = stateTargetKey === targetKey;
  const visibleSnapshot = identityMatches ? snapshot : null;
  const visiblePendingByTurn = identityMatches ? pendingByTurn : EMPTY_PENDING_BY_TURN;
  const mutating = useMemo(
    () => Object.keys(visiblePendingByTurn).length > 0,
    [visiblePendingByTurn],
  );
  const mutationFor = useCallback(
    (turnId: string): QueueMutationKind | null => visiblePendingByTurn[turnId] ?? null,
    [visiblePendingByTurn],
  );

  return {
    snapshot: visibleSnapshot,
    queue: visibleSnapshot?.items ?? [],
    effectiveControl: visibleSnapshot?.effectiveControl ?? null,
    stoppingPreviousAttempt: visibleSnapshot?.stoppingPreviousAttempt ?? false,
    loading: identityMatches ? loading : enabled,
    error: identityMatches ? error : null,
    refresh: load,
    moveTurn,
    editTurn,
    steerTurn,
    removeTurn,
    pendingByTurn: visiblePendingByTurn,
    mutationFor,
    mutating,
    mutationError: identityMatches ? mutationError : null,
    clearMutationError: useCallback(() => {
      if (targetKeyRef.current === targetKey) setMutationError(null);
    }, [targetKey]),
  };
}

function operationKey(): string {
  return globalThis.crypto.randomUUID();
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
