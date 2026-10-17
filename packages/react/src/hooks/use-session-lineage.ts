import type { SessionEvent, SessionLineageResponse } from "@opengeni/sdk";
import { useCallback, useEffect, useRef } from "react";
import {
  useEmbeddedSessionLineage,
  type EmbeddedSessionLineageClientOverride,
} from "../session-context";
import { useRetainedSessionView } from "./session-view-cache";
import {
  projectionReadThrough,
  useDebouncedCallback,
  usePolledValue,
  useSessionEventTrigger,
} from "./internal";

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
  if (event.type === "session.status.changed" || event.type === "session.created") {
    return true;
  }
  // A child's creation never appears on the PARENT's stream as session.created —
  // the parent sees its own spawn as an agent.toolCall.* for session_create.
  // Created events are handled separately so they can refresh immediately and
  // once after the child row has had time to commit.
  if (event.type === "agent.toolCall.output") {
    const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
    const name =
      typeof payload?.name === "string"
        ? payload.name
        : typeof payload?.toolName === "string"
          ? payload.toolName
          : "";
    return name === "session_create" || name.endsWith("__session_create");
  }
  return false;
}

function isSessionCreateToolCallCreated(event: SessionEvent): boolean {
  if (event.type !== "agent.toolCall.created") {
    return false;
  }
  const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
  const name =
    typeof payload?.name === "string"
      ? payload.name
      : typeof payload?.toolName === "string"
        ? payload.toolName
        : "";
  return name === "session_create" || name.endsWith("__session_create");
}

/** Read the ancestors + descendant tree for one session. Data-only; no UI state. */
export function useSessionLineage(
  sessionId: string | null | undefined,
  options: UseSessionLineageOptions = {},
): UseSessionLineageResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useEmbeddedSessionLineage(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const nextReadGeneration = useRef(0);
  const beginRead = options.beginRead;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId) {
        return {
          lineage: { ancestors: [], children: [], truncated: false },
          readGeneration: 0,
        };
      }
      let readGeneration = 0;
      const lineage = await client.getSessionLineage(workspaceId, sessionId, {
        signal,
        onRequestStart: (sharedReadGeneration) => {
          readGeneration = sharedReadGeneration ?? beginRead?.() ?? ++nextReadGeneration.current;
        },
      });
      return {
        lineage,
        readGeneration,
      };
    },
    [beginRead, client, workspaceId, sessionId],
  );
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled });
  const refresh = state.refresh;
  useEffect(() => {
    if (enabled && workspaceControlEvent) void refresh();
  }, [enabled, refresh, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "lineage", refresh);
  }, [enabled, refresh, registerSessionReconciler, sessionId]);
  const refreshSoon = useDebouncedCallback(() => void refresh(), 150);
  const delayedChildRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear a pending delayed refresh on session/workspace SWITCH (not just
  // unmount): otherwise a timer scheduled for the previous session can fire
  // ~2.5s later and commit that session's lineage onto the new one.
  useEffect(() => {
    return () => {
      if (delayedChildRefreshRef.current !== null) {
        clearTimeout(delayedChildRefreshRef.current);
        delayedChildRefreshRef.current = null;
      }
    };
  }, [sessionId, workspaceId]);
  const refreshAfterChildCreate = useCallback(() => {
    void refresh();
    if (delayedChildRefreshRef.current !== null) {
      clearTimeout(delayedChildRefreshRef.current);
    }
    delayedChildRefreshRef.current = setTimeout(() => {
      delayedChildRefreshRef.current = null;
      void refresh();
    }, 2500);
  }, [refresh]);
  // Lineage reflects this session's events through the sequence its read
  // observed; only a later spawn or status change can add or move children.
  const readThrough = projectionReadThrough(state.data?.lineage, state.loading);
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isLineageRefreshEvent,
    refreshSoon,
    // SHARED-FEED ONLY: without a caller-provided events log the trigger would
    // open its OWN streamEvents tail — a second live SSE connection next to the
    // session route's useSessionEvents. A caller with no feed opts into polling
    // (pollIntervalMs), never a duplicate stream.
    { events: options.events, enabled: enabled && options.events !== undefined, readThrough },
  );
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isSessionCreateToolCallCreated,
    refreshAfterChildCreate,
    { events: options.events, enabled: enabled && options.events !== undefined, readThrough },
  );
  // Until the first read lands, show the lineage as it was when this
  // conversation was last left (only when the host retains reads).
  const retainedLineage = useRetainedSessionView(
    client,
    workspaceId,
    sessionId,
    "lineage",
    state.data?.lineage ?? null,
    { enabled },
  );
  return {
    lineage: state.data?.lineage ?? retainedLineage,
    loading: state.loading && retainedLineage === null,
    error: state.error,
    readGeneration: state.data?.readGeneration ?? 0,
    refresh,
  };
}
