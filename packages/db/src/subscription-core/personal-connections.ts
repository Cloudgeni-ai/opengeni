/**
 * A person's own personal connections of one provider outside chat
 * placement (design 5.3, "Personal status and exhaustion re-read"), for
 * any provider:
 *
 * - the stored status and quota, through the owner-only reader (0707), in
 *   the workspace the person views (no credential material);
 * - the live re-read of a stored exhaustion before an exact accepted turn
 *   is placed, only for the connections placement's personal authorization admits for that turn, and
 *   through the administered `personal_owner` probe in the owner's own
 *   Personal workspace.
 *
 * The stored read needs the exact person (a `user:` subject with an active
 * membership). The re-read needs everything placement needs for a personal
 * connection: the turn's initiating human is the session owner, a private
 * session or the owner's Personal workspace, the turn's frozen v2 entry at
 * the connection's current authority generation, and the organization's
 * effective personal-connections rule. A service actor, another member, a
 * background or shared-only turn and a revoked authority read nothing.
 */
import { sql } from "drizzle-orm";
import type { Settings } from "@opengeni/config";
import { subscriptionPersonalAuthorityForProviderV2 } from "@opengeni/contracts";
import { quotaCapacity } from "@opengeni/subscriptions";
import { rawRows, withRlsContext, type Database } from "../database";
import { namedSubjectPersonalWorkspaceId } from "../slack-routing-personal-workspace";
import { decodeSubscriptionQuota } from "../subscription-core-repository";
import { withSubscriptionCoreAcceptedTurn } from "../subscription-core-placement-world";
import { listSubscriptionCorePersonalConnectionRowsInTransaction } from "./administration";
import {
  subscriptionCoreAdministeredConnections,
  type SubscriptionCoreAdministeredProbeDeps,
} from "./administered-connections";
import { memoByProvider, subscriptionCoreProviderId } from "./provider";
import { subscriptionCoreTurns, type SubscriptionCoreTurnIdentity } from "./turns";

export type SubscriptionCorePersonalConnection = {
  connectionId: string;
  label: string | null;
  providerAccountId: string | null;
  status: string;
};

export const subscriptionCorePersonalConnections = memoByProvider((provider) => {
  const providerId = subscriptionCoreProviderId(provider);

  /**
   * The viewing person's own personal connections as the workspace they
   * view may show them, and whether that workspace is their own Personal
   * workspace (the only place a personal connection is the effective one
   * without an explicit selection). Empty for anyone else and without an
   * enabled cutover (the owner-only reader decides).
   */
  async function readSubscriptionCorePersonalConnections(
    db: Database,
    input: { accountId: string; workspaceId: string; subjectId: string },
  ): Promise<{ connections: SubscriptionCorePersonalConnection[]; ownPersonalWorkspace: boolean }> {
    if (!input.subjectId.startsWith("user:"))
      return { connections: [], ownPersonalWorkspace: false };
    const personalWorkspaceId = await namedSubjectPersonalWorkspaceId(db, input);
    const rows = await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      (tx) => listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, input),
    );
    return {
      connections: rows.map((row) => ({
        connectionId: row.id,
        label: row.label,
        providerAccountId: row.provider_account_id,
        status: row.status,
      })),
      ownPersonalWorkspace: personalWorkspaceId === input.workspaceId,
    };
  }

  /**
   * The personal connections placement's personal authorization admits for an exact accepted turn:
   * placement's own authorization (the frozen v2 entry, minted per
   * connection at its current authority generation by
   * `authorize_subscription_personal_placement_access`), then the personal
   * rows that transaction can see, which are exactly those it minted.
   * Empty for any turn without that entry for the session owner, and on
   * any refusal.
   */
  async function turnPersonalConnectionIds(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
  ): Promise<string[]> {
    const personal = subscriptionPersonalAuthorityForProviderV2(
      identity.acceptedAuthorityV2,
      providerId as Parameters<typeof subscriptionPersonalAuthorityForProviderV2>[1],
    );
    if (
      !personal ||
      !identity.sessionOwnerSubjectId ||
      identity.initiatingHumanSubjectId !== identity.sessionOwnerSubjectId ||
      identity.sessionOwnerMembershipId !== personal.ownerMembershipId
    )
      return [];
    const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
      if (
        !(await subscriptionCoreTurns(provider).authorizeSubscriptionCoreFrozenPersonal(
          tx,
          identity,
        ))
      )
        return [];
      const rows = await rawRows<{ id: string }>(
        tx,
        sql`select id::text as id from subscription_connections
          where account_id = ${identity.accountId}::uuid and provider = ${providerId}
            and ownership = 'personal' and owner_subject_id = ${identity.sessionOwnerSubjectId}
            and status = 'active'`,
      );
      return rows.map((row) => row.id);
    });
    return access.status === "completed" ? access.value : [];
  }

  /**
   * Re-read live usage before a stored personal exhaustion is treated as
   * current for an exact accepted turn (design 5.3, EP-N22 for personal
   * connections): of the connections placement's personal authorization admits for that turn (see
   * `turnPersonalConnectionIds`), each active one whose stored quota is
   * exhausted now and was not observed within `minIntervalMs` is probed on
   * its own, as the owner in their own Personal workspace. Probe failures
   * keep the stored exhaustion. Returns the connections whose exhaustion
   * ended (the caller wakes waiters).
   */
  async function refreshExhaustedSubscriptionCoreTurnPersonalQuota(
    db: Database,
    settings: Settings,
    identity: SubscriptionCoreTurnIdentity,
    deps: SubscriptionCoreAdministeredProbeDeps & { minIntervalMs?: number; now?: number } = {},
  ): Promise<string[]> {
    if (!provider.adapter.fetchUsage || !provider.adapter.decodeQuota) return [];
    const subjectId = identity.sessionOwnerSubjectId;
    if (!subjectId?.startsWith("user:")) return [];
    const granted = new Set(await turnPersonalConnectionIds(db, identity));
    if (granted.size === 0) return [];
    const accountId = identity.accountId;
    const workspaceId = await namedSubjectPersonalWorkspaceId(db, { accountId, subjectId });
    if (!workspaceId) return [];
    const now = deps.now ?? Date.now();
    const minIntervalMs = deps.minIntervalMs ?? 30_000;
    const scope = { accountId, workspaceId, subjectId };
    const rows = await withRlsContext(db, { accountId, workspaceId }, (tx) =>
      listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, scope),
    );
    const stale = rows.filter((row) => {
      if (!granted.has(row.id) || row.status !== "active") return false;
      const quota = decodeSubscriptionQuota(row);
      if (!quota || quotaCapacity(quota, now).kind !== "exhausted") return false;
      const updatedAt = row.quota_updated_at ? new Date(row.quota_updated_at).getTime() : 0;
      return now - updatedAt >= minIntervalMs;
    });
    const { minIntervalMs: _interval, now: _now, ...probeDeps } = deps;
    const recovered: string[] = [];
    for (const row of stale) {
      const probe = await subscriptionCoreAdministeredConnections(
        provider,
      ).probeSubscriptionCoreAdministeredConnectionUsage(
        db,
        settings,
        { kind: "personal_owner", ...scope },
        row.id,
        probeDeps,
      );
      if (probe.kind === "read" && probe.recovered) recovered.push(row.id);
    }
    return recovered;
  }

  return {
    readSubscriptionCorePersonalConnections,
    refreshExhaustedSubscriptionCoreTurnPersonalQuota,
  };
});
