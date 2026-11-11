import {
  deliverSubscriptionCoreProviderWake,
  subscriptionCoreOperationConnections,
  subscriptionCorePersonalConnections,
  type Database,
  type SubscriptionCoreProvider,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import { subscriptionPersonalAuthorityForProviderV2 } from "@opengeni/contracts";

const CORE_SUBSCRIPTION_SERVICE_SUBJECT = "service:subscription-core";

/** A provider with personal subscription authority (Codex, Claude, SuperGrok). */
type PersonalAuthorityProvider = Parameters<typeof subscriptionPersonalAuthorityForProviderV2>[1];

/**
 * A stored exhaustion (or a model cooldown the adapter's usage read can end)
 * is re-read at most this often per connection, however many waiters
 * recheck: each waiter rechecks on the bounded backoff (at most every 15
 * minutes), so a parked turn sees an early provider reset within about 50
 * minutes instead of at a stale reset days away.
 */
export const CORE_USAGE_RECHECK_MIN_INTERVAL_MS = 30 * 60_000;

/**
 * The per-connection interval above counts from the last stored reading, so
 * a probe that stores nothing (the endpoint fails, or answers without
 * windows) would otherwise be repeated by every waiter's recheck. This worker
 * attempts one probe scope (a provider's shared pool in a workspace, or one
 * owner's personal connections) at most this often, whatever the outcome.
 */
export const CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS = 5 * 60_000;

const probeAttempts = new Map<string, number>();

/** Claims one probe attempt for `key` now, unless one ran within the interval. */
function claimProbeAttempt(key: string, now: number): boolean {
  const last = probeAttempts.get(key);
  if (last !== undefined && now - last < CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS) return false;
  if (probeAttempts.size >= 10_000) {
    for (const [stale, at] of probeAttempts) {
      if (now - at >= CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS) probeAttempts.delete(stale);
    }
  }
  probeAttempts.set(key, now);
  return true;
}

/** Test seam: forget every recorded probe attempt (every provider). */
export function resetCoreUsageProbeAttempts(): void {
  probeAttempts.clear();
}

/**
 * Before a parked core turn's reconcile, for a provider whose usage read can
 * end an exhaustion before its stored reset (its adapter's
 * `usageReadEndsQuotaExhaustion`): one usage read per blocked connection the
 * work can use whose stored quota was not observed within
 * `CORE_USAGE_RECHECK_MIN_INTERVAL_MS`, through the same core probe the usage
 * refresh routes use.
 *
 * - Shared connections in this workspace's explicit context, as the core's
 *   service subject.
 * - With `personalTurn` (the exact accepted turn that waits): only the
 *   personal connections placement's personal authorization admits for that
 *   turn, each read as the owner in their own Personal workspace.
 *
 * A recovery wakes the organization's core waiters of that provider. A failed
 * probe never blocks a waiter; the stored state stands. Each probe scope is
 * attempted at most once per `CORE_USAGE_PROBE_ATTEMPT_INTERVAL_MS` in this
 * worker.
 */
export async function refreshBlockedCoreQuotaBeforeReconcile(input: {
  provider: SubscriptionCoreProvider;
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  personalTurn?: SubscriptionCoreTurnIdentity | null;
  fetch?: typeof fetch;
  now?: number;
}): Promise<void> {
  const providerId = input.provider.adapter.provider;
  const now = input.now ?? Date.now();
  const deps = {
    minIntervalMs: CORE_USAGE_RECHECK_MIN_INTERVAL_MS,
    ...(input.fetch ? { fetchImpl: input.fetch } : {}),
  };
  const recovered: string[] = [];
  if (claimProbeAttempt(`${providerId}:${input.accountId}:${input.workspaceId}:shared`, now)) {
    try {
      recovered.push(
        ...(await subscriptionCoreOperationConnections(
          input.provider,
        ).refreshExhaustedSubscriptionCoreQuota(
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
  }
  const personal = input.personalTurn;
  if (
    personal &&
    claimProbeAttempt(
      `${providerId}:${input.accountId}:${input.workspaceId}:personal:${personal.sessionOwnerMembershipId}:${
        subscriptionPersonalAuthorityForProviderV2(
          personal.acceptedAuthorityV2,
          providerId as PersonalAuthorityProvider,
        )?.authorityGeneration ?? "none"
      }`,
      now,
    )
  ) {
    try {
      recovered.push(
        ...(await subscriptionCorePersonalConnections(
          input.provider,
        ).refreshExhaustedSubscriptionCoreTurnPersonalQuota(
          input.db,
          input.settings,
          personal,
          deps,
        )),
      );
    } catch {
      // The stored personal state stands.
    }
  }
  if (recovered.length > 0) {
    await deliverSubscriptionCoreProviderWake(input.db, providerId, {
      accountId: input.accountId,
      reason: "usage_recovered",
    }).catch(() => undefined);
  }
}
