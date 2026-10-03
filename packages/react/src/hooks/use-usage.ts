import type { OpenGeniClient } from "@opengeni/sdk";
import {
  getMyUsage,
  type UsageAllowancePeriod,
  type WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";

import { OpenGeniContext } from "../session-context";
import { summarizeUsage, type UsageSummary } from "../usage/summary";
import { usePolledValue } from "./internal";

/**
 * Anything that can read the signed-in member's own usage: the root SDK client
 * pointed at your session proxy (`getMyUsage`), or any client exposing
 * `requestJson` (for example the narrower browser client).
 */
export type UsageClientLike =
  | Pick<OpenGeniClient, "getMyUsage">
  | Pick<OpenGeniClient, "requestJson">;

export type UseUsageOptions = {
  /** Defaults to the `<OpenGeniProvider>` client. */
  client?: UsageClientLike | undefined;
  /** Defaults to the `<OpenGeniProvider>` workspace. */
  workspaceId?: string | undefined;
  /** `"current"` (default) or a `YYYY-MM` allowance period. */
  period?: UsageAllowancePeriod | undefined;
  /** Re-read on an interval. Off by default; usage changes only when work settles. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
  /**
   * Re-read whenever this value changes, keeping the current reading while it
   * loads. Pass something that changes when work settles (a turn count, the
   * session status) so the meter follows real usage without polling.
   */
  refreshKey?: unknown;
};

export type UseUsageResult = {
  /** The raw `/usage/me` response: the workspace pool and your own row. */
  usage: WorkspaceUsageResponse | null;
  /** What to tell this member; null until loaded. */
  summary: UsageSummary | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

function readOwnUsage(
  client: UsageClientLike,
  workspaceId: string,
  period: UsageAllowancePeriod | undefined,
  signal: AbortSignal | undefined,
): Promise<WorkspaceUsageResponse> {
  const query = period === undefined ? {} : { period };
  const options = signal ? { signal } : {};
  if ("getMyUsage" in client && typeof client.getMyUsage === "function") {
    return client.getMyUsage(workspaceId, query, options);
  }
  if ("requestJson" in client && typeof client.requestJson === "function") {
    return getMyUsage(client, workspaceId, query, options);
  }
  throw new Error("@opengeni/react: the usage client needs getMyUsage or requestJson.");
}

/**
 * The signed-in member's own usage in one workspace, read through `/usage/me`
 * (the session proxy serves exactly this route). Never reads another member.
 */
export function useUsage(options: UseUsageOptions = {}): UseUsageResult {
  const context = useContext(OpenGeniContext);
  const client = (options.client ?? context?.client) as UsageClientLike | undefined;
  const workspaceId = options.workspaceId ?? context?.workspaceId;
  if (!client || !workspaceId) {
    throw new Error(
      "@opengeni/react: useUsage needs a client and workspace. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId }.",
    );
  }
  const period = options.period;
  const load = useCallback(
    (signal?: AbortSignal) => readOwnUsage(client, workspaceId, period, signal),
    [client, workspaceId, period],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const refreshKey = options.refreshKey;
  const seenKey = useRef(refreshKey);
  const refresh = state.refresh;
  useEffect(() => {
    if (Object.is(seenKey.current, refreshKey)) return;
    seenKey.current = refreshKey;
    void refresh();
  }, [refreshKey, refresh]);
  const usage = state.data;
  const summary = useMemo(() => (usage ? summarizeUsage(usage) : null), [usage]);
  return { usage, summary, loading: state.loading, error: state.error, refresh };
}
