import {
  deliverSubscriptionCoreCodexWake,
  refreshExhaustedSubscriptionCoreCodexQuota,
  refreshExhaustedSubscriptionCoreCodexTurnPersonalQuota,
  type Database,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";

const CORE_SUBSCRIPTION_SERVICE_SUBJECT = "service:subscription-core";

/**
 * A stored Codex exhaustion is re-read at most this often per connection,
 * however many waiters recheck: each waiter rechecks on the bounded backoff
 * (at most every 15 minutes), so a parked turn sees an early provider reset
 * within about 45 minutes instead of at a stale reset days away.
 */
export const CODEX_CORE_USAGE_RECHECK_MIN_INTERVAL_MS = 30 * 60_000;

/**
 * Before a parked Codex turn's reconcile: one `/wham/usage` read per
 * exhausted connection the work can use whose stored quota was not observed
 * within `CODEX_CORE_USAGE_RECHECK_MIN_INTERVAL_MS`, through the same core
 * probe the usage refresh route uses.
 *
 * - Shared connections in this workspace's explicit context, as the core's
 *   service subject.
 * - With `personalTurn` (the exact accepted turn that waits): only the
 *   personal connections placement's personal authorization admits for that
 *   turn, each read as the owner in their own Personal workspace.
 *
 * A recovery wakes the organization's Codex core waiters. A failed probe
 * never blocks a waiter; the stored state stands.
 */
export async function refreshExhaustedCodexCoreQuota(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  personalTurn?: SubscriptionCoreTurnIdentity | null;
  fetch?: typeof fetch;
}): Promise<void> {
  const deps = {
    minIntervalMs: CODEX_CORE_USAGE_RECHECK_MIN_INTERVAL_MS,
    ...(input.fetch ? { fetchImpl: input.fetch } : {}),
  };
  const recovered: string[] = [];
  try {
    recovered.push(
      ...(await refreshExhaustedSubscriptionCoreCodexQuota(
        input.db,
        input.settings,
        {
          kind: "workspace",
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: CORE_SUBSCRIPTION_SERVICE_SUBJECT,
        },
        deps,
      )),
    );
  } catch {
    // The stored shared state stands.
  }
  if (input.personalTurn) {
    try {
      recovered.push(
        ...(await refreshExhaustedSubscriptionCoreCodexTurnPersonalQuota(
          input.db,
          input.settings,
          input.personalTurn,
          deps,
        )),
      );
    } catch {
      // The stored personal state stands.
    }
  }
  if (recovered.length > 0) {
    await deliverSubscriptionCoreCodexWake(input.db, {
      accountId: input.accountId,
      reason: "usage_recovered",
    }).catch(() => undefined);
  }
}
