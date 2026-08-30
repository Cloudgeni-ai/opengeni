import type {
  ComposerDraft,
  EffectiveSessionControl,
  McpPersonalConnectionSummary,
  SessionEvent,
  SessionPendingInputPreview,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionTurn,
} from "../types";
import type { SessionClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  createDebouncedTask,
  createPageActivity,
  createPoller,
  createSessionEventCursor,
  createSessionEventTail,
} from "./live";
import { asError, isOutcomeUnknownError } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export function isTurnQueueEvent(event: { type: string }): boolean {
  return (
    event.type.startsWith("turn.") ||
    event.type.startsWith("session.queue.") ||
    event.type.startsWith("session.control.") ||
    event.type.startsWith("system.update.") ||
    event.type.startsWith("workspace.inference.")
  );
}

export type QueueMutationKind = "move" | "edit" | "steer" | "delete";

export type AcceptedQueueSteer = Readonly<{
  turnId: string;
  triggerEventId: string;
  text: string;
  annotations: SessionTurn["annotations"];
  resources: SessionTurn["resources"];
  tools: SessionTurn["tools"];
  occurredAt: string;
  state: "sending" | "queued";
}>;

export type TurnQueueStoreSnapshot = Readonly<{
  snapshot: SessionQueueSnapshot | null;
  queue: readonly SessionTurn[];
  pendingInputs: readonly SessionPendingInputPreview[];
  pendingInputAttachment: SessionQueueSnapshot["pendingInputAttachment"];
  activePersonalConnections: readonly McpPersonalConnectionSummary[];
  effectiveControl: EffectiveSessionControl | null;
  stoppingPreviousAttempt: boolean;
  loading: boolean;
  error: Error | null;
  pendingByTurn: Readonly<Record<string, QueueMutationKind>>;
  mutating: boolean;
  mutationError: Error | null;
  acceptedSteers: readonly AcceptedQueueSteer[];
}>;

export type TurnQueueStore = OpenGeniExternalStore<TurnQueueStoreSnapshot> & {
  refresh(): Promise<void>;
  /** Apply the latest retained shared event window without replaying its mounted history. */
  applyEvents(events: readonly SessionEvent[]): void;
  moveTurn(turnId: string, beforeTurnId: string | null): Promise<boolean>;
  editTurn(
    turnId: string,
    options: { expectedDraftRevision: number; replaceDraft: boolean },
  ): Promise<ComposerDraft | null>;
  steerTurn(turnId: string): Promise<boolean>;
  removeTurn(turnId: string): Promise<boolean>;
  mutationFor(turnId: string): QueueMutationKind | null;
  clearMutationError(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createTurnQueueStore(options: {
  client: Pick<
    SessionClientLike,
    | "getSession"
    | "streamEvents"
    | "getQueue"
    | "moveQueueItem"
    | "editQueueItem"
    | "steerQueueItem"
    | "deleteQueueItem"
  >;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
  /** A retained shared event window. Omit it to let the controller own a session stream. */
  events?: readonly SessionEvent[];
  eventDebounceMs?: number;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): TurnQueueStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const sharedFeed = options.events !== undefined;
  let generation = 0;
  let activityGeneration = 0;
  let latestSharedEvents = options.events ?? [];
  let authoritative: SessionQueueSnapshot | null = null;
  const pendingKeys = new Map<string, { kind: QueueMutationKind; key: string }>();

  const store = createExternalStore<TurnQueueStoreSnapshot>({
    initialSnapshot: project(null, enabled, null, {}, null, []),
    start: async () => {
      if (!enabled) {
        store.publish(project(null, false, null, {}, null, []));
        return;
      }
      activity.start();
      await activate();
    },
    destroy: () => {
      generation += 1;
      activityGeneration += 1;
      pendingKeys.clear();
      poller.clear();
      eventRefresh.clear();
      eventTail.stop();
      activity.destroy();
    },
  });

  const publish = (patch: Partial<TurnQueueStoreSnapshot> = {}) => {
    const current = store.getSnapshot();
    store.publish({
      ...project(
        authoritative,
        patch.loading ?? current.loading,
        patch.error === undefined ? current.error : patch.error,
        Object.fromEntries([...pendingKeys].map(([turnId, pending]) => [turnId, pending.kind])),
        patch.mutationError === undefined ? current.mutationError : patch.mutationError,
        patch.acceptedSteers ?? current.acceptedSteers,
      ),
      ...patch,
    });
  };

  const accept = (next: SessionQueueSnapshot): boolean => {
    if (
      authoritative &&
      (next.version < authoritative.version ||
        next.effectiveControl.controlVersion < authoritative.effectiveControl.controlVersion)
    ) {
      return false;
    }
    authoritative = next;
    return true;
  };

  const load = async (rejectOnFailure = false): Promise<void> => {
    if (!enabled || store.signal.aborted) return;
    const ticket = ++generation;
    try {
      const snapshot = await store.trackRead(() =>
        options.client.getQueue(options.workspaceId, sessionId),
      );
      if (store.signal.aborted) return;
      const ownsLatestRead = ticket === generation;
      if (rejectOnFailure) {
        const committed = accept(snapshot);
        if (!committed && !queueSnapshotCovers(authoritative, snapshot)) {
          throw new TypeError("Queue reconciliation did not commit authoritative state");
        }
        publish({ ...(ownsLatestRead ? { loading: false } : {}), error: null });
      } else if (ownsLatestRead) {
        accept(snapshot);
        publish({ loading: false, error: null });
      }
    } catch (cause) {
      if (!store.signal.aborted && (ticket === generation || rejectOnFailure)) {
        publish({ ...(ticket === generation ? { loading: false } : {}), error: asError(cause) });
      }
      if (rejectOnFailure) throw cause;
    }
  };

  const refresh = async (): Promise<void> => await load();

  const activate = async (): Promise<void> => {
    if (!enabled || !activity.isLive() || store.signal.aborted) return;
    const ownedActivity = ++activityGeneration;
    poller.clear();
    publish({ loading: true });
    const initialRead = load();
    if (sharedFeed) processSharedEvents(latestSharedEvents);
    else eventTail.start();
    await initialRead;
    if (ownedActivity !== activityGeneration || !activity.isLive() || store.signal.aborted) return;
    poller.schedule();
  };

  const deactivate = (): void => {
    activityGeneration += 1;
    generation += 1;
    poller.clear();
    eventRefresh.clear();
    eventTail.stop();
    publish({ loading: false });
  };

  const activity = createPageActivity({
    store,
    environment,
    hiddenGraceMs: options.hiddenGraceMs,
    activate: () => void activate(),
    deactivate,
  });
  const poller = createPoller({
    store,
    environment,
    delayMs: options.pollIntervalMs,
    enabled: () => activity.isLive() && !store.signal.aborted,
    run: load,
  });
  const eventRefresh = createDebouncedTask({
    store,
    environment,
    delayMs: options.eventDebounceMs,
    enabled: () => activity.isLive() && !store.signal.aborted,
    run: () => void load(),
  });
  const eventCursor = createSessionEventCursor();

  const processSharedEvents = (events: readonly SessionEvent[]): void => {
    if (!sharedFeed || !activity.isLive() || store.signal.aborted) return;
    eventCursor.apply(
      events,
      (event) => {
        if (isTurnQueueEvent(event)) eventRefresh.schedule();
      },
      (window) => {
        for (let index = window.length - 1; index >= 0; index -= 1) {
          const event = window[index];
          if (event && isTurnQueueEvent(event)) {
            eventRefresh.schedule();
            break;
          }
        }
      },
    );
  };

  const applyEvents = (events: readonly SessionEvent[]): void => {
    latestSharedEvents = events;
    if (store.getSnapshot().acceptedSteers.length > 0) {
      const startedTurnIds = new Set(
        events.flatMap((event) =>
          event.type === "turn.started" && event.turnId ? [event.turnId] : [],
        ),
      );
      if (startedTurnIds.size > 0) {
        const acceptedSteers = store
          .getSnapshot()
          .acceptedSteers.filter((steer) => !startedTurnIds.has(steer.turnId));
        if (acceptedSteers.length !== store.getSnapshot().acceptedSteers.length) {
          publish({ acceptedSteers });
        }
      }
    }
    if (store.diagnostics().started && activity.isLive()) processSharedEvents(events);
  };

  const eventTail = createSessionEventTail({
    store,
    client: options.client,
    workspaceId: options.workspaceId,
    sessionId,
    enabled: () => !sharedFeed && activity.isLive(),
    onOpen: () => void load(true).catch(() => undefined),
    onEvent(event) {
      if (isTurnQueueEvent(event)) eventRefresh.schedule();
    },
  });

  const mutate = async (
    turnId: string,
    kind: QueueMutationKind,
    command: (
      current: SessionQueueSnapshot,
      turn: SessionTurn,
      clientEventId: string,
    ) => Promise<SessionQueueMutationResponse>,
  ): Promise<SessionQueueMutationResponse | null> => {
    const current = authoritative;
    const turn = current?.items.find((candidate) => candidate.id === turnId);
    if (!current || !turn || pendingKeys.has(turnId) || store.signal.aborted) return null;
    const pending = { kind, key: environment.ids.randomUUID() };
    pendingKeys.set(turnId, pending);
    publish({ mutationError: null });
    try {
      let result: SessionQueueMutationResponse;
      try {
        result = await command(current, turn, pending.key);
      } catch (cause) {
        if (!isOutcomeUnknownError(cause)) throw cause;
        result = await command(current, turn, pending.key);
      }
      if (store.signal.aborted || pendingKeys.get(turnId) !== pending) return null;
      accept(result.snapshot);
      publish();
      return result;
    } catch (cause) {
      if (!store.signal.aborted) {
        publish({ mutationError: asError(cause) });
        await load();
      }
      return null;
    } finally {
      if (pendingKeys.get(turnId) === pending) {
        pendingKeys.delete(turnId);
        publish();
      }
    }
  };

  return Object.assign(store, {
    refresh,
    applyEvents,
    async moveTurn(turnId: string, beforeTurnId: string | null) {
      return (
        (await mutate(turnId, "move", (current, _turn, clientEventId) =>
          options.client.moveQueueItem(options.workspaceId, sessionId, turnId, {
            clientEventId,
            expectedQueueVersion: current.version,
            beforeTurnId,
          }),
        )) !== null
      );
    },
    async editTurn(turnId: string, edit: { expectedDraftRevision: number; replaceDraft: boolean }) {
      const result = await mutate(turnId, "edit", (_current, turn, clientEventId) =>
        options.client.editQueueItem(options.workspaceId, sessionId, turnId, {
          clientEventId,
          expectedTurnVersion: turn.version,
          expectedDraftRevision: edit.expectedDraftRevision,
          replaceDraft: edit.replaceDraft,
        }),
      );
      return result?.draft ?? null;
    },
    async steerTurn(turnId: string) {
      const turn = authoritative?.items.find((candidate) => candidate.id === turnId);
      if (!turn) {
        publish({
          mutationError: new Error("That queued prompt changed before Steer could be sent."),
        });
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
        occurredAt: new Date(environment.clock.now()).toISOString(),
        state: "sending",
      };
      publish({
        acceptedSteers: [
          ...store.getSnapshot().acceptedSteers.filter((item) => item.turnId !== turnId),
          optimistic,
        ],
      });
      const result = await mutate(turnId, "steer", (current, queuedTurn, clientEventId) =>
        options.client.steerQueueItem(options.workspaceId, sessionId, turnId, {
          clientEventId,
          expectedTurnVersion: queuedTurn.version,
          controlEtag: current.effectiveControl.controlEtag,
        }),
      );
      const advancedWithoutSteer =
        result === null &&
        authoritative !== null &&
        !authoritative.items.some((candidate) => candidate.id === turnId);
      if (advancedWithoutSteer) {
        publish({
          acceptedSteers: store
            .getSnapshot()
            .acceptedSteers.filter((item) => item.turnId !== turnId),
          mutationError: null,
        });
        return true;
      }
      const accepted =
        result !== null ||
        authoritative?.items.some(
          (candidate) => candidate.id === turnId && candidate.metadata.delivery === "steer",
        ) === true;
      publish({
        acceptedSteers: accepted
          ? store
              .getSnapshot()
              .acceptedSteers.map((item) =>
                item.turnId === turnId ? { ...item, state: "queued" as const } : item,
              )
          : store.getSnapshot().acceptedSteers.filter((item) => item.turnId !== turnId),
      });
      return accepted;
    },
    async removeTurn(turnId: string) {
      return (
        (await mutate(turnId, "delete", (_current, turn, clientEventId) =>
          options.client.deleteQueueItem(options.workspaceId, sessionId, turnId, {
            clientEventId,
            expectedTurnVersion: turn.version,
            reason: "Deleted from the prompt queue",
          }),
        )) !== null
      );
    },
    mutationFor(turnId: string) {
      return pendingKeys.get(turnId)?.kind ?? null;
    },
    clearMutationError() {
      publish({ mutationError: null });
    },
    diagnostics: store.diagnostics,
  });
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

function project(
  snapshot: SessionQueueSnapshot | null,
  loading: boolean,
  error: Error | null,
  pendingByTurn: Readonly<Record<string, QueueMutationKind>>,
  mutationError: Error | null,
  acceptedSteers: readonly AcceptedQueueSteer[],
): TurnQueueStoreSnapshot {
  return {
    snapshot,
    queue: snapshot?.items ?? [],
    pendingInputs: snapshot?.pendingInputs ?? [],
    pendingInputAttachment: snapshot?.pendingInputAttachment ?? null,
    activePersonalConnections: snapshot?.activePersonalConnections ?? [],
    effectiveControl: snapshot?.effectiveControl ?? null,
    stoppingPreviousAttempt: snapshot?.stoppingPreviousAttempt ?? false,
    loading,
    error,
    pendingByTurn,
    mutating: Object.keys(pendingByTurn).length > 0,
    mutationError,
    acceptedSteers,
  };
}
