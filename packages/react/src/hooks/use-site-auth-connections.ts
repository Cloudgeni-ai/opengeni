import type {
  CreateSiteAuthConnectionRequest,
  SiteAuthConnection,
  SiteAuthConnectionMutationResponse,
  UpdateSiteAuthConnectionRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";

export type UseSiteAuthConnectionsOptions = EmbeddedBrowserInteractionClientOverride & {
  enabled?: boolean | undefined;
  includeArchived?: boolean | undefined;
};

export type UseSiteAuthConnectionsResult = {
  revision: number;
  connections: SiteAuthConnection[];
  loading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (
    request: Omit<CreateSiteAuthConnectionRequest, "operationId"> & { operationId?: string },
  ) => Promise<SiteAuthConnectionMutationResponse>;
  update: (
    connectionId: string,
    request: Omit<UpdateSiteAuthConnectionRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<SiteAuthConnectionMutationResponse>;
};

/** Secret-free workspace login recipes and their verified health. */
export function useSiteAuthConnections(
  options: UseSiteAuthConnectionsOptions = {},
): UseSiteAuthConnectionsResult {
  const { client, workspaceId } = useEmbeddedBrowserInteraction(options);
  const enabled = options.enabled ?? true;
  const includeArchived = options.includeArchived ?? false;
  const key = `${workspaceId}:${includeArchived ? "all" : "active"}`;
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
        const response = await client.listSiteAuthConnections(workspaceId, {
          includeArchived,
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          key,
          revision: response.revision,
          connections: sortConnections(response.connections),
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
    [client, enabled, includeArchived, key, workspaceId],
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

  const mutate = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
    setMutationCount((count) => count + 1);
    try {
      return await operation();
    } finally {
      if (mountedRef.current) setMutationCount((count) => Math.max(0, count - 1));
    }
  }, []);

  const merge = useCallback(
    (connection: SiteAuthConnection) => {
      setState((current) => {
        if (current.key !== key) return current;
        const connections = current.connections.filter(
          (candidate) => candidate.id !== connection.id,
        );
        if (includeArchived || connection.status !== "archived") connections.push(connection);
        return { ...current, connections: sortConnections(connections), error: null };
      });
    },
    [includeArchived, key],
  );

  const create = useCallback(
    async (
      request: Omit<CreateSiteAuthConnectionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<SiteAuthConnectionMutationResponse> =>
      await mutate(async () => {
        const response = await client.createSiteAuthConnection(workspaceId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.connection);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  const update = useCallback(
    async (
      connectionId: string,
      request: Omit<UpdateSiteAuthConnectionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<SiteAuthConnectionMutationResponse> =>
      await mutate(async () => {
        const response = await client.updateSiteAuthConnection(workspaceId, connectionId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.connection);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  return {
    revision: visible.revision,
    connections: visible.connections,
    loading: visible.loading,
    refreshing: visible.refreshing,
    mutating: mutationCount > 0,
    error: visible.error,
    refresh,
    create,
    update,
  };
}

function emptyState(key: string, loading: boolean) {
  return {
    key,
    revision: 0,
    connections: [] as SiteAuthConnection[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortConnections(connections: readonly SiteAuthConnection[]): SiteAuthConnection[] {
  return [...connections].sort(
    (left, right) =>
      Number(left.status === "archived") - Number(right.status === "archived") ||
      left.name.localeCompare(right.name) ||
      left.accountLabel.localeCompare(right.accountLabel),
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type SiteAuthConnectionsClient = EmbeddedBrowserInteractionClientLike;
