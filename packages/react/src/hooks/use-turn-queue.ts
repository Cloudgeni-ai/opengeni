import type {
  ComposerDraft,
  EffectiveSessionControl,
  McpPersonalConnectionSummary,
  SessionEvent,
  SessionPendingInputPreview,
  SessionQueueSnapshot,
  SessionTurn,
} from "@opengeni/sdk";
import {
  createTurnQueueStore,
  isTurnQueueEvent as isSdkTurnQueueEvent,
  type QueueMutationKind as StoreQueueMutationKind,
} from "@opengeni/sdk/session";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useOwnedExternalStore, type SessionEventFeedOptions } from "./internal";

/** Events that can change the authoritative prompt queue or effective control. */
export function isTurnQueueEvent(event: Pick<SessionEvent, "type">): boolean {
  return isSdkTurnQueueEvent(event);
}

export type QueueMutationKind = StoreQueueMutationKind;

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

/** React compatibility adapter over the framework-neutral authoritative queue controller. */
export function useTurnQueue(
  sessionId: string | null | undefined,
  options: UseTurnQueueOptions = {},
): UseTurnQueueResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useEmbeddedSession(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedFeed = options.events !== undefined;
  const latestEvents = useRef(options.events);
  latestEvents.current = options.events;
  const store = useMemo(
    () =>
      createTurnQueueStore({
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
  useEffect(() => {
    if (enabled && workspaceControlEvent) void store.refresh();
  }, [enabled, store, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "queue", store.refresh);
  }, [enabled, registerSessionReconciler, sessionId, store]);

  return {
    snapshot: snapshot.snapshot,
    queue: snapshot.queue as SessionTurn[],
    pendingInputs: snapshot.pendingInputs as SessionPendingInputPreview[],
    pendingInputAttachment: snapshot.pendingInputAttachment,
    activePersonalConnections: snapshot.activePersonalConnections as McpPersonalConnectionSummary[],
    effectiveControl: snapshot.effectiveControl,
    stoppingPreviousAttempt: snapshot.stoppingPreviousAttempt,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh: store.refresh,
    moveTurn: store.moveTurn,
    editTurn: store.editTurn,
    steerTurn: store.steerTurn,
    removeTurn: store.removeTurn,
    pendingByTurn: snapshot.pendingByTurn,
    mutationFor: store.mutationFor,
    mutating: snapshot.mutating,
    mutationError: snapshot.mutationError,
    clearMutationError: store.clearMutationError,
    acceptedSteers: snapshot.acceptedSteers as AcceptedQueueSteer[],
  };
}
