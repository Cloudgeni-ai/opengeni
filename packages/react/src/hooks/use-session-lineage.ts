import type { SessionEvent, SessionLineageResponse } from "@opengeni/sdk";
import {
  createSessionLineageStore,
  isLineageRefreshEvent as isSdkLineageRefreshEvent,
} from "@opengeni/sdk/session";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useEmbeddedSessionLineage,
  type EmbeddedSessionLineageClientOverride,
} from "../session-context";
import { useOwnedExternalStore } from "./internal";

export type UseSessionLineageOptions = EmbeddedSessionLineageClientOverride & {
  events?: SessionEvent[] | undefined;
  /** Refresh interval (ms). Off by default. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
  /** Optional shared causal clock invoked when each network read starts. */
  beginRead?: (() => number) | undefined;
};

export type UseSessionLineageResult = {
  lineage: SessionLineageResponse | null;
  loading: boolean;
  error: Error | null;
  /** Causal generation captured when the accepted lineage read started. */
  readGeneration: number;
  refresh: () => Promise<void>;
};

export function isLineageRefreshEvent(event: SessionEvent): boolean {
  return isSdkLineageRefreshEvent(event);
}

/** React compatibility adapter over the framework-neutral lineage controller. */
export function useSessionLineage(
  sessionId: string | null | undefined,
  options: UseSessionLineageOptions = {},
): UseSessionLineageResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useEmbeddedSessionLineage(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedFeed = options.events !== undefined;
  const latestEvents = useRef(options.events);
  latestEvents.current = options.events;
  const store = useMemo(
    () =>
      createSessionLineageStore({
        client,
        workspaceId,
        sessionId,
        enabled,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(options.beginRead === undefined ? {} : { beginRead: options.beginRead }),
        ...(sharedFeed ? { events: latestEvents.current ?? [] } : {}),
      }),
    [
      client,
      enabled,
      options.beginRead,
      options.pollIntervalMs,
      sessionId,
      sharedFeed,
      workspaceId,
    ],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);

  useEffect(() => {
    if (options.events !== undefined) store.applyEvents(options.events);
  }, [options.events, store]);
  useEffect(() => {
    if (enabled && workspaceControlEvent) void store.refresh();
  }, [enabled, store, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "lineage", store.refresh);
  }, [enabled, registerSessionReconciler, sessionId, store]);

  return {
    lineage: snapshot.value,
    loading: snapshot.loading,
    error: snapshot.error,
    readGeneration: snapshot.readGeneration,
    refresh: store.refresh,
  };
}
