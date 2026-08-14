import type { BrowserDownload, BrowserDownloadSaveResponse } from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserInteractionClientLike } from "../client";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import { usePageLiveActivity } from "./internal";

export type UseBrowserDownloadsOptions = EmbeddedBrowserInteractionClientOverride & {
  browserSessionId: string | null;
  enabled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
};

export type BrowserDownloadSaveOptions = {
  operationId?: string | undefined;
  overwrite?: boolean | undefined;
};

export type UseBrowserDownloadsResult = {
  downloads: BrowserDownload[];
  loading: boolean;
  refreshing: boolean;
  savingDownloadIds: string[];
  error: Error | null;
  refresh: () => Promise<void>;
  saveToWorkspace: (
    downloadId: string,
    destinationPath: string,
    options?: BrowserDownloadSaveOptions,
  ) => Promise<BrowserDownloadSaveResponse>;
};

/** Exact browser-produced files for one BrowserSession. Bytes remain private
 * until `saveToWorkspace` performs the canonical workspace mutation. */
export function useBrowserDownloads(
  options: UseBrowserDownloadsOptions,
): UseBrowserDownloadsResult {
  const { client, workspaceId } = useEmbeddedBrowserInteraction(options);
  const browserSessionId = options.browserSessionId;
  const enabled = (options.enabled ?? true) && browserSessionId !== null;
  const pageLive = usePageLiveActivity();
  const pollIntervalMs = Math.max(750, options.pollIntervalMs ?? 2_000);
  const scope = browserSessionId ?? "none";
  const [state, setState] = useState(() => emptyState(scope, enabled));
  const [saving, setSaving] = useState<Record<string, number>>({});
  const visible = state.scope === scope ? state : emptyState(scope, enabled);
  const requestRef = useRef<{ id: number; controller: AbortController | null }>({
    id: 0,
    controller: null,
  });
  const mountedRef = useRef(true);
  const retryOperationsRef = useRef(new Map<string, string>());

  const cancelLoad = useCallback(() => {
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, controller: null };
  }, []);

  const load = useCallback(
    async (foreground: boolean): Promise<void> => {
      if (!enabled || !browserSessionId) return;
      const id = requestRef.current.id + 1;
      requestRef.current.controller?.abort();
      const controller = new AbortController();
      requestRef.current = { id, controller };
      setState((current) => ({
        ...(current.scope === scope ? current : emptyState(scope, true)),
        loading: foreground,
        refreshing: !foreground,
        error: foreground || current.scope !== scope ? null : current.error,
      }));
      try {
        const response = await client.listBrowserDownloads(workspaceId, browserSessionId, {
          signal: controller.signal,
        });
        if (!mountedRef.current || requestRef.current.id !== id) return;
        setState({
          scope,
          downloads: sortDownloads(response.downloads),
          loading: false,
          refreshing: false,
          error: null,
        });
      } catch (cause) {
        if (controller.signal.aborted || !mountedRef.current || requestRef.current.id !== id)
          return;
        setState((current) => ({
          ...(current.scope === scope ? current : emptyState(scope, true)),
          loading: false,
          refreshing: false,
          error: asError(cause),
        }));
      } finally {
        if (requestRef.current.id === id) requestRef.current = { id, controller: null };
      }
    },
    [browserSessionId, client, enabled, scope, workspaceId],
  );

  const refresh = useCallback(async () => await load(false), [load]);

  useEffect(() => {
    retryOperationsRef.current.clear();
    setSaving({});
  }, [scope]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      cancelLoad();
      setState(emptyState(scope, false));
      return () => {
        mountedRef.current = false;
        cancelLoad();
      };
    }
    void load(true);
    return () => {
      mountedRef.current = false;
      cancelLoad();
    };
  }, [cancelLoad, enabled, load, scope]);

  useEffect(() => {
    if (!enabled || !pageLive || Object.keys(saving).length > 0) return;
    const timer = setInterval(() => {
      if (!requestRef.current.controller) void refresh();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, pageLive, pollIntervalMs, refresh, saving]);

  const saveToWorkspace = useCallback(
    async (
      downloadId: string,
      destinationPath: string,
      saveOptions: BrowserDownloadSaveOptions = {},
    ): Promise<BrowserDownloadSaveResponse> => {
      if (!browserSessionId) throw new Error("No BrowserSession is selected.");
      const overwrite = saveOptions.overwrite ?? false;
      const attemptKey = `${browserSessionId}\u0000${downloadId}\u0000${destinationPath}\u0000${overwrite}`;
      const operationId =
        saveOptions.operationId ??
        retryOperationsRef.current.get(attemptKey) ??
        crypto.randomUUID();
      retryOperationsRef.current.set(attemptKey, operationId);
      setSaving((current) => ({ ...current, [downloadId]: (current[downloadId] ?? 0) + 1 }));
      try {
        const response = await client.saveBrowserDownload(
          workspaceId,
          browserSessionId,
          downloadId,
          { operationId, destinationPath, overwrite },
        );
        retryOperationsRef.current.delete(attemptKey);
        if (mountedRef.current) {
          setState((current) =>
            current.scope === scope
              ? {
                  ...current,
                  downloads: sortDownloads([
                    ...current.downloads.filter((download) => download.id !== response.download.id),
                    response.download,
                  ]),
                  error: null,
                }
              : current,
          );
        }
        return response;
      } finally {
        if (mountedRef.current) {
          setSaving((current) => {
            const count = (current[downloadId] ?? 1) - 1;
            if (count > 0) return { ...current, [downloadId]: count };
            const { [downloadId]: _removed, ...rest } = current;
            return rest;
          });
        }
      }
    },
    [browserSessionId, client, scope, workspaceId],
  );

  return {
    downloads: visible.downloads,
    loading: visible.loading,
    refreshing: visible.refreshing,
    savingDownloadIds: Object.keys(saving),
    error: visible.error,
    refresh,
    saveToWorkspace,
  };
}

function emptyState(scope: string, loading: boolean) {
  return {
    scope,
    downloads: [] as BrowserDownload[],
    loading,
    refreshing: false,
    error: null as Error | null,
  };
}

function sortDownloads(downloads: readonly BrowserDownload[]): BrowserDownload[] {
  return [...downloads].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type BrowserDownloadsClient = EmbeddedBrowserInteractionClientLike;
