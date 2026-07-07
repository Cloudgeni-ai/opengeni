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
  return event.type === "session.status.changed" || event.type === "session.created";
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
    { events: options.events, enabled },
  );
  return { lineage: state.data, loading: state.loading, error: state.error, refresh: state.refresh };
}
