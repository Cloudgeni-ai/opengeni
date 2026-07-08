import type { Session } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseWorkspaceSessionsOptions = ClientOverride & {
  limit?: number | undefined;
  parentSessionId?: string | null | undefined;
  /** Refresh interval (ms) for fleet/manager views. Off by default. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseWorkspaceSessionsResult = {
  sessions: Session[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/** List the workspace's sessions — the data behind fleet and manager views. */
export function useWorkspaceSessions(
  options: UseWorkspaceSessionsOptions = {},
): UseWorkspaceSessionsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const limit = options.limit;
  const parentSessionId = options.parentSessionId;
  const load = useCallback(
    async () =>
      await client.listSessions(workspaceId, {
        ...(limit !== undefined ? { limit } : {}),
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      }),
    [client, workspaceId, limit, parentSessionId],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return {
    sessions: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  };
}
