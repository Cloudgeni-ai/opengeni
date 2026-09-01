import type { Session, SessionEvent } from "../types";
import type { SessionResourceClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  createCoalescedRead,
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

export function isTitleEvent(event: { type: string }): boolean {
  return event.type === "session.title_set";
}

export type SessionResourceSnapshot = ResourceSnapshot<Session> &
  Readonly<{ updating: boolean; mutationError: Error | null }>;

export type SessionResourceStore = OpenGeniExternalStore<SessionResourceSnapshot> & {
  refresh(): Promise<void>;
  applyEvents(events: readonly SessionEvent[]): void;
  invalidate(): void;
  updateTitle(title: string): Promise<Session | null>;
  clearMutationError(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createSessionResourceStore(options: {
  client: SessionResourceClientLike;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
  events?: readonly SessionEvent[];
  beginRead?: (() => number) | undefined;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): SessionResourceStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const sharedFeed = options.events !== undefined;
  let revision = 0;
  let nextReadGeneration = 0;
  let authoritativeGeneration = 0;
  let mutationGeneration = 0;
  let mutationInFlight = 0;
  let activityGeneration = 0;
  let latestSharedEvents = options.events ?? [];
  let base: Session | null = null;
  let override: Session | null = null;
  let mutationError: Error | null = null;

  const store = createExternalStore<SessionResourceSnapshot>({
    initialSnapshot: project(null, enabled, null, 0, 0, 0, null),
    start: async () => {
      if (!enabled) {
        publish({ loading: false });
        return;
      }
      activity.start();
      const initialRead = activate();
      processSharedEvents(latestSharedEvents);
      await initialRead;
    },
    destroy: () => {
      mutationGeneration += 1;
      activityGeneration += 1;
      reads.destroy();
      poller.clear();
      eventTail.stop();
      activity.destroy();
    },
  });

  const visibleSession = (): Session | null =>
    base && override && override.id === base.id
      ? { ...base, title: override.title, titleSource: override.titleSource }
      : base;

  const publish = (patch: Partial<SessionResourceSnapshot> = {}) => {
    const current = store.getSnapshot();
    store.publish({
      ...project(
        visibleSession(),
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

  const reads = createCoalescedRead({
    store,
    enabled,
    async load(signal) {
      const ownedAuthoritativeGeneration = authoritativeGeneration;
      let readGeneration = 0;
      const value = await options.client.getSession(options.workspaceId, sessionId, {
        fresh: true,
        signal,
        onRequestStart: () => {
          readGeneration = options.beginRead?.() ?? ++nextReadGeneration;
        },
      });
      return { value, readGeneration, ownedAuthoritativeGeneration };
    },
    accept({ value, readGeneration, ownedAuthoritativeGeneration }) {
      base = value;
      if (ownedAuthoritativeGeneration === authoritativeGeneration) override = null;
      publish({
        loading: false,
        error: null,
        readRevision: ++revision,
        readGeneration,
      });
    },
    reject(cause) {
      publish({ loading: false, error: asError(cause) });
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
  const eventCursor = createSessionEventCursor();

  const applyTitleEvent = (event: SessionEvent): void => {
    if (!base || event.sequence <= base.lastSequence) return;
    const payload = (event.payload ?? {}) as { title?: unknown; source?: unknown };
    if (typeof payload.title !== "string") return;
    const titleSource: "user" | "agent" | null =
      payload.source === "user" || payload.source === "agent" ? payload.source : null;
    const current = override && override.id === base.id ? override : base;
    authoritativeGeneration += 1;
    override = { ...current, title: payload.title, titleSource };
    publish();
  };

  const processSharedEvents = (events: readonly SessionEvent[]): void => {
    if (!sharedFeed || !activity.isLive() || store.signal.aborted) return;
    eventCursor.apply(
      events,
      (event) => {
        if (isTitleEvent(event)) applyTitleEvent(event);
      },
      (window) => {
        for (let index = window.length - 1; index >= 0; index -= 1) {
          const event = window[index];
          if (event && isTitleEvent(event)) {
            applyTitleEvent(event);
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
      if (isTitleEvent(event)) applyTitleEvent(event);
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

  return Object.assign(store, {
    refresh: reads.refresh,
    applyEvents,
    invalidate() {
      reads.invalidate(true);
    },
    async updateTitle(title: string) {
      if (!options.client.updateSession) {
        mutationError = new Error("Session title updates are unavailable for this client.");
        publish();
        return null;
      }
      const result = await runMutation(() =>
        options.client.updateSession!(options.workspaceId, sessionId, { title }),
      );
      if (result) {
        authoritativeGeneration += 1;
        override = result;
        publish();
        void reads.refresh();
      }
      return result;
    },
    clearMutationError() {
      mutationError = null;
      publish();
    },
    diagnostics: store.diagnostics,
  });
}

function project(
  session: Session | null,
  loading: boolean,
  error: Error | null,
  readRevision: number,
  readGeneration: number,
  mutationInFlight: number,
  mutationError: Error | null,
): SessionResourceSnapshot {
  return {
    value: session,
    loading,
    error,
    readRevision,
    readGeneration,
    updating: mutationInFlight > 0,
    mutationError,
  };
}
