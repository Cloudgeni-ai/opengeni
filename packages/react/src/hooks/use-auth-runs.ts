import type {
  AuthRun,
  AuthRunMutationResponse,
  ProtectedAuthFillRequest,
  ProtectedAuthFillResponse,
  ReportAuthRunRequest,
  StartAuthRunRequest,
  VerifyAuthRunRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { useInteractionInvalidation } from "./use-interaction-invalidation";

export type UseAuthRunsOptions = EmbeddedBrowserInteractionClientOverride & {
  enabled?: boolean | undefined;
  browserSessionId?: string | null | undefined;
  siteAuthConnectionId?: string | null | undefined;
  includeSettled?: boolean | undefined;
};

export type UseAuthRunsResult = {
  runs: AuthRun[];
  loading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  start: (
    browserSessionId: string,
    request: Omit<StartAuthRunRequest, "operationId"> & { operationId?: string },
  ) => Promise<AuthRunMutationResponse>;
  report: (
    browserSessionId: string,
    authRunId: string,
    request: Omit<ReportAuthRunRequest, "operationId"> & { operationId?: string },
  ) => Promise<AuthRunMutationResponse>;
  protectedFill: (
    browserSessionId: string,
    authRunId: string,
    request: Omit<ProtectedAuthFillRequest, "operationId"> & { operationId?: string },
  ) => Promise<ProtectedAuthFillResponse>;
  verify: (
    browserSessionId: string,
    authRunId: string,
    request: Omit<VerifyAuthRunRequest, "operationId"> & { operationId?: string },
  ) => Promise<AuthRunMutationResponse>;
};

/** Live authentication state machines tied to exact browser document generations. */
export function useAuthRuns(options: UseAuthRunsOptions = {}): UseAuthRunsResult {
  const { client, workspaceId, workspaceInteractionEvent, workspaceInteractionConnectionState } =
    useEmbeddedBrowserInteraction(options);
  const enabled = options.enabled ?? true;
  const browserSessionId = options.browserSessionId ?? null;
  const siteAuthConnectionId = options.siteAuthConnectionId ?? null;
  const includeSettled = options.includeSettled ?? false;
  const key = `${workspaceId}:${browserSessionId ?? "*"}:${siteAuthConnectionId ?? "*"}:${includeSettled}`;
  const [state, setState] = useState(() => emptyState(key, enabled));
  const [mutationCount, setMutationCount] = useState(0);
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const mountedRef = useRef(true);
  const visible = state.key === key ? state : emptyState(key, enabled);

  const cancelLoad = useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, controller: null };
  }, []);

  const load = useCallback(
    async (foreground: boolean): Promise<void> => {
      if (!enabled) return;
      const id = requestRef.current.id + 1;
      requestRef.current.controller?.abort();
      const controller = new AbortController();
      requestRef.current = { id, controller };
      setState((current) => ({
        ...(current.key === key ? current : emptyState(key, true)),
        loading: foreground,
        refreshing: !foreground,
        error: foreground || current.key !== key ? null : current.error,
      }));
      try {
        const response = await client.listAuthRuns(workspaceId, {
          ...(browserSessionId ? { browserSessionId } : {}),
          ...(siteAuthConnectionId ? { siteAuthConnectionId } : {}),
          includeSettled,
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          key,
          runs: sortRuns(response.runs),
          loading: false,
          refreshing: false,
          error: null,
        });
      } catch (cause) {
        if (controller.signal.aborted || !mountedRef.current || requestRef.current.id !== id)
          return;
        setState((current) => ({
          ...(current.key === key ? current : emptyState(key, true)),
          loading: false,
          refreshing: false,
          error: asError(cause),
        }));
      } finally {
        if (requestRef.current.id === id) requestRef.current = { id, controller: null };
      }
    },
    [browserSessionId, client, enabled, includeSettled, key, siteAuthConnectionId, workspaceId],
  );

  const refresh = useCallback(async () => await load(false), [load]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      cancelLoad();
      setState(emptyState(key, false));
      return;
    }
    void load(true);
    return () => {
      mountedRef.current = false;
      cancelLoad();
    };
  }, [cancelLoad, enabled, key, load]);

  useInteractionInvalidation({
    workspaceId,
    key,
    enabled,
    event: workspaceInteractionEvent,
    connectionState: workspaceInteractionConnectionState,
    refresh,
  });

  const mutate = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
    setMutationCount((count) => count + 1);
    try {
      return await operation();
    } finally {
      if (mountedRef.current) setMutationCount((count) => Math.max(0, count - 1));
    }
  }, []);

  const merge = useCallback(
    (run: AuthRun) => {
      setState((current) => {
        if (current.key !== key) return current;
        const runs = current.runs.filter((candidate) => candidate.id !== run.id);
        const matches =
          (!browserSessionId || run.browserSessionId === browserSessionId) &&
          (!siteAuthConnectionId || run.siteAuthConnectionId === siteAuthConnectionId);
        if (matches && (includeSettled || !isSettled(run))) runs.push(run);
        return { ...current, runs: sortRuns(runs), error: null };
      });
    },
    [browserSessionId, includeSettled, key, siteAuthConnectionId],
  );

  const start = useCallback(
    async (
      scopeBrowserSessionId: string,
      request: Omit<StartAuthRunRequest, "operationId"> & { operationId?: string },
    ): Promise<AuthRunMutationResponse> =>
      await mutate(async () => {
        const response = await client.startBrowserAuthRun(workspaceId, scopeBrowserSessionId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.run);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  const report = useCallback(
    async (
      scopeBrowserSessionId: string,
      authRunId: string,
      request: Omit<ReportAuthRunRequest, "operationId"> & { operationId?: string },
    ): Promise<AuthRunMutationResponse> =>
      await mutate(async () => {
        const response = await client.reportBrowserAuthRun(
          workspaceId,
          scopeBrowserSessionId,
          authRunId,
          { ...request, operationId: request.operationId ?? crypto.randomUUID() },
        );
        merge(response.run);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  const protectedFill = useCallback(
    async (
      scopeBrowserSessionId: string,
      authRunId: string,
      request: Omit<ProtectedAuthFillRequest, "operationId"> & { operationId?: string },
    ): Promise<ProtectedAuthFillResponse> =>
      await mutate(async () => {
        const response = await client.protectedBrowserAuthFill(
          workspaceId,
          scopeBrowserSessionId,
          authRunId,
          { ...request, operationId: request.operationId ?? crypto.randomUUID() },
        );
        merge(response.run);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  const verify = useCallback(
    async (
      scopeBrowserSessionId: string,
      authRunId: string,
      request: Omit<VerifyAuthRunRequest, "operationId"> & { operationId?: string },
    ): Promise<AuthRunMutationResponse> =>
      await mutate(async () => {
        const response = await client.verifyBrowserAuthRun(
          workspaceId,
          scopeBrowserSessionId,
          authRunId,
          { ...request, operationId: request.operationId ?? crypto.randomUUID() },
        );
        merge(response.run);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  return {
    runs: visible.runs,
    loading: visible.loading,
    refreshing: visible.refreshing,
    mutating: mutationCount > 0,
    error: visible.error,
    refresh,
    start,
    report,
    protectedFill,
    verify,
  };
}

function emptyState(key: string, loading: boolean) {
  return {
    key,
    runs: [] as AuthRun[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortRuns(runs: readonly AuthRun[]): AuthRun[] {
  return [...runs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function isSettled(run: AuthRun): boolean {
  return run.state === "verified" || run.state === "failed" || run.state === "cancelled";
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type AuthRunsClient = EmbeddedBrowserInteractionClientLike;
