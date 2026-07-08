import type { ScheduledTask } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseScheduledTasksOptions = ClientOverride & {
  limit?: number | undefined;
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseScheduledTasksResult = {
  tasks: ScheduledTask[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/** List the workspace's scheduled tasks (drift checks, sentinels, reapers, ...). */
export function useScheduledTasks(options: UseScheduledTasksOptions = {}): UseScheduledTasksResult {
  const { client, workspaceId } = useOpenGeni(options);
  const limit = options.limit;
  const load = useCallback(
    async () => await client.listScheduledTasks(workspaceId, limit !== undefined ? { limit } : {}),
    [client, workspaceId, limit],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return {
    tasks: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  };
}
