import type {
  ComputerSession,
  ComputerSessionMutationResponse,
  CreateComputerSessionRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EmbeddedComputerInteractionClientLike } from "../client";
import {
  type EmbeddedComputerInteractionClientOverride,
  useEmbeddedComputerInteraction,
} from "../session-context";
import { usePageLiveActivity } from "./internal";

export type UseComputerSessionsOptions = EmbeddedComputerInteractionClientOverride & {
  /** Current agent/session relevance. Workspace peers remain in `sessions`. */
  sessionId?: string | undefined;
  enabled?: boolean | undefined;
  /** Temporary invalidation path until the interaction event stream lands. */
  pollIntervalMs?: number | undefined;
};

export type UseComputerSessionsResult = {
  revision: number;
  sessions: ComputerSession[];
  relevantSessions: ComputerSession[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (
    request: Omit<CreateComputerSessionRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<ComputerSessionMutationResponse>;
  end: (
    computerSessionId: string,
    operationId?: string,
  ) => Promise<ComputerSessionMutationResponse>;
};

/** Workspace-wide ComputerSession registry. Associations rank relevance but
 * never hide peer resources or create an ownership boundary. */
export function useComputerSessions(
  options: UseComputerSessionsOptions = {},
): UseComputerSessionsResult {
  const { client, workspaceId, registerSessionReconciler } =
    useEmbeddedComputerInteraction(options);
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 3_000);
  const [state, setState] = useState<ComputerRegistryState>(() => emptyState(workspaceId, enabled));
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const mountedRef = useRef(true);
  const visible = state.workspaceId === workspaceId ? state : emptyState(workspaceId, enabled);

  const cancelLoad = useCallback(() => {
    const id = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    requestRef.current = { id, controller: null };
  }, []);

  const load = useCallback(
    async (foreground: boolean): Promise<void> => {
      if (!enabled) return;
      const id = requestRef.current.id + 1;
      requestRef.current.controller?.abort();
      const controller = new AbortController();
      requestRef.current = { id, controller };
      setState((current) => ({
        ...(current.workspaceId === workspaceId ? current : emptyState(workspaceId, true)),
        loading: foreground,
        refreshing: !foreground,
        error: foreground || current.workspaceId !== workspaceId ? null : current.error,
      }));
      try {
        const response = await client.listComputerSessions(workspaceId, {
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          workspaceId,
          revision: response.revision,
          sessions: sortComputerSessions(response.sessions),
          loading: false,
          refreshing: false,
          error: null,
        });
      } catch (cause) {
        if (controller.signal.aborted || !mountedRef.current || requestRef.current.id !== id)
          return;
        setState((current) => ({
          ...(current.workspaceId === workspaceId ? current : emptyState(workspaceId, true)),
          loading: false,
          refreshing: false,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }));
      } finally {
        if (requestRef.current.id === id) requestRef.current = { id, controller: null };
      }
    },
    [client, enabled, workspaceId],
  );

  const refresh = useCallback(async () => await load(false), [load]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      cancelLoad();
      setState(emptyState(workspaceId, false));
      return;
    }
    void load(true);
    return () => {
      mountedRef.current = false;
      cancelLoad();
    };
  }, [cancelLoad, enabled, load, workspaceId]);

  useEffect(() => {
    if (!enabled || !pageLive) return;
    const timer = setInterval(() => {
      if (!requestRef.current.controller) void load(false);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, load, pageLive, pollIntervalMs]);

  useEffect(() => {
    if (!enabled || !options.sessionId) return;
    return registerSessionReconciler(
      options.sessionId,
      `computer-sessions:${workspaceId}`,
      refresh,
    );
  }, [enabled, options.sessionId, refresh, registerSessionReconciler, workspaceId]);

  const create = useCallback(
    async (
      request: Omit<CreateComputerSessionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<ComputerSessionMutationResponse> => {
      const response = await client.createComputerSession(workspaceId, {
        ...request,
        operationId: request.operationId ?? crypto.randomUUID(),
      });
      setState((current) => mergeSession(current, workspaceId, response.session));
      return response;
    },
    [client, workspaceId],
  );

  const end = useCallback(
    async (
      computerSessionId: string,
      operationId: string = crypto.randomUUID(),
    ): Promise<ComputerSessionMutationResponse> => {
      const response = await client.endComputerSession(workspaceId, computerSessionId, {
        operationId,
      });
      setState((current) => mergeSession(current, workspaceId, response.session));
      return response;
    },
    [client, workspaceId],
  );

  const relevantSessions = useMemo(
    () =>
      options.sessionId
        ? visible.sessions.filter((session) =>
            session.associations.some((association) => association.sessionId === options.sessionId),
          )
        : [],
    [options.sessionId, visible.sessions],
  );

  return {
    revision: visible.revision,
    sessions: visible.sessions,
    relevantSessions,
    loading: visible.loading,
    refreshing: visible.refreshing,
    error: visible.error,
    refresh,
    create,
    end,
  };
}

type ComputerRegistryState = {
  workspaceId: string;
  revision: number;
  sessions: ComputerSession[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
};

function emptyState(workspaceId: string, loading: boolean): ComputerRegistryState {
  return {
    workspaceId,
    revision: 0,
    sessions: [],
    loading,
    refreshing: false,
    error: null,
  };
}

function sortComputerSessions(sessions: readonly ComputerSession[]): ComputerSession[] {
  return [...sessions].sort((left, right) => {
    const live = Number(isLiveComputer(right)) - Number(isLiveComputer(left));
    return (
      live ||
      timestamp(right.lastUsedAt) - timestamp(left.lastUsedAt) ||
      left.id.localeCompare(right.id)
    );
  });
}

function isLiveComputer(session: ComputerSession): boolean {
  return !["ending", "ended", "failed", "lost"].includes(session.lifecycle);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeSession(
  current: ComputerRegistryState,
  workspaceId: string,
  session: ComputerSession,
): ComputerRegistryState {
  if (current.workspaceId !== workspaceId) return current;
  const sessions = current.sessions.filter((candidate) => candidate.id !== session.id);
  sessions.push(session);
  return { ...current, sessions: sortComputerSessions(sessions), error: null };
}

/** Exported for narrow proxy implementations and tests. */
export type ComputerSessionsClient = EmbeddedComputerInteractionClientLike;
