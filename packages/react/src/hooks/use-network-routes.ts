import type {
  CreateNetworkRouteRequest,
  NetworkRoute,
  NetworkRouteMutationResponse,
  UpdateNetworkRouteRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { useInteractionInvalidation } from "./use-interaction-invalidation";

export type UseNetworkRoutesOptions = EmbeddedBrowserInteractionClientOverride & {
  enabled?: boolean | undefined;
  includeArchived?: boolean | undefined;
};

export type UseNetworkRoutesResult = {
  revision: number;
  routes: NetworkRoute[];
  loading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (
    request: Omit<CreateNetworkRouteRequest, "operationId"> & { operationId?: string },
  ) => Promise<NetworkRouteMutationResponse>;
  update: (
    networkRouteId: string,
    request: Omit<UpdateNetworkRouteRequest, "operationId"> & { operationId?: string },
  ) => Promise<NetworkRouteMutationResponse>;
};

/** Workspace network-route registry. Route mutations never expose brokered credentials. */
export function useNetworkRoutes(options: UseNetworkRoutesOptions = {}): UseNetworkRoutesResult {
  const { client, workspaceId, workspaceInteractionEvent, workspaceInteractionConnectionState } =
    useEmbeddedBrowserInteraction(options);
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
        const response = await client.listNetworkRoutes(workspaceId, {
          includeArchived,
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          key,
          revision: response.revision,
          routes: sortRoutes(response.routes),
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

  const refresh = useCallback(async () => await load(false), [load]);
  useInteractionInvalidation({
    workspaceId,
    key,
    enabled,
    event: workspaceInteractionEvent,
    connectionState: workspaceInteractionConnectionState,
    knownRevision: visible.revision,
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
    (route: NetworkRoute) => {
      setState((current) => {
        if (current.key !== key) return current;
        const routes = current.routes.filter((candidate) => candidate.id !== route.id);
        if (includeArchived || route.status !== "archived") routes.push(route);
        return { ...current, routes: sortRoutes(routes), error: null };
      });
    },
    [includeArchived, key],
  );

  const create = useCallback(
    async (
      request: Omit<CreateNetworkRouteRequest, "operationId"> & { operationId?: string },
    ): Promise<NetworkRouteMutationResponse> =>
      await mutate(async () => {
        const response = await client.createNetworkRoute(workspaceId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.route);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  const update = useCallback(
    async (
      networkRouteId: string,
      request: Omit<UpdateNetworkRouteRequest, "operationId"> & { operationId?: string },
    ): Promise<NetworkRouteMutationResponse> =>
      await mutate(async () => {
        const response = await client.updateNetworkRoute(workspaceId, networkRouteId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.route);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  return {
    revision: visible.revision,
    routes: visible.routes,
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
    routes: [] as NetworkRoute[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortRoutes(routes: readonly NetworkRoute[]): NetworkRoute[] {
  return [...routes].sort(
    (left, right) =>
      Number(left.status === "archived") - Number(right.status === "archived") ||
      left.name.localeCompare(right.name),
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type NetworkRoutesClient = EmbeddedBrowserInteractionClientLike;
