/**
 * A person's own personal connections of one provider outside chat
 * placement (design 5.3, "Personal status and exhaustion re-read"), for
 * any provider:
 *
 * - the stored status and quota, through the owner-only reader (0707), in
 *   the workspace the person views (no credential material);
 * - the live re-read of a stored exhaustion, through the administered
 *   `personal_owner` probe in the owner's own Personal workspace.
 *
 * Both need the exact person (a `user:` subject with an active membership);
 * a service actor, another member or a revoked authority reads nothing.
 */
import type { Settings } from "@opengeni/config";
import { quotaCapacity } from "@opengeni/subscriptions";
import { withRlsContext, type Database } from "../database";
import { namedSubjectPersonalWorkspaceId } from "../slack-routing-personal-workspace";
import { decodeSubscriptionQuota } from "../subscription-core-repository";
import { listSubscriptionCorePersonalConnectionRowsInTransaction } from "./administration";
import {
  subscriptionCoreAdministeredConnections,
  type SubscriptionCoreAdministeredProbeDeps,
} from "./administered-connections";
import { memoByProvider } from "./provider";

export type SubscriptionCorePersonalConnection = {
  connectionId: string;
  label: string | null;
  providerAccountId: string | null;
  status: string;
};

export const subscriptionCorePersonalConnections = memoByProvider((provider) => {
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
   * Re-read live usage before a person's stored exhaustion is treated as
   * current (design 5.3, EP-N22 for personal connections): each of the
   * person's active personal connections whose stored quota is exhausted
   * now and was not observed within `minIntervalMs` is probed on its own,
   * as the owner in their own Personal workspace. Probe failures keep the
   * stored exhaustion. Returns the connections whose exhaustion ended (the
   * caller wakes waiters).
   */
  async function refreshExhaustedSubscriptionCorePersonalQuota(
    db: Database,
    settings: Settings,
    input: { accountId: string; subjectId: string },
    deps: SubscriptionCoreAdministeredProbeDeps & { minIntervalMs?: number; now?: number } = {},
  ): Promise<string[]> {
    if (!provider.adapter.fetchUsage || !provider.adapter.decodeQuota) return [];
    if (!input.subjectId.startsWith("user:")) return [];
    const workspaceId = await namedSubjectPersonalWorkspaceId(db, input);
    if (!workspaceId) return [];
    const now = deps.now ?? Date.now();
    const minIntervalMs = deps.minIntervalMs ?? 30_000;
    const scope = { accountId: input.accountId, workspaceId, subjectId: input.subjectId };
    const rows = await withRlsContext(db, { accountId: input.accountId, workspaceId }, (tx) =>
      listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, scope),
    );
    const stale = rows.filter((row) => {
      if (row.status !== "active") return false;
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
    refreshExhaustedSubscriptionCorePersonalQuota,
  };
});
