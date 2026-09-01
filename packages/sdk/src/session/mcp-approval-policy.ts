import type {
  SessionEvent,
  SessionMcpApprovalPolicy,
  SessionMcpServerMetadata,
  UpdateSessionMcpApprovalPolicyResponse,
} from "../types";
import type { SessionMcpApprovalPolicyClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  createCoalescedRead,
  createDebouncedTask,
  createPageActivity,
  createPoller,
  createSessionEventCursor,
  createSessionEventTail,
} from "./live";
import { asError } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";

export function isSessionMcpApprovalPolicyEvent(
  event: { type: string; payload?: unknown },
  serverId?: string,
): boolean {
  if (event.type !== "session.mcp.approval_policy.updated") return false;
  if (serverId === undefined) return true;
  return (event.payload as { serverId?: unknown } | null)?.serverId === serverId;
}

export type SessionMcpApprovalPolicyStoreSnapshot = Readonly<{
  server: SessionMcpServerMetadata | null;
  policy: SessionMcpApprovalPolicy | null;
  loading: boolean;
  updating: boolean;
  error: Error | null;
}>;

export type SessionMcpApprovalPolicyStore =
  OpenGeniExternalStore<SessionMcpApprovalPolicyStoreSnapshot> & {
    refresh(): Promise<void>;
    applyEvents(events: readonly SessionEvent[]): void;
    update(
      policy: SessionMcpApprovalPolicy,
    ): Promise<UpdateSessionMcpApprovalPolicyResponse | null>;
    clearError(): void;
    diagnostics(): OpenGeniStoreDiagnostics;
  };

export function createSessionMcpApprovalPolicyStore(options: {
  client: Pick<
    SessionMcpApprovalPolicyClientLike,
    "getSession" | "streamEvents" | "updateSessionMcpApprovalPolicy"
  >;
  workspaceId: string;
  sessionId: string | null | undefined;
  serverId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
  events?: readonly SessionEvent[];
  eventDebounceMs?: number;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): SessionMcpApprovalPolicyStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const serverId = options.serverId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0 && serverId.length > 0;
  const sharedFeed = options.events !== undefined;
  let authoritativeGeneration = 0;
  let mutationGeneration = 0;
  let mutationInFlight = 0;
  let activityGeneration = 0;
  let latestSharedEvents = options.events ?? [];
  let baseServer: SessionMcpServerMetadata | null = null;
  let override: SessionMcpServerMetadata | null = null;
  let loadError: Error | null = null;
  let mutationError: Error | null = null;

  const store = createExternalStore<SessionMcpApprovalPolicyStoreSnapshot>({
    initialSnapshot: project(null, enabled, 0, null, null),
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
      eventRefresh.clear();
      eventTail.stop();
      activity.destroy();
    },
  });

  const visibleServer = (): SessionMcpServerMetadata | null => override ?? baseServer;
  const publish = (patch: Partial<SessionMcpApprovalPolicyStoreSnapshot> = {}) => {
    const current = store.getSnapshot();
    store.publish({
      ...project(
        visibleServer(),
        patch.loading ?? current.loading,
        mutationInFlight,
        patch.error === undefined ? (mutationError ?? loadError) : patch.error,
        patch.server === undefined ? undefined : patch.server,
      ),
      ...patch,
    });
  };

  const reads = createCoalescedRead({
    store,
    enabled,
    async load(signal) {
      const ownedAuthoritativeGeneration = authoritativeGeneration;
      const session = await options.client.getSession(options.workspaceId, sessionId, { signal });
      return { session, ownedAuthoritativeGeneration };
    },
    accept({ session, ownedAuthoritativeGeneration }) {
      baseServer = session.mcpServers.find((candidate) => candidate.id === serverId) ?? null;
      if (ownedAuthoritativeGeneration === authoritativeGeneration) override = null;
      loadError = null;
      publish({ loading: false });
    },
    reject(cause) {
      loadError = asError(cause);
      publish({ loading: false });
    },
  });

  const activate = async (): Promise<void> => {
    if (!enabled || !activity.isLive() || store.signal.aborted) return;
    const ownedActivity = ++activityGeneration;
    poller.clear();
    publish({ loading: true });
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
    publish({ loading: false });
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
  const eventCursor = createSessionEventCursor();

  const matchesEvent = (event: SessionEvent): boolean =>
    isSessionMcpApprovalPolicyEvent(event, serverId);

  const processSharedEvents = (events: readonly SessionEvent[]): void => {
    if (!sharedFeed || !activity.isLive() || store.signal.aborted) return;
    eventCursor.apply(
      events,
      (event) => {
        if (matchesEvent(event)) eventRefresh.schedule();
      },
      (window) => {
        for (let index = window.length - 1; index >= 0; index -= 1) {
          const event = window[index];
          if (event && matchesEvent(event)) {
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
    onOpen: () => void reads.refresh(),
    onEvent(event) {
      if (matchesEvent(event)) eventRefresh.schedule();
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
    async update(policy: SessionMcpApprovalPolicy) {
      const response = await runMutation(() =>
        options.client.updateSessionMcpApprovalPolicy(options.workspaceId, sessionId, serverId, {
          requireApproval: policy,
        }),
      );
      if (!response) return null;
      authoritativeGeneration += 1;
      override = response.server;
      publish();
      void reads.refresh();
      return response;
    },
    clearError() {
      mutationError = null;
      publish();
    },
    diagnostics: store.diagnostics,
  });
}

function project(
  server: SessionMcpServerMetadata | null,
  loading: boolean,
  mutationInFlight: number,
  error: Error | null,
  explicitServer: SessionMcpServerMetadata | null | undefined,
): SessionMcpApprovalPolicyStoreSnapshot {
  const visible = explicitServer === undefined ? server : explicitServer;
  return {
    server: visible,
    policy: visible?.requireApproval ?? null,
    loading,
    updating: mutationInFlight > 0,
    error,
  };
}
