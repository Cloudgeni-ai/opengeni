import type {
  BrowserIdentity,
  BrowserIdentityMutationResponse,
  BrowserRevisionListResponse,
  CreateBrowserIdentityRequest,
  PublishBrowserRevisionRequest,
  PublishBrowserRevisionResponse,
  UpdateBrowserIdentityRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { useInteractionInvalidation } from "./use-interaction-invalidation";

export type UseBrowserIdentitiesOptions = EmbeddedBrowserInteractionClientOverride & {
  enabled?: boolean | undefined;
  includeArchived?: boolean | undefined;
};

export type UseBrowserIdentitiesResult = {
  revision: number;
  identities: BrowserIdentity[];
  loading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (
    request: Omit<CreateBrowserIdentityRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<BrowserIdentityMutationResponse>;
  update: (
    identityId: string,
    request: Omit<UpdateBrowserIdentityRequest, "operationId"> & { operationId?: string },
  ) => Promise<BrowserIdentityMutationResponse>;
  revisions: (identityId: string) => Promise<BrowserRevisionListResponse>;
  publish: (
    browserSessionId: string,
    request: Omit<PublishBrowserRevisionRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<PublishBrowserRevisionResponse>;
};

/** Workspace browser-profile library and explicit immutable-version mutations. */
export function useBrowserIdentities(
  options: UseBrowserIdentitiesOptions = {},
): UseBrowserIdentitiesResult {
  const { client, workspaceId, workspaceInteractionEvent, workspaceInteractionConnectionState } =
    useEmbeddedBrowserInteraction(options);
  const enabled = options.enabled ?? true;
  const includeArchived = options.includeArchived ?? false;
  const [state, setState] = useState(() => emptyState(workspaceId, enabled));
  const [mutationCount, setMutationCount] = useState(0);
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
        const response = await client.listBrowserIdentities(workspaceId, {
          includeArchived,
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          workspaceId,
          revision: response.revision,
          identities: sortIdentities(response.identities),
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
    [client, enabled, includeArchived, workspaceId],
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

  useInteractionInvalidation({
    workspaceId,
    key: workspaceId,
    enabled,
    event: workspaceInteractionEvent,
    connectionState: workspaceInteractionConnectionState,
    knownRevision: visibleState.revision,
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

  const create = useCallback(
    async (
      request: Omit<CreateBrowserIdentityRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<BrowserIdentityMutationResponse> =>
      await mutate(async () => {
        const response = await client.createBrowserIdentity(workspaceId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        setState((current) => mergeIdentity(current, workspaceId, response.identity));
        return response;
      }),
    [client, mutate, workspaceId],
  );

  const revisions = useCallback(
    async (identityId: string): Promise<BrowserRevisionListResponse> =>
      await client.listBrowserRevisions(workspaceId, identityId),
    [client, workspaceId],
  );

  const update = useCallback(
    async (
      identityId: string,
      request: Omit<UpdateBrowserIdentityRequest, "operationId"> & { operationId?: string },
    ): Promise<BrowserIdentityMutationResponse> =>
      await mutate(async () => {
        const response = await client.updateBrowserIdentity(workspaceId, identityId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        setState((current) =>
          mergeIdentity(current, workspaceId, response.identity, includeArchived),
        );
        return response;
      }),
    [client, includeArchived, mutate, workspaceId],
  );

  const publish = useCallback(
    async (
      browserSessionId: string,
      request: Omit<PublishBrowserRevisionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<PublishBrowserRevisionResponse> =>
      await mutate(async () => {
        const response = await client.publishBrowserRevision(workspaceId, browserSessionId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        setState((current) => mergeIdentity(current, workspaceId, response.identity));
        return response;
      }),
    [client, mutate, workspaceId],
  );

  return {
    revision: visibleState.revision,
    identities: visibleState.identities,
    loading: visibleState.loading,
    refreshing: visibleState.refreshing,
    mutating: mutationCount > 0,
    error: visibleState.error,
    refresh,
    create,
    update,
    revisions,
    publish,
  };
}

function emptyState(workspaceId: string, loading: boolean) {
  return {
    workspaceId,
    revision: 0,
    identities: [] as BrowserIdentity[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortIdentities(identities: readonly BrowserIdentity[]): BrowserIdentity[] {
  return [...identities].sort(
    (left, right) =>
      timestamp(right.updatedAt) - timestamp(left.updatedAt) || left.name.localeCompare(right.name),
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeIdentity(
  current: ReturnType<typeof emptyState>,
  workspaceId: string,
  identity: BrowserIdentity,
  includeArchived = false,
): ReturnType<typeof emptyState> {
  if (current.workspaceId !== workspaceId) return current;
  return {
    ...current,
    identities: sortIdentities(
      identity.status === "archived" && !includeArchived
        ? current.identities.filter((candidate) => candidate.id !== identity.id)
        : [...current.identities.filter((candidate) => candidate.id !== identity.id), identity],
    ),
    error: null,
  };
}

/** Exported for narrow proxy implementations and tests. */
export type BrowserIdentitiesClient = EmbeddedBrowserInteractionClientLike;
