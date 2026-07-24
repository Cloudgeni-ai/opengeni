import type {
  SessionEvent,
  SessionMcpApprovalPolicy,
  SessionMcpServerMetadata,
  UpdateSessionMcpApprovalPolicyResponse,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useEmbeddedSessionMcpApprovalPolicy,
  type EmbeddedSessionMcpApprovalPolicyClientOverride,
} from "../session-context";
import {
  useDebouncedCallback,
  useMutationRunner,
  usePolledValue,
  useSessionEventTrigger,
  type SessionEventFeedOptions,
} from "./internal";

export function isSessionMcpApprovalPolicyEvent(
  event: Pick<SessionEvent, "type" | "payload">,
  serverId?: string,
): boolean {
  if (event.type !== "session.mcp.approval_policy.updated") {
    return false;
  }
  if (serverId === undefined) {
    return true;
  }
  const payload = event.payload as { serverId?: unknown } | null;
  return payload?.serverId === serverId;
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

/**
 * Read and update one existing session MCP server's approval policy. Updates
 * become effective for the next claimed attempt; current work is unchanged.
 */
export function useSessionMcpApprovalPolicy(
  sessionId: string | null | undefined,
  serverId: string | null | undefined,
  options: UseSessionMcpApprovalPolicyOptions = {},
): UseSessionMcpApprovalPolicyResult {
  const { client, workspaceId } = useEmbeddedSessionMcpApprovalPolicy(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId && serverId);
  const [override, setOverride] = useState<SessionMcpServerMetadata | null>(null);
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${serverId ?? ""}`;
  const authoritativeGeneration = useRef(0);
  const mutationIdentity = useMemo(() => ({ client, targetKey }), [client, targetKey]);
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner(mutationIdentity);

  useLayoutEffect(() => {
    authoritativeGeneration.current += 1;
    setOverride(null);
  }, [client, targetKey]);

  type PolicyRead = {
    targetKey: string;
    generation: number;
    server: SessionMcpServerMetadata | null;
  };
  const load = useCallback(async (): Promise<PolicyRead> => {
    const generation = authoritativeGeneration.current;
    if (!sessionId || !serverId) {
      return { targetKey, generation, server: null };
    }
    const session = await client.getSession(workspaceId, sessionId);
    return {
      targetKey,
      generation,
      server: session.mcpServers.find((server) => server.id === serverId) ?? null,
    };
  }, [client, serverId, sessionId, targetKey, workspaceId]);
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = usePolledValue(load, {
    enabled,
    pollIntervalMs: options.pollIntervalMs,
  });
  useEffect(() => {
    if (data?.targetKey === targetKey && data.generation === authoritativeGeneration.current) {
      setOverride(null);
    }
  }, [data, targetKey]);

  const scheduleRefresh = useDebouncedCallback(() => void refresh());
  const matchesPolicyEvent = useCallback(
    (event: Pick<SessionEvent, "type" | "payload">) =>
      isSessionMcpApprovalPolicyEvent(event, serverId ?? undefined),
    [serverId],
  );
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    matchesPolicyEvent,
    scheduleRefresh,
    {
      enabled,
      ...(options.events !== undefined ? { events: options.events } : {}),
    },
    async () => await refresh(),
  );

  const update = useCallback(
    async (
      policy: SessionMcpApprovalPolicy,
    ): Promise<UpdateSessionMcpApprovalPolicyResponse | null> => {
      if (!sessionId || !serverId) {
        return null;
      }
      const response = await run(() =>
        client.updateSessionMcpApprovalPolicy(workspaceId, sessionId, serverId, {
          requireApproval: policy,
        }),
      );
      if (response) {
        authoritativeGeneration.current += 1;
        setOverride(response.server);
        void refresh();
      }
      return response;
    },
    [client, refresh, run, serverId, sessionId, workspaceId],
  );

  const server = override ?? data?.server ?? null;
  return {
    server,
    policy: server?.requireApproval ?? null,
    loading,
    error: mutationError ?? loadError,
    refresh: async () => {
      await refresh();
    },
    update,
    updating: mutating,
    clearError: clearMutationError,
  };
}
