import {
  deliverSubscriptionCoreProviderWake,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
  subscriptionCorePersonalConnections,
  type Database,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";

const CORE_SUBSCRIPTION_SERVICE_SUBJECT = "service:subscription-core";

/**
 * After the SuperGrok receipt: one billing probe per exhausted connection
 * the work can use (design 5.3, EP-N22), never legacy rows.
 *
 * - Shared connections in this workspace's explicit context, as the core's
 *   service subject.
 * - With `personalTurn` (the exact accepted turn being placed or waiting):
 *   only the personal connections placement's personal authorization admits
 *   for that turn
 *   (its initiating human is the session owner, a private session or the
 *   owner's Personal workspace, the frozen v2 entry at the current
 *   authority generation, personal connections allowed), each read as the
 *   owner in their own Personal workspace (the administered
 *   `personal_owner` read). Any other turn reads no personal connection.
 *
 * A recovery wakes the organization's SuperGrok core waiters: a shared
 * connection can serve every workspace it reaches, and an owner's parked
 * private work may wait in any workspace. A failed probe never blocks
 * placement or a waiter; the stored state stands.
 */
export async function refreshExhaustedXaiCoreQuota(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  personalTurn?: SubscriptionCoreTurnIdentity | null;
  fetch?: typeof fetch;
}): Promise<void> {
  const deps = input.fetch ? { fetchImpl: input.fetch } : {};
  const recovered: string[] = [];
  try {
    recovered.push(
      ...(await subscriptionCoreOperationConnections(
        SUBSCRIPTION_CORE_XAI,
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
  if (input.personalTurn) {
    try {
      recovered.push(
        ...(await subscriptionCorePersonalConnections(
          SUBSCRIPTION_CORE_XAI,
        ).refreshExhaustedSubscriptionCoreTurnPersonalQuota(
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
    await deliverSubscriptionCoreProviderWake(input.db, SUBSCRIPTION_CORE_XAI_PROVIDER, {
      accountId: input.accountId,
      reason: "usage_recovered",
    }).catch(() => undefined);
  }
}
