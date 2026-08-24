import type {
  ComposerDraft,
  EffectiveSessionControl,
  McpPersonalConnectionSummary,
  SessionEvent,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionPendingInputPreview,
  SessionTurn,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import {
  useDebouncedCallback,
  usePageLiveActivity,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

/** Events that can change the authoritative prompt queue or effective control. */
export function isTurnQueueEvent(event: Pick<SessionEvent, "type">): boolean {
  return (
    event.type.startsWith("turn.") ||
    event.type.startsWith("session.queue.") ||
    event.type.startsWith("session.control.") ||
    event.type.startsWith("system.update.") ||
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

export type AcceptedQueueSteer = {
  turnId: string;
  triggerEventId: string;
  text: string;
  annotations: SessionTurn["annotations"];
  resources: SessionTurn["resources"];
  tools: SessionTurn["tools"];
  occurredAt: string;
  state: "sending" | "queued";
};

export type UseTurnQueueOptions = EmbeddedSessionClientOverride &
  SessionEventFeedOptions & {
    pollIntervalMs?: number | undefined;
  };

export type UseTurnQueueResult = {
  snapshot: SessionQueueSnapshot | null;
  /** Human/API prompts exactly in server execution order. Never client-sorted. */
  queue: SessionTurn[];
  /** Canonical pending machine inputs. Events only trigger an authoritative refresh. */
  pendingInputs: SessionPendingInputPreview[];
  /** Exact pending members projected to join an already-waiting prompt. */
  pendingInputAttachment: SessionQueueSnapshot["pendingInputAttachment"];
  /** Secret-safe personal MCP summaries frozen on the exact active turn. */
  activePersonalConnections: McpPersonalConnectionSummary[];
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
  /** Immediate chat bridge while the durable Steer event catches up over SSE. */
  acceptedSteers?: AcceptedQueueSteer[] | undefined;
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
  const pageLive = usePageLiveActivity();
  const [snapshot, setSnapshot] = useState<SessionQueueSnapshot | null>(null);
  const [stateTargetKey, setStateTargetKey] = useState(targetKey);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [pendingByTurn, setPendingByTurn] = useState<Record<string, QueueMutationKind>>({});
  const [acceptedSteers, setAcceptedSteers] = useState<AcceptedQueueSteer[]>([]);
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
    setAcceptedSteers([]);
  }, [enabled, targetKey]);

  useEffect(() => {
    if (acceptedSteers.length === 0 || options.events === undefined) return;
    const durablyStartedTurnIds = new Set(
      options.events.flatMap((event) =>
        event.type === "turn.started" && event.turnId ? [event.turnId] : [],
      ),
    );
    if (durablyStartedTurnIds.size === 0) return;
    // steer_requested can reach the browser before the timeline projection
    // that moves the queued user.message into chat. Keep this bridge through
    // physical cancellation; turn.started is the first boundary at which the
    // replacement timeline must already be visible.
    setAcceptedSteers((current) =>
      current.filter((steer) => !durablyStartedTurnIds.has(steer.turnId)),
    );
  }, [acceptedSteers.length, options.events]);

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
    if (!enabled || !pageLive) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const pollIntervalMs = options.pollIntervalMs;
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      void load();
      return () => {
        readGeneration.current += 1;
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
      readGeneration.current += 1;
    };
  }, [load, enabled, pageLive, options.pollIntervalMs]);

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
        clientEventId: string,
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
      const clientEventId = operationKey();
      try {
        let result: SessionQueueMutationResponse;
        try {
          result = await command(current, turn, clientEventId);
        } catch (cause) {
          if (!isOutcomeUnknownError(cause)) throw cause;
          // Same-key replay is a fact check against the durable receipt. It
          // cannot duplicate the command even if the first response was lost.
          result = await command(current, turn, clientEventId);
        }
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
      const result = await mutate(turnId, "move", (current, _turn, clientEventId) =>
        client.moveQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId,
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
      const result = await mutate(turnId, "edit", (_current, turn, clientEventId) =>
        client.editQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId,
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
      const ownedTargetKey = targetKey;
      const turn = snapshotRef.current?.items.find((candidate) => candidate.id === turnId);
      if (targetKeyRef.current !== ownedTargetKey) return false;
      if (!turn) {
        setMutationError(new Error("That queued prompt changed before Steer could be sent."));
        await load();
        return false;
      }
      const optimistic: AcceptedQueueSteer = {
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        text: turn.prompt,
        annotations: turn.annotations ?? [],
        resources: turn.resources,
        tools: turn.tools,
        occurredAt: new Date().toISOString(),
        state: "sending",
      };
      setAcceptedSteers((current) => [
        ...current.filter((steer) => steer.turnId !== turnId),
        optimistic,
      ]);
      const result = await mutate(turnId, "steer", (current, queuedTurn, clientEventId) =>
        client.steerQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId,
          expectedTurnVersion: queuedTurn.version,
          controlEtag: current.effectiveControl.controlEtag,
        }),
      );
      if (targetKeyRef.current !== ownedTargetKey) return false;
      // The active turn can finish while the operator clicks Steer. In that
      // race the queued prompt is atomically claimed before the steer command,
      // so the command conflicts but the user's prompt already advanced into
      // chat. Reconciled absence is success, not a scary unknown-outcome lie.
      const advancedWithoutSteer =
        result === null &&
        snapshotRef.current !== null &&
        !snapshotRef.current.items.some((candidate) => candidate.id === turnId);
      if (advancedWithoutSteer) {
        setMutationError(null);
        setAcceptedSteers((current) => current.filter((steer) => steer.turnId !== turnId));
        return true;
      }
      const accepted =
        result !== null ||
        snapshotRef.current?.items.some(
          (candidate) => candidate.id === turnId && candidate.metadata.delivery === "steer",
        ) === true;
      setAcceptedSteers((current) =>
        accepted
          ? current.map((steer) =>
              steer.turnId === turnId ? { ...steer, state: "queued" as const } : steer,
            )
          : current.filter((steer) => steer.turnId !== turnId),
      );
      return accepted;
    },
    [client, load, mutate, sessionId, targetKey, workspaceId],
  );

  const removeTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      const result = await mutate(turnId, "delete", (_current, turn, clientEventId) =>
        client.deleteQueueItem(workspaceId, sessionId!, turnId, {
          clientEventId,
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
    pendingInputs: visibleSnapshot?.pendingInputs ?? [],
    pendingInputAttachment: visibleSnapshot?.pendingInputAttachment ?? null,
    activePersonalConnections: visibleSnapshot?.activePersonalConnections ?? [],
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
    acceptedSteers: identityMatches ? acceptedSteers : [],
  };
}

function operationKey(): string {
  return globalThis.crypto.randomUUID();
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isOutcomeUnknownError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}
