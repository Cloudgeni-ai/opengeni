import type { SessionEvent, SessionLineageResponse } from "../types";
import type { SessionLineageClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  createCoalescedRead,
  createDebouncedTask,
  createPageActivity,
  createPoller,
  createSessionEventCursor,
} from "./live";
import { asError, type ResourceSnapshot } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export function isLineageRefreshEvent(event: SessionEvent): boolean {
  if (event.type === "session.status.changed" || event.type === "session.created") return true;
  if (event.type !== "agent.toolCall.output") return false;
  return isSessionCreateTool(event);
}

export type SessionLineageStore = OpenGeniExternalStore<
  ResourceSnapshot<SessionLineageResponse>
> & {
  refresh(): Promise<void>;
  applyEvents(events: readonly SessionEvent[]): void;
  invalidate(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createSessionLineageStore(options: {
  client: Pick<SessionLineageClientLike, "getSessionLineage">;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
  events?: readonly SessionEvent[];
  beginRead?: (() => number) | undefined;
  eventDebounceMs?: number;
  childCommitDelayMs?: number;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): SessionLineageStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const sharedFeed = options.events !== undefined;
  let revision = 0;
  let nextReadGeneration = 0;
  let activityGeneration = 0;
  let latestSharedEvents = options.events ?? [];

  const store = createExternalStore<ResourceSnapshot<SessionLineageResponse>>({
    initialSnapshot: {
      value: null,
      loading: enabled,
      error: null,
      readRevision: 0,
      readGeneration: 0,
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
      delayedChildRefresh.clear();
      activity.destroy();
    },
  });

  const reads = createCoalescedRead({
    store,
    enabled,
    async load(signal) {
      let readGeneration = 0;
      const value = await options.client.getSessionLineage(options.workspaceId, sessionId, {
        signal,
        onRequestStart: (sharedReadGeneration) => {
          readGeneration = sharedReadGeneration ?? options.beginRead?.() ?? ++nextReadGeneration;
        },
      });
      return { value, readGeneration };
    },
    accept({ value, readGeneration }) {
      store.publish({
        value,
        loading: false,
        error: null,
        readRevision: ++revision,
        readGeneration,
      });
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
    await reads.run();
    if (ownedActivity !== activityGeneration || !activity.isLive() || store.signal.aborted) return;
    poller.schedule();
  };

  const deactivate = (): void => {
    activityGeneration += 1;
    reads.invalidate(true);
    poller.clear();
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
  const delayedChildRefresh = createDebouncedTask({
    store,
    environment,
    delayMs: options.childCommitDelayMs ?? 2_500,
    enabled: () => activity.isLive() && !store.signal.aborted,
    run: () => void reads.refresh(),
  });
  const eventCursor = createSessionEventCursor();

  const refreshAfterChildCreate = (): void => {
    if (!activity.isLive() || store.signal.aborted) return;
    void reads.refresh();
    delayedChildRefresh.schedule();
  };

  const processEvent = (event: SessionEvent): void => {
    if (isLineageRefreshEvent(event)) eventRefresh.schedule();
    if (isSessionCreateToolCallCreated(event)) refreshAfterChildCreate();
  };

  const processSharedEvents = (events: readonly SessionEvent[]): void => {
    if (!sharedFeed || !activity.isLive() || store.signal.aborted) return;
    eventCursor.apply(events, processEvent, (window) => {
      let latestRefresh: SessionEvent | undefined;
      let latestChildCreate: SessionEvent | undefined;
      for (let index = window.length - 1; index >= 0; index -= 1) {
        const event = window[index];
        if (!event) continue;
        if (!latestRefresh && isLineageRefreshEvent(event)) latestRefresh = event;
        if (!latestChildCreate && isSessionCreateToolCallCreated(event)) latestChildCreate = event;
        if (latestRefresh && latestChildCreate) break;
      }
      if (latestRefresh) eventRefresh.schedule();
      if (latestChildCreate) refreshAfterChildCreate();
    });
  };

  const applyEvents = (events: readonly SessionEvent[]): void => {
    latestSharedEvents = events;
    if (store.diagnostics().started && activity.isLive()) processSharedEvents(events);
  };

  return Object.assign(store, {
    refresh: reads.refresh,
    applyEvents,
    invalidate() {
      reads.invalidate();
    },
    diagnostics: store.diagnostics,
  });
}

function isSessionCreateToolCallCreated(event: SessionEvent): boolean {
  return event.type === "agent.toolCall.created" && isSessionCreateTool(event);
}

function isSessionCreateTool(event: SessionEvent): boolean {
  const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
  const name =
    typeof payload?.name === "string"
      ? payload.name
      : typeof payload?.toolName === "string"
        ? payload.toolName
        : "";
  return name === "session_create" || name.endsWith("__session_create");
}
