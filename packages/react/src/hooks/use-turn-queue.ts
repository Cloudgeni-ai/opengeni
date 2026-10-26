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
import { isTransientRequestError } from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { normalizeError } from "../lib/error-message";
import { deniesRetainedView, useRetainedSessionView } from "./session-view-cache";
import {
  DEFAULT_TRANSIENT_READ_RETRY,
  projectionReadThrough,
  transientReadRetryStep,
  useDebouncedCallback,
  usePageLiveActivity,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";
import { useOpenGeniText } from "../messages/runtime";

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

/** Outcome of withdrawing one waiting prompt back into an empty composer. */
export type QueueRecallResult =
  | { status: "recalled"; draft: ComposerDraft }
  /** The prompt left the queue first (the agent took it); nothing changed. */
  | { status: "already_sent" }
  /** Anything else (offline, draft changed, a mutation in flight); the queue shows why. */
  | { status: "failed" };

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
  /**
   * Withdraw a waiting prompt into an empty durable composer draft. Losing the
   * race to the agent is a quiet `already_sent`, not a queue error.
   */
  recallTurn?: (
    turnId: string,
    options: { expectedDraftRevision: number },
  ) => Promise<QueueRecallResult>;
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
  const t = useOpenGeniText();
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useEmbeddedSession(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
  const pageLive = usePageLiveActivity();
  const pageLiveRef = useRef(pageLive);
  pageLiveRef.current = pageLive;
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
  // A deploy or maintenance window makes queue reads fail for a while. Keep
  // the last queue on screen and retry quietly; only a failure that outlasts
  // the quiet window (or a definitive one) becomes the queue's error.
  const transientStreakRef = useRef<{ since: number; attempts: number; surfaced: boolean } | null>(
    null,
  );
  const transientRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTransientRetry = useCallback(() => {
    if (transientRetryTimerRef.current !== null) {
      clearTimeout(transientRetryTimerRef.current);
      transientRetryTimerRef.current = null;
    }
  }, []);

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
    transientStreakRef.current = null;
    cancelTransientRetry();
    setMutationError(null);
    setPendingByTurn({});
    setAcceptedSteers([]);
  }, [cancelTransientRetry, enabled, targetKey]);

  useEffect(() => {
    if (acceptedSteers.length === 0 || options.events === undefined) return;
    const durablyConsumedTurnIds = new Set(
      options.events.flatMap((event) =>
        [
          "turn.started",
          "turn.superseded",
          "turn.cancelled",
          "turn.failed",
          "turn.completed",
        ].includes(event.type) && event.turnId
          ? [event.turnId]
          : [],
      ),
    );
    if (durablyConsumedTurnIds.size === 0) return;
    // steer_requested can reach the browser before the timeline projection
    // that moves the queued user.message into chat. Keep this bridge through
    // physical cancellation. Starting or settling that exact queued turn
    // proves the durable timeline has taken ownership (including batched Steers).
    setAcceptedSteers((current) =>
      current.filter((steer) => !durablyConsumedTurnIds.has(steer.turnId)),
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
        transientStreakRef.current = null;
        cancelTransientRetry();
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
          if (isTransientRequestError(cause)) {
            const now = Date.now();
            const streak = (transientStreakRef.current ??= {
              since: now,
              attempts: 0,
              surfaced: false,
            });
            const step = transientReadRetryStep(streak, now, DEFAULT_TRANSIENT_READ_RETRY, cause);
            if (!step.quiet) {
              // One stable error per streak; background retries stay silent.
              if (!streak.surfaced) setError(asError(cause));
              streak.surfaced = true;
              if (ticket === readGeneration.current) setLoading(false);
            }
            // A reconciliation read is retried by its caller; a hidden page
            // reads again when it is shown.
            if (!rejectOnFailure && pageLiveRef.current) {
              cancelTransientRetry();
              transientRetryTimerRef.current = setTimeout(() => {
                transientRetryTimerRef.current = null;
                if (targetKeyRef.current === ownedTargetKey) void loadRef.current();
              }, step.delayMs);
            }
          } else {
            transientStreakRef.current = null;
            setError(asError(cause));
            if (ticket === readGeneration.current) setLoading(false);
          }
        }
        if (rejectOnFailure) throw cause;
      }
    },
    [client, workspaceId, sessionId, acceptSnapshot, cancelTransientRetry],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => cancelTransientRetry, [cancelTransientRetry]);

  useEffect(() => {
    if (!enabled || !pageLive) {
      // A hidden page does not keep retrying; it reads again when shown.
      cancelTransientRetry();
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
  }, [cancelTransientRetry, load, enabled, pageLive, options.pollIntervalMs]);

  useEffect(() => {
    if (enabled && workspaceControlEvent) void load();
  }, [enabled, load, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "queue", load);
  }, [enabled, load, registerSessionReconciler, sessionId]);

  const scheduleRefresh = useDebouncedCallback(() => void load());
  const freshSnapshot = stateTargetKey === targetKey ? snapshot : null;
  const freshLoading = stateTargetKey === targetKey ? loading : enabled;
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isTurnQueueEvent,
    scheduleRefresh,
    {
      enabled,
      ...(options.events !== undefined ? { events: options.events } : {}),
      readThrough: projectionReadThrough(freshSnapshot, freshLoading),
      refresh: scheduleRefresh,
    },
    async () => await load(true),
  );
  // Until the first read lands, show the queue as it was when this
  // conversation was last left (only when the host retains reads). Commands
  // still act only on a fresh snapshot.
  const retainedSnapshot = useRetainedSessionView(
    client,
    workspaceId,
    sessionId,
    "queue",
    freshSnapshot,
    { enabled, discard: stateTargetKey === targetKey && deniesRetainedView(error) },
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
      failure: { quietWhenGone?: boolean } = {},
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
          if (failure.quietWhenGone) {
            // Reconcile first: a prompt that already left the queue is the
            // caller's quiet outcome, never a flash of queue error.
            await load();
            const stillWaiting = snapshotRef.current?.items.some(
              (candidate) => candidate.id === turnId,
            );
            if (stillWaiting !== false && targetKeyRef.current === ownedTargetKey) {
              setMutationError(asError(cause));
            }
          } else {
            setMutationError(asError(cause));
            await load();
          }
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

  const recallTurn = useCallback(
    async (
      turnId: string,
      recall: { expectedDraftRevision: number },
    ): Promise<QueueRecallResult> => {
      const ownedTargetKey = targetKey;
      const known = snapshotRef.current?.items.some((candidate) => candidate.id === turnId);
      if (known === false) return { status: "already_sent" };
      const result = await mutate(
        turnId,
        "edit",
        (_current, turn, clientEventId) =>
          client.editQueueItem(workspaceId, sessionId!, turnId, {
            clientEventId,
            expectedTurnVersion: turn.version,
            expectedDraftRevision: recall.expectedDraftRevision,
            replaceDraft: false,
          }),
        { quietWhenGone: true },
      );
      if (targetKeyRef.current !== ownedTargetKey) return { status: "failed" };
      if (result?.draft) return { status: "recalled", draft: result.draft };
      const stillWaiting = snapshotRef.current?.items.some((candidate) => candidate.id === turnId);
      return result === null && stillWaiting === false
        ? { status: "already_sent" }
        : { status: "failed" };
    },
    [client, mutate, sessionId, targetKey, workspaceId],
  );

  const steerTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      const ownedTargetKey = targetKey;
      const turn = snapshotRef.current?.items.find((candidate) => candidate.id === turnId);
      if (targetKeyRef.current !== ownedTargetKey) return false;
      if (!turn) {
        setMutationError(new Error(t("hooks.useTurnQueue.thatQueuedPromptChangedBefore")));
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
    [client, load, mutate, sessionId, targetKey, workspaceId, t],
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
  const visibleSnapshot = freshSnapshot ?? retainedSnapshot;
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
    loading: freshLoading && retainedSnapshot === null,
    error: identityMatches ? error : null,
    refresh: load,
    moveTurn,
    editTurn,
    recallTurn,
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
  return normalizeError(cause);
}

function isOutcomeUnknownError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}
