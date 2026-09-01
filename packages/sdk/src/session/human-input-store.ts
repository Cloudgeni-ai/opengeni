import { OpenGeniApiError } from "../errors";
import type {
  SessionEvent,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "../types";
import type { HumanInputSessionClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import { isActionableHumanInputRequest } from "./human-input";
import {
  createCoalescedRead,
  createDebouncedTask,
  createPageActivity,
  createPoller,
  createSessionEventCursor,
  createSessionEventTail,
  createTrackedTimer,
} from "./live";
import { asError, isOutcomeUnknownError } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export function isHumanInputEvent(event: { type: string }): boolean {
  return (
    event.type === "session.humanInput.requested" ||
    event.type === "user.humanInputResponse" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  );
}

export type HumanInputStoreSnapshot = Readonly<{
  requests: readonly SessionHumanInputRequest[];
  loading: boolean;
  error: Error | null;
  respondingRequestId: string | null;
  mutationError: Error | null;
}>;

export type HumanInputStore = OpenGeniExternalStore<HumanInputStoreSnapshot> & {
  refresh(): Promise<void>;
  applyEvents(events: readonly SessionEvent[]): void;
  respond(
    requestId: string,
    response: SubmitHumanInputResponseRequest,
  ): Promise<SessionEvent | null>;
  clearMutationError(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createHumanInputStore(options: {
  client: Pick<
    HumanInputSessionClientLike,
    "getSession" | "streamEvents" | "listHumanInputRequests" | "submitHumanInputResponse"
  >;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
  events?: readonly SessionEvent[];
  eventDebounceMs?: number;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): HumanInputStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const sharedFeed = options.events !== undefined;
  let activityGeneration = 0;
  let latestSharedEvents = options.events ?? [];
  let respondingRequestId: string | null = null;
  let pendingResponse: { signature: string; clientEventId: string } | null = null;

  const store = createExternalStore<HumanInputStoreSnapshot>({
    initialSnapshot: {
      requests: [],
      loading: enabled,
      error: null,
      respondingRequestId: null,
      mutationError: null,
    },
    start: async () => {
      if (!enabled) {
        store.publish((current) => ({ ...current, loading: false }));
        return;
      }
      activity.start();
      const initialRead = activate();
      processSharedEvents(latestSharedEvents);
      await initialRead;
    },
    destroy: () => {
      activityGeneration += 1;
      reads.destroy();
      poller.clear();
      eventRefresh.clear();
      deadlineTimer.clear();
      eventTail.stop();
      activity.destroy();
    },
  });

  const reads = createCoalescedRead({
    store,
    enabled,
    load: async () =>
      await options.client.listHumanInputRequests(options.workspaceId, sessionId, {
        status: "pending",
      }),
    accept(loaded) {
      const requests = actionableRequests(loaded, environment.clock.now());
      store.publish((current) => ({ ...current, requests, loading: false, error: null }));
      scheduleDeadline(requests);
    },
    reject(cause) {
      store.publish((current) => ({ ...current, loading: false, error: asError(cause) }));
    },
  });

  const activate = async (): Promise<void> => {
    if (!enabled || !activity.isLive() || store.signal.aborted) return;
    const ownedActivity = ++activityGeneration;
    poller.clear();
    store.publish((current) => ({ ...current, loading: true }));
    const initialRead = reads.run();
    eventTail.start();
    await initialRead;
    if (ownedActivity !== activityGeneration || !activity.isLive() || store.signal.aborted) return;
    poller.schedule();
  };

  const deactivate = (): void => {
    activityGeneration += 1;
    reads.invalidate(true);
    poller.clear();
    eventRefresh.clear();
    eventTail.stop();
    store.publish((current) => ({ ...current, loading: false }));
  };

  const activity = createPageActivity({
    store,
    environment,
    hiddenGraceMs: options.hiddenGraceMs,
    activate() {
      void activate();
      processSharedEvents(latestSharedEvents);
    },
    deactivate,
  });
  const poller = createPoller({
    store,
    environment,
    delayMs: options.pollIntervalMs,
    enabled: () => activity.isLive() && !store.signal.aborted,
    run: reads.run,
  });
  const eventRefresh = createDebouncedTask({
    store,
    environment,
    delayMs: options.eventDebounceMs,
    enabled: () => activity.isLive() && !store.signal.aborted,
    run: () => void reads.refresh(),
  });
  const deadlineTimer = createTrackedTimer(store, environment);
  const eventCursor = createSessionEventCursor();

  const scheduleDeadline = (requests: readonly SessionHumanInputRequest[]): void => {
    deadlineTimer.clear();
    const now = environment.clock.now();
    const nextDeadline = requests.reduce<number | null>((next, request) => {
      if (!request.expiresAt) return next;
      const value = Date.parse(request.expiresAt);
      if (!Number.isFinite(value) || value <= now) return next;
      return next === null ? value : Math.min(next, value);
    }, null);
    if (nextDeadline === null) return;
    deadlineTimer.schedule(
      () => {
        const nextRequests = actionableRequests(
          store.getSnapshot().requests,
          environment.clock.now(),
        );
        store.publish((current) => ({ ...current, requests: nextRequests }));
        void reads.refresh();
      },
      Math.min(2_147_483_647, Math.max(0, nextDeadline - now + 1)),
    );
  };

  const processSharedEvents = (events: readonly SessionEvent[]): void => {
    if (!sharedFeed || !activity.isLive() || store.signal.aborted) return;
    eventCursor.apply(
      events,
      (event) => {
        if (isHumanInputEvent(event)) eventRefresh.schedule();
      },
      (window) => {
        for (let index = window.length - 1; index >= 0; index -= 1) {
          const event = window[index];
          if (event && isHumanInputEvent(event)) {
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
      if (isHumanInputEvent(event)) eventRefresh.schedule();
    },
  });

  return Object.assign(store, {
    refresh: reads.refresh,
    applyEvents,
    async respond(requestId: string, response: SubmitHumanInputResponseRequest) {
      if (respondingRequestId !== null || store.signal.aborted) return null;
      const signature = JSON.stringify([requestId, response]);
      if (pendingResponse?.signature !== signature) {
        pendingResponse = { signature, clientEventId: environment.ids.randomUUID() };
      }
      const operation = pendingResponse;
      respondingRequestId = requestId;
      store.publish((current) => ({
        ...current,
        respondingRequestId,
        mutationError: null,
      }));
      try {
        let event: SessionEvent;
        try {
          event = await options.client.submitHumanInputResponse(
            options.workspaceId,
            sessionId,
            requestId,
            response,
            { clientEventId: operation.clientEventId },
          );
        } catch (cause) {
          if (!isOutcomeUnknownError(cause)) throw cause;
          event = await options.client.submitHumanInputResponse(
            options.workspaceId,
            sessionId,
            requestId,
            response,
            { clientEventId: operation.clientEventId },
          );
        }
        if (store.signal.aborted) return null;
        if (pendingResponse === operation) pendingResponse = null;
        await reads.refresh();
        return event;
      } catch (cause) {
        if (!store.signal.aborted) {
          if (
            cause instanceof OpenGeniApiError &&
            (cause.status === 404 || cause.status === 409 || cause.status === 410)
          ) {
            await reads.refresh();
            if (!store.getSnapshot().requests.some((request) => request.id === requestId)) {
              if (pendingResponse === operation) pendingResponse = null;
              return null;
            }
          }
          if (!isOutcomeUnknownError(cause) && pendingResponse === operation) {
            pendingResponse = null;
          }
          store.publish((current) => ({ ...current, mutationError: asError(cause) }));
        }
        return null;
      } finally {
        if (respondingRequestId === requestId && !store.signal.aborted) {
          respondingRequestId = null;
          store.publish((current) => ({ ...current, respondingRequestId: null }));
        }
      }
    },
    clearMutationError() {
      store.publish((current) => ({ ...current, mutationError: null }));
    },
    diagnostics: store.diagnostics,
  });
}

function actionableRequests(
  requests: readonly SessionHumanInputRequest[],
  now: number,
): SessionHumanInputRequest[] {
  return [...requests]
    .filter((request) => isActionableHumanInputRequest(request, now))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}
