import type {
  CreateInteractionInterventionRequest,
  InteractionIntervention,
  InteractionInterventionMutationResponse,
  ResolveInteractionInterventionRequest,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedInterventionClientLike } from "../client";
import {
  type EmbeddedInterventionClientOverride,
  useEmbeddedInterventions,
} from "../session-context";
import { useInteractionInvalidation } from "./use-interaction-invalidation";

export type UseInteractionInterventionsOptions = EmbeddedInterventionClientOverride & {
  enabled?: boolean | undefined;
  resourceKind?: "browser_session" | "computer_session" | undefined;
  resourceId?: string | null | undefined;
  includeSettled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
};

export type UseInteractionInterventionsResult = {
  interventions: InteractionIntervention[];
  loading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (
    request: Omit<CreateInteractionInterventionRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<InteractionInterventionMutationResponse>;
  resolve: (
    interventionId: string,
    request: Omit<ResolveInteractionInterventionRequest, "operationId"> & {
      operationId?: string;
    },
  ) => Promise<InteractionInterventionMutationResponse>;
};

/** Human-action bridge shared by Browser and Computer surfaces. */
export function useInteractionInterventions(
  options: UseInteractionInterventionsOptions = {},
): UseInteractionInterventionsResult {
  const { client, workspaceId, workspaceInteractionEvent, workspaceInteractionConnectionState } =
    useEmbeddedInterventions(options);
  const enabled = (options.enabled ?? true) && options.resourceId !== null;
  const resourceKind = options.resourceKind;
  const resourceId = options.resourceId ?? undefined;
  const includeSettled = options.includeSettled ?? false;
  const key = `${workspaceId}:${resourceKind ?? "*"}:${resourceId ?? "*"}:${includeSettled}`;
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
    async (foreground: boolean, replace = true): Promise<void> => {
      if (!enabled) return;
      if (requestRef.current.controller && !replace) return;
      const id = requestRef.current.id + 1;
      requestRef.current.controller?.abort();
      const controller = new AbortController();
      requestRef.current = { id, controller };
      if (foreground || replace) {
        setState((current) => ({
          ...(current.key === key ? current : emptyState(key, true)),
          loading: foreground,
          refreshing: !foreground,
          error: foreground ? null : current.error,
        }));
      }
      try {
        const response = await client.listInteractionInterventions(workspaceId, {
          ...(resourceKind ? { resourceKind } : {}),
          ...(resourceId ? { resourceId } : {}),
          includeSettled,
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          key,
          interventions: sortInterventions(response.interventions),
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
    [client, enabled, includeSettled, key, resourceId, resourceKind, workspaceId],
  );

  const refresh = useCallback(async () => await load(false, true), [load]);

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
    fallbackPollIntervalMs: options.pollIntervalMs ?? 2_000,
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
    (intervention: InteractionIntervention) => {
      setState((current) => {
        if (current.key !== key) return current;
        const interventions = current.interventions.filter(
          (candidate) => candidate.id !== intervention.id,
        );
        const matches =
          (!resourceKind || intervention.resourceKind === resourceKind) &&
          (!resourceId || intervention.resourceId === resourceId);
        if (matches && (includeSettled || intervention.status === "open")) {
          interventions.push(intervention);
        }
        return {
          ...current,
          interventions: sortInterventions(interventions),
          error: null,
        };
      });
    },
    [includeSettled, key, resourceId, resourceKind],
  );

  const create = useCallback(
    async (
      request: Omit<CreateInteractionInterventionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<InteractionInterventionMutationResponse> =>
      await mutate(async () => {
        const response = await client.createInteractionIntervention(workspaceId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.intervention);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  const resolve = useCallback(
    async (
      interventionId: string,
      request: Omit<ResolveInteractionInterventionRequest, "operationId"> & {
        operationId?: string;
      },
    ): Promise<InteractionInterventionMutationResponse> =>
      await mutate(async () => {
        const response = await client.resolveInteractionIntervention(workspaceId, interventionId, {
          ...request,
          operationId: request.operationId ?? crypto.randomUUID(),
        });
        merge(response.intervention);
        return response;
      }),
    [client, merge, mutate, workspaceId],
  );

  return {
    interventions: visible.interventions,
    loading: visible.loading,
    refreshing: visible.refreshing,
    mutating: mutationCount > 0,
    error: visible.error,
    refresh,
    create,
    resolve,
  };
}

function emptyState(key: string, loading: boolean) {
  return {
    key,
    interventions: [] as InteractionIntervention[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortInterventions(
  interventions: readonly InteractionIntervention[],
): InteractionIntervention[] {
  return [...interventions].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type InteractionInterventionsClient = EmbeddedInterventionClientLike;
