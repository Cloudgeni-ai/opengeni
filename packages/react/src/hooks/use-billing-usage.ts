import type { BillingBalance, UsageEvent } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeniClient, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseBillingUsageOptions = Pick<ClientOverride, "client"> & {
  /** Account to read. Defaults to the caller's default account server-side. */
  accountId?: string | undefined;
  /** Filter usage to one workspace. */
  workspaceId?: string | undefined;
  /** Refresh interval (ms) for live billing meters. Off by default. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseBillingUsageResult = {
  /** Prepaid credit balance (micro-USD), null until loaded. */
  balance: BillingBalance | null;
  /** Recent usage events (runs, tokens, cost, uploads, ...). */
  usage: UsageEvent[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/**
 * Account billing usage: credit balance + recent usage events — the data
 * behind per-call billing meters. Account-scoped, so it only needs the
 * client; pass `workspaceId` to narrow usage to one workspace.
 */
export function useBillingUsage(options: UseBillingUsageOptions = {}): UseBillingUsageResult {
  const client = useOpenGeniClient(options);
  const accountId = options.accountId;
  const workspaceId = options.workspaceId;
  const load = useCallback(
    async () =>
      await client.getBillingUsage({
        ...(accountId !== undefined ? { accountId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      }),
    [client, accountId, workspaceId],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return {
    balance: state.data?.balance ?? null,
    usage: state.data?.usage ?? [],
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  };
}
