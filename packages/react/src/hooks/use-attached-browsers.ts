import type { AttachedBrowserBridge, AttachedBrowserDevice } from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { useInteractionInvalidation } from "./use-interaction-invalidation";

export type UseAttachedBrowsersOptions = EmbeddedBrowserInteractionClientOverride & {
  enabled?: boolean | undefined;
  includeDisconnected?: boolean | undefined;
  pollIntervalMs?: number | undefined;
};

export type UseAttachedBrowsersResult = {
  revision: number;
  bridges: AttachedBrowserBridge[];
  devices: AttachedBrowserDevice[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/** Workspace-wide inventory of Chrome profiles currently connected through an
 * enrolled OpenGeni machine. BrowserSessions remain the execution authority. */
export function useAttachedBrowsers(
  options: UseAttachedBrowsersOptions = {},
): UseAttachedBrowsersResult {
  const { client, workspaceId, workspaceInteractionEvent, workspaceInteractionConnectionState } =
    useEmbeddedBrowserInteraction(options);
  const enabled = options.enabled ?? true;
  const includeDisconnected = options.includeDisconnected ?? false;
  const [state, setState] = useState(() => emptyState(workspaceId, enabled));
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
        const response = await client.listAttachedBrowsers(workspaceId, {
          includeDisconnected,
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          workspaceId,
          revision: response.revision,
          bridges: response.bridges,
          devices: sortDevices(response.devices),
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
    [client, enabled, includeDisconnected, workspaceId],
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
    key: `${workspaceId}:${includeDisconnected}`,
    enabled,
    event: workspaceInteractionEvent,
    connectionState: workspaceInteractionConnectionState,
    knownRevision: visible.revision,
    refresh,
    fallbackPollIntervalMs: options.pollIntervalMs,
  });

  return {
    revision: visible.revision,
    bridges: visible.bridges,
    devices: visible.devices,
    loading: visible.loading,
    refreshing: visible.refreshing,
    error: visible.error,
    refresh,
  };
}

function emptyState(workspaceId: string, loading: boolean) {
  return {
    workspaceId,
    revision: 0,
    bridges: [] as AttachedBrowserBridge[],
    devices: [] as AttachedBrowserDevice[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortDevices(devices: readonly AttachedBrowserDevice[]): AttachedBrowserDevice[] {
  return [...devices].sort(
    (left, right) =>
      Number(right.state === "connected") - Number(left.state === "connected") ||
      timestamp(right.lastSeenAt) - timestamp(left.lastSeenAt) ||
      left.name.localeCompare(right.name),
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Exported for narrow proxy implementations and tests. */
export type AttachedBrowsersClient = EmbeddedBrowserInteractionClientLike;
