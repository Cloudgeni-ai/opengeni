import type {
  BrowserSession,
  BrowserSessionMutationResponse,
  CreateBrowserSessionRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { usePageLiveActivity } from "./internal";

export type UseBrowserSessionsOptions = EmbeddedBrowserInteractionClientOverride & {
  /** Current agent/session relevance. Workspace peers remain in `sessions`. */
  sessionId?: string | undefined;
  enabled?: boolean | undefined;
  /** Temporary invalidation path until the interaction event stream lands. */
  pollIntervalMs?: number | undefined;
};

export type UseBrowserSessionsResult = {
  revision: number;
  sessions: BrowserSession[];
  relevantSessions: BrowserSession[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (
    request: Omit<CreateBrowserSessionRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<BrowserSessionMutationResponse>;
  suspend: (
    browserSessionId: string,
    operationId?: string,
  ) => Promise<BrowserSessionMutationResponse>;
  resume: (
    browserSessionId: string,
    operationId?: string,
  ) => Promise<BrowserSessionMutationResponse>;
  end: (browserSessionId: string, operationId?: string) => Promise<BrowserSessionMutationResponse>;
};

/**
 * Workspace-wide BrowserSession registry. Associations rank relevance but never
 * hide peer resources; no explicit share ceremony or per-view ownership exists.
 */
export function useBrowserSessions(
  options: UseBrowserSessionsOptions = {},
): UseBrowserSessionsResult {
  const { client, workspaceId, registerSessionReconciler } = useEmbeddedBrowserInteraction(options);
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 3_000);
  const [state, setState] = useState<{
    workspaceId: string;
    revision: number;
    sessions: BrowserSession[];
    loading: boolean;
    refreshing: boolean;
    error: Error | null;
  }>(() => emptyState(workspaceId, enabled));
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const mountedRef = useRef(true);

  const visibleState = state.workspaceId === workspaceId ? state : emptyState(workspaceId, enabled);

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
        const response = await client.listBrowserSessions(workspaceId, {
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          workspaceId,
          revision: response.revision,
          sessions: sortBrowserSessions(response.sessions),
          loading: false,
          refreshing: false,
          error: null,
        });
      } catch (cause) {
        if (controller.signal.aborted || !mountedRef.current || requestRef.current.id !== id)
          return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((current) => ({
          ...(current.workspaceId === workspaceId ? current : emptyState(workspaceId, true)),
          loading: false,
          refreshing: false,
          error,
        }));
      } finally {
        if (requestRef.current.id === id) {
          requestRef.current = { id, controller: null };
        }
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
      // Let a slow list request finish. A poll must not repeatedly abort and
      // restart the same read; an explicit Refresh may still replace it.
      if (!requestRef.current.controller) void load(false);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, load, pageLive, pollIntervalMs]);

  useEffect(() => {
    if (!enabled || !options.sessionId) return;
    return registerSessionReconciler(options.sessionId, `browser-sessions:${workspaceId}`, refresh);
  }, [enabled, options.sessionId, refresh, registerSessionReconciler, workspaceId]);

  const create = useCallback(
    async (
      request: Omit<CreateBrowserSessionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<BrowserSessionMutationResponse> => {
      const response = await client.createBrowserSession(workspaceId, {
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
      browserSessionId: string,
      operationId: string = crypto.randomUUID(),
    ): Promise<BrowserSessionMutationResponse> => {
      const response = await client.endBrowserSession(workspaceId, browserSessionId, {
        operationId,
      });
      setState((current) => mergeSession(current, workspaceId, response.session));
      return response;
    },
    [client, workspaceId],
  );

  const suspend = useCallback(
    async (
      browserSessionId: string,
      operationId: string = crypto.randomUUID(),
    ): Promise<BrowserSessionMutationResponse> => {
      const response = await client.suspendBrowserSession(workspaceId, browserSessionId, {
        operationId,
      });
      setState((current) => mergeSession(current, workspaceId, response.session));
      return response;
    },
    [client, workspaceId],
  );

  const resume = useCallback(
    async (
      browserSessionId: string,
      operationId: string = crypto.randomUUID(),
    ): Promise<BrowserSessionMutationResponse> => {
      const response = await client.resumeBrowserSession(workspaceId, browserSessionId, {
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
        ? visibleState.sessions.filter((session) =>
            session.associations.some((association) => association.sessionId === options.sessionId),
          )
        : [],
    [options.sessionId, visibleState.sessions],
  );

  return {
    revision: visibleState.revision,
    sessions: visibleState.sessions,
    relevantSessions,
    loading: visibleState.loading,
    refreshing: visibleState.refreshing,
    error: visibleState.error,
    refresh,
    create,
    suspend,
    resume,
    end,
  };
}

function emptyState(workspaceId: string, loading: boolean) {
  return {
    workspaceId,
    revision: 0,
    sessions: [] as BrowserSession[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortBrowserSessions(sessions: readonly BrowserSession[]): BrowserSession[] {
  return [...sessions].sort((left, right) => {
    const live = Number(isLiveBrowser(right)) - Number(isLiveBrowser(left));
    return (
      live ||
      timestamp(right.lastUsedAt) - timestamp(left.lastUsedAt) ||
      left.id.localeCompare(right.id)
    );
  });
}

function isLiveBrowser(session: BrowserSession): boolean {
  return !["ending", "ended", "failed", "lost"].includes(session.lifecycle);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeSession(
  current: ReturnType<typeof emptyState>,
  workspaceId: string,
  session: BrowserSession,
): ReturnType<typeof emptyState> {
  if (current.workspaceId !== workspaceId) return current;
  const sessions = current.sessions.filter((candidate) => candidate.id !== session.id);
  sessions.push(session);
  return { ...current, sessions: sortBrowserSessions(sessions), error: null };
}

/** Exported for narrow proxy implementations and tests. */
export type BrowserSessionsClient = EmbeddedBrowserInteractionClientLike;
