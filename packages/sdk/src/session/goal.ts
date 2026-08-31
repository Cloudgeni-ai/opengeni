import { OpenGeniApiError } from "../errors";
import type { SessionEvent, SessionGoal } from "../types";
import type { GoalClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  createDebouncedTask,
  createPageActivity,
  createPoller,
  createSessionEventCursor,
  createSessionEventTail,
} from "./live";
import { asError, type ResourceSnapshot } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export function isGoalEvent(event: { type: string }): boolean {
  return event.type.startsWith("goal.");
}

export function isGoalRefreshEvent(event: { type: string }): boolean {
  return (
    isGoalEvent(event) ||
    event.type.startsWith("turn.") ||
    event.type.startsWith("session.") ||
    event.type.startsWith("system.update.") ||
    event.type.startsWith("workspace.inference.") ||
    event.type.startsWith("user.")
  );
}

export type GoalStoreSnapshot = ResourceSnapshot<SessionGoal> &
  Readonly<{
    isActive: boolean;
    isPaused: boolean;
    isCompleted: boolean;
    updating: boolean;
    mutationError: Error | null;
  }>;

export type GoalStore = OpenGeniExternalStore<GoalStoreSnapshot> & {
  refresh(): Promise<void>;
  applyEvents(events: readonly SessionEvent[]): void;
  pause(rationale?: string): Promise<SessionGoal | null>;
  resume(): Promise<SessionGoal | null>;
  clearGoal(): Promise<void>;
  clearMutationError(): void;
  invalidate(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createGoalStore(options: {
  client: Pick<
    GoalClientLike,
    "getSession" | "streamEvents" | "getGoal" | "updateGoal" | "deleteGoal"
  >;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
  events?: readonly SessionEvent[];
  eventDebounceMs?: number;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): GoalStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const sharedFeed = options.events !== undefined;
  let generation = 0;
  let revision = 0;
  let mutationGeneration = 0;
  let mutationInFlight = 0;
  let activityGeneration = 0;
  let readAbort: AbortController | null = null;
  let latestSharedEvents = options.events ?? [];
  let goal: SessionGoal | null = null;
  let mutationError: Error | null = null;

  const store = createExternalStore<GoalStoreSnapshot>({
    initialSnapshot: project(null, enabled && !sharedFeed, null, 0, 0, 0, null),
    start: async () => {
      if (!enabled) {
        publish({ loading: false });
        return;
      }
      activity.start();
      if (sharedFeed) {
        publish({ loading: false });
        processSharedEvents(latestSharedEvents);
        return;
      }
      await activate();
    },
    destroy: () => {
      generation += 1;
      mutationGeneration += 1;
      activityGeneration += 1;
      readAbort?.abort();
      readAbort = null;
      poller.clear();
      eventRefresh.clear();
      eventTail.stop();
      activity.destroy();
    },
  });

  const publish = (patch: Partial<GoalStoreSnapshot> = {}) => {
    const current = store.getSnapshot();
    store.publish({
      ...project(
        goal,
        patch.loading ?? current.loading,
        patch.error === undefined ? current.error : patch.error,
        patch.readRevision ?? current.readRevision,
        patch.readGeneration ?? current.readGeneration,
        mutationInFlight,
        patch.mutationError === undefined ? mutationError : patch.mutationError,
      ),
      ...patch,
    });
  };

  const load = async (): Promise<void> => {
    if (!enabled || store.signal.aborted) return;
    const ticket = ++generation;
    readAbort?.abort();
    const controller = new AbortController();
    readAbort = controller;
    try {
      const loadedGoal = await store.trackRead(() =>
        options.client.getGoal(options.workspaceId, sessionId, { signal: controller.signal }),
      );
      if (ticket !== generation || controller.signal.aborted || store.signal.aborted) return;
      goal = loadedGoal;
      publish({
        loading: false,
        error: null,
        readRevision: ++revision,
        readGeneration: ticket,
      });
    } catch (cause) {
      if (ticket !== generation || controller.signal.aborted || store.signal.aborted) return;
      if (cause instanceof OpenGeniApiError && cause.status === 404) {
        goal = null;
        publish({
          loading: false,
          error: null,
          readRevision: ++revision,
          readGeneration: ticket,
        });
      } else {
        publish({ loading: false, error: asError(cause) });
      }
    } finally {
      if (readAbort === controller) readAbort = null;
    }
  };

  const refresh = async (): Promise<void> => await load();

  const activate = async (): Promise<void> => {
    if (!enabled || !activity.isLive() || store.signal.aborted) return;
    const ownedActivity = ++activityGeneration;
    poller.clear();
    publish({ loading: true });
    const initialRead = load();
    eventTail.start();
    await initialRead;
    if (ownedActivity !== activityGeneration || !activity.isLive() || store.signal.aborted) return;
    poller.schedule();
  };

  const deactivate = (): void => {
    activityGeneration += 1;
    generation += 1;
    readAbort?.abort();
    readAbort = null;
    poller.clear();
    eventRefresh.clear();
    eventTail.stop();
    publish({ loading: false });
  };

  const activity = createPageActivity({
    store,
    environment,
    hiddenGraceMs: options.hiddenGraceMs,
    activate() {
      if (sharedFeed) {
        publish({ loading: false });
        processSharedEvents(latestSharedEvents);
      } else {
        void activate();
      }
    },
    deactivate,
  });
  const poller = createPoller({
    store,
    environment,
    delayMs: options.pollIntervalMs,
    enabled: () => !sharedFeed && activity.isLive() && !store.signal.aborted,
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
        if (isGoalRefreshEvent(event)) eventRefresh.schedule();
      },
      (window) => {
        for (let index = window.length - 1; index >= 0; index -= 1) {
          const event = window[index];
          if (event && isGoalRefreshEvent(event)) {
            eventRefresh.schedule();
            break;
          }
        }
      },
    );
  };

  const applyEvents = (events: readonly SessionEvent[]): void => {
    latestSharedEvents = events;
    if (store.diagnostics().started && activity.isLive()) processSharedEvents(events);
  };

  const eventTail = createSessionEventTail({
    store,
    client: options.client,
    workspaceId: options.workspaceId,
    sessionId,
    enabled: () => !sharedFeed && activity.isLive(),
    onEvent(event) {
      if (isGoalRefreshEvent(event)) eventRefresh.schedule();
    },
  });

  const runMutation = async <Value>(operation: () => Promise<Value>): Promise<Value | null> => {
    const ownedGeneration = mutationGeneration;
    mutationInFlight += 1;
    mutationError = null;
    publish();
    try {
      const value = await operation();
      if (ownedGeneration !== mutationGeneration || store.signal.aborted) return null;
      return value;
    } catch (cause) {
      if (ownedGeneration === mutationGeneration && !store.signal.aborted) {
        mutationError = asError(cause);
        publish();
      }
      return null;
    } finally {
      if (ownedGeneration === mutationGeneration && !store.signal.aborted) {
        mutationInFlight = Math.max(0, mutationInFlight - 1);
        publish();
      }
    }
  };

  const acceptGoalMutation = (nextGoal: SessionGoal): void => {
    // A read that started before this mutation committed is causally older,
    // even when its transport ignores AbortSignal. Retire that generation
    // before publishing the accepted mutation so a late poll/event refresh
    // cannot restore the pre-mutation goal on a later publish.
    generation += 1;
    readAbort?.abort();
    readAbort = null;
    goal = nextGoal;
    publish();
  };

  return Object.assign(store, {
    refresh,
    applyEvents,
    async pause(rationale?: string) {
      const result = await runMutation(() =>
        options.client.updateGoal(options.workspaceId, sessionId, {
          status: "paused",
          ...(rationale === undefined ? {} : { rationale }),
        }),
      );
      if (result) {
        acceptGoalMutation(result);
      }
      return result;
    },
    async resume() {
      const result = await runMutation(() =>
        options.client.updateGoal(options.workspaceId, sessionId, { status: "active" }),
      );
      if (result) {
        acceptGoalMutation(result);
      }
      return result;
    },
    async clearGoal() {
      const cleared = await runMutation(async () => {
        await options.client.deleteGoal(options.workspaceId, sessionId);
        return true as const;
      });
      if (!cleared) return;
      generation += 1;
      readAbort?.abort();
      readAbort = null;
      goal = null;
      publish({ error: null });
    },
    clearMutationError() {
      mutationError = null;
      publish();
    },
    invalidate() {
      generation += 1;
      readAbort?.abort();
      readAbort = null;
    },
    diagnostics: store.diagnostics,
  });
}

function project(
  goal: SessionGoal | null,
  loading: boolean,
  error: Error | null,
  readRevision: number,
  readGeneration: number,
  mutationInFlight: number,
  mutationError: Error | null,
): GoalStoreSnapshot {
  return {
    value: goal,
    isActive: goal?.status === "active",
    isPaused: goal?.status === "paused",
    isCompleted: goal?.status === "completed",
    loading,
    error,
    readRevision,
    readGeneration,
    updating: mutationInFlight > 0,
    mutationError,
  };
}
