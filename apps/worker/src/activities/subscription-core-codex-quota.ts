import {
  subscriptionCoreProvider,
  type Database,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS,
  CORE_USAGE_RECHECK_MIN_INTERVAL_MS,
  refreshBlockedCoreQuotaBeforeReconcile,
  resetCoreUsageProbeAttempts,
} from "./subscription-core-usage-recheck";

/** Codex's per-connection re-read interval (the provider-neutral one). */
export const CODEX_CORE_USAGE_RECHECK_MIN_INTERVAL_MS = CORE_USAGE_RECHECK_MIN_INTERVAL_MS;

/** Codex's per-scope probe attempt interval (the provider-neutral one). */
export const CODEX_CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS = CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS;

/** Test seam: forget every recorded probe attempt. */
export function resetCodexCoreUsageProbeAttempts(): void {
  resetCoreUsageProbeAttempts();
}

/**
 * Before a parked Codex turn's reconcile: one `/wham/usage` read per
 * exhausted connection the work can use whose stored quota was not observed
 * within `CODEX_CORE_USAGE_RECHECK_MIN_INTERVAL_MS`, through the same core
 * probe the usage refresh route uses (`refreshBlockedCoreQuotaBeforeReconcile`
 * bound to Codex: shared connections as the core's service subject, and only
 * the personal connections the exact accepted turn admits).
 */
export async function refreshExhaustedCodexCoreQuota(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  personalTurn?: SubscriptionCoreTurnIdentity | null;
  fetch?: typeof fetch;
  now?: number;
}): Promise<void> {
  await refreshBlockedCoreQuotaBeforeReconcile({
    ...input,
    provider: subscriptionCoreProvider("codex"),
  });
}
