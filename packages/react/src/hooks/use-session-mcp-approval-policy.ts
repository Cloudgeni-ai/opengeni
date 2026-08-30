import type {
  SessionEvent,
  SessionMcpApprovalPolicy,
  SessionMcpServerMetadata,
  UpdateSessionMcpApprovalPolicyResponse,
} from "@opengeni/sdk";
import {
  createSessionMcpApprovalPolicyStore,
  isSessionMcpApprovalPolicyEvent as isSdkSessionMcpApprovalPolicyEvent,
} from "@opengeni/sdk/session";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useEmbeddedSessionMcpApprovalPolicy,
  type EmbeddedSessionMcpApprovalPolicyClientOverride,
} from "../session-context";
import { useOwnedExternalStore, type SessionEventFeedOptions } from "./internal";

export function isSessionMcpApprovalPolicyEvent(
  event: Pick<SessionEvent, "type" | "payload">,
  serverId?: string,
): boolean {
  return isSdkSessionMcpApprovalPolicyEvent(event, serverId);
}

export type UseSessionMcpApprovalPolicyOptions = EmbeddedSessionMcpApprovalPolicyClientOverride &
  SessionEventFeedOptions & {
    /** Optional safety-net polling (ms). Off by default; policy events drive refreshes. */
    pollIntervalMs?: number | undefined;
  };

export type UseSessionMcpApprovalPolicyResult = {
  server: SessionMcpServerMetadata | null;
  policy: SessionMcpApprovalPolicy | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  update: (
    policy: SessionMcpApprovalPolicy,
  ) => Promise<UpdateSessionMcpApprovalPolicyResponse | null>;
  updating: boolean;
  clearError: () => void;
};

/** React compatibility adapter over the framework-neutral MCP policy controller. */
export function useSessionMcpApprovalPolicy(
  sessionId: string | null | undefined,
  serverId: string | null | undefined,
  options: UseSessionMcpApprovalPolicyOptions = {},
): UseSessionMcpApprovalPolicyResult {
  const { client, workspaceId } = useEmbeddedSessionMcpApprovalPolicy(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId && serverId);
  const sharedFeed = options.events !== undefined;
  const latestEvents = useRef(options.events);
  latestEvents.current = options.events;
  const store = useMemo(
    () =>
      createSessionMcpApprovalPolicyStore({
        client,
        workspaceId,
        sessionId,
        serverId,
        enabled,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(sharedFeed ? { events: latestEvents.current ?? [] } : {}),
      }),
    [client, enabled, options.pollIntervalMs, serverId, sessionId, sharedFeed, workspaceId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);

  useEffect(() => {
    if (options.events !== undefined) store.applyEvents(options.events);
  }, [options.events, store]);

  return {
    server: snapshot.server,
    policy: snapshot.policy,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh: store.refresh,
    update: store.update,
    updating: snapshot.updating,
    clearError: store.clearError,
  };
}
