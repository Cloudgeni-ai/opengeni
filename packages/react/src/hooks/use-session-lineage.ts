import type { SessionEvent, SessionLineageResponse } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useDebouncedCallback, usePolledValue, useSessionEventTrigger } from "./internal";

export type UseSessionLineageOptions = ClientOverride & {
  events?: SessionEvent[] | undefined;
  /** Refresh interval (ms). Off by default. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseSessionLineageResult = {
  lineage: SessionLineageResponse | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

export function isLineageRefreshEvent(event: SessionEvent): boolean {
  if (event.type === "session.status.changed" || event.type === "session.created") {
    return true;
  }
  // A child's creation never appears on the PARENT's stream as session.created —
  // the parent sees its own spawn as an agent.toolCall.* for session_create. The
  // output event is when the child exists server-side; refreshing on created too
  // keeps the "N agents" chip live while the spawn is still running.
  if (event.type === "agent.toolCall.created" || event.type === "agent.toolCall.output") {
    const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
    const name = typeof payload?.name === "string" ? payload.name : typeof payload?.toolName === "string" ? payload.toolName : "";
    return name === "session_create" || name.endsWith("__session_create");
  }
  return false;
}

/** Read the ancestors + descendant tree for one session. Data-only; no UI state. */
export function useSessionLineage(sessionId: string | null | undefined, options: UseSessionLineageOptions = {}): UseSessionLineageResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const load = useCallback(
    async () => sessionId ? await client.getSessionLineage(workspaceId, sessionId) : { ancestors: [], children: [] },
    [client, workspaceId, sessionId],
  );
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled });
  const refreshSoon = useDebouncedCallback(() => void state.refresh(), 150);
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
    { events: options.events, enabled: enabled && options.events !== undefined },
  );
  return { lineage: state.data, loading: state.loading, error: state.error, refresh: state.refresh };
}
