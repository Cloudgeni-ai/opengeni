import {
  deliverSubscriptionCoreProviderWake,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
  subscriptionCorePersonalConnections,
  type Database,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { subscriptionPersonalAuthorityForProviderV2 } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";

const CORE_SUBSCRIPTION_SERVICE_SUBJECT = "service:subscription-core";

/**
 * The person whose own SuperGrok connections a core turn may use: the
 * session owner, only when the turn's accepted authority carries their
 * SuperGrok personal authority for exactly that membership. Null for any
 * other turn (shared capacity only).
 */
export function xaiCorePersonalSubject(identity: SubscriptionCoreTurnIdentity): string | null {
  const authority = subscriptionPersonalAuthorityForProviderV2(
    identity.acceptedAuthorityV2,
    SUBSCRIPTION_CORE_XAI_PROVIDER,
  );
  if (!authority || !identity.sessionOwnerSubjectId) return null;
  return authority.ownerMembershipId === identity.sessionOwnerMembershipId
    ? identity.sessionOwnerSubjectId
    : null;
}

/**
 * After the SuperGrok receipt: one billing probe per exhausted connection
 * the work can use (design 5.3, EP-N22), never legacy rows.
 *
 * - Shared connections in this workspace's explicit context, as the core's
 *   service subject.
 * - With `personalSubjectId` (a turn carrying that person's SuperGrok
 *   personal authority): that person's own personal connections, as the
 *   owner in their own Personal workspace (the administered
 *   `personal_owner` read).
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
  personalSubjectId?: string | null;
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
  if (input.personalSubjectId) {
    try {
      recovered.push(
        ...(await subscriptionCorePersonalConnections(
          SUBSCRIPTION_CORE_XAI,
        ).refreshExhaustedSubscriptionCorePersonalQuota(
          input.db,
          input.settings,
          { accountId: input.accountId, subjectId: input.personalSubjectId },
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
