import { and, eq, inArray, sql } from "drizzle-orm";
import type { ProviderId } from "@opengeni/subscriptions";
import {
  rawRows,
  setRlsContext,
  withRlsContext,
  type Database,
  type SessionActivityDatabase,
} from "../database";
import * as schema from "../schema";
import { readSubscriptionProviderCutoverState } from "../subscription-core-repository";
import { subscriptionCoreProvider } from "../subscription-core-providers";
import { withPoolWakeServiceScopeInTransaction } from "../subscription-session-access";

/**
 * Delete the shared subscription core's waiters for one provider of turns
 * whose wait a human or control transition ended (Steer, Cancel), inside
 * that transition. A core waiter exists only while its turn waits, so unlike
 * the legacy waiter there is no `superseded` status to keep; its pending
 * wake deliveries cascade. Runs under the caller's workspace RLS.
 */
export async function deleteSubscriptionCoreWaitersForTurns(
  db: Database | SessionActivityDatabase,
  provider: ProviderId,
  input: { workspaceId: string; turnIds: readonly string[]; sessionId?: string },
): Promise<number> {
  subscriptionCoreProvider(provider);
  if (input.turnIds.length === 0) return 0;
  const deleted = await db
    .delete(schema.subscriptionCapacityWaiters)
    .where(
      and(
        eq(schema.subscriptionCapacityWaiters.workspaceId, input.workspaceId),
        ...(input.sessionId
          ? [eq(schema.subscriptionCapacityWaiters.sessionId, input.sessionId)]
          : []),
        eq(schema.subscriptionCapacityWaiters.provider, provider),
        inArray(schema.subscriptionCapacityWaiters.turnId, [...input.turnIds]),
      ),
    )
    .returning({ waiterId: schema.subscriptionCapacityWaiters.waiterId });
  return deleted.length;
}

/** A capacity change of one provider's pool that its waiting turns may need. */
export type SubscriptionCoreCapacityWake = {
  accountId: string;
  /** A bounded identifier recorded on each woken waiter. */
  reason: string;
  /** Only these workspaces; every workspace of the organization when absent. */
  workspaceIds?: readonly string[];
  /**
   * Only these sessions' waiters (for example a session pin, which changes
   * nothing another session can place on). Requires exactly one workspace in
   * `workspaceIds`.
   */
  sessionIds?: readonly string[];
};

/** One workspace whose core waiters were woken; deliver its outbox after commit. */
export type SubscriptionCoreWakeScope = { accountId: string; workspaceId: string };

/**
 * Records the generic durable session workflow wake in the caller's
 * transaction (the session workflow wake outbox producer).
 */
export type SubscriptionCoreSessionWorkflowWake = (
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
    reason: string;
  },
) => Promise<unknown>;

/**
 * Capacity changed for one provider's pool of the account (a quota
 * exhaustion ended, a quarantine cleared, a plan changed, a binding or
 * assignment changed): advance the wake revision of every waiting core
 * waiter of that provider, record the typed wake in the provider-neutral
 * outbox and the generic session workflow wake in the same transaction.
 * Wakes only request re-evaluation; each waiter re-places under its own
 * accepted turn. Runs in the trusted empty-subject worker scope per
 * workspace (the outbox's own policy), never through legacy active pointers,
 * and only while the provider's cutover is enabled for the account. Returns
 * the workspaces whose outbox the caller should drain after commit.
 */
export async function wakeSubscriptionCoreCapacityWaiters(
  db: Database,
  provider: ProviderId,
  input: SubscriptionCoreCapacityWake,
  enqueueSessionWorkflowWake: SubscriptionCoreSessionWorkflowWake,
): Promise<SubscriptionCoreWakeScope[]> {
  subscriptionCoreProvider(provider);
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.reason))
    throw new Error("A subscription-core wake reason must be a bounded identifier");
  if (input.sessionIds !== undefined && input.workspaceIds?.length !== 1)
    throw new Error("A session-scoped subscription-core wake names exactly one workspace");
  const sessionIds = input.sessionIds ? [...new Set(input.sessionIds)] : null;
  if (sessionIds !== null && sessionIds.length === 0) return [];
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) =>
    withPoolWakeServiceScopeInTransaction(tx, async () => {
      const cutover = await readSubscriptionProviderCutoverState(tx, {
        accountId: input.accountId,
        provider,
      });
      if (cutover !== "enabled") return [];
      const workspaceIds =
        input.workspaceIds ??
        (
          await rawRows<{ workspace_id: string }>(
            tx,
            sql`select workspace_id::text as workspace_id
              from list_organization_subscription_workspace_ids(${input.accountId}::uuid)
              order by workspace_id`,
          )
        ).map((row) => row.workspace_id);
      const touched: SubscriptionCoreWakeScope[] = [];
      for (const workspaceId of workspaceIds) {
        await setRlsContext(tx, { accountId: input.accountId, workspaceId });
        await tx.execute(
          sql`select set_config('opengeni.subject_id', '', true), set_config('opengeni.initiating_human_subject_id', '', true)`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
        );
        const woken = await rawRows<{
          session_id: string;
          waiter_id: string;
          generation: number | string;
          wake_revision: number | string;
        }>(
          tx,
          sql`update subscription_capacity_waiters
            set wake_revision = wake_revision + 1, last_wake_reason = ${input.reason},
                updated_at = clock_timestamp()
            where account_id = ${input.accountId}::uuid
              and workspace_id = ${workspaceId}::uuid and provider = ${provider}
              ${
                sessionIds === null
                  ? sql``
                  : sql`and session_id in (${sql.join(
                      sessionIds.map((id) => sql`${id}::uuid`),
                      sql`, `,
                    )})`
              }
            returning session_id::text as session_id, waiter_id::text as waiter_id,
              generation, wake_revision`,
        );
        for (const row of woken) {
          await tx.execute(sql`insert into subscription_capacity_wake_outbox (
              account_id, workspace_id, session_id, waiter_id, generation, wake_revision
            ) values (
              ${input.accountId}::uuid, ${workspaceId}::uuid, ${row.session_id}::uuid,
              ${row.waiter_id}::uuid, ${Number(row.generation)}, ${Number(row.wake_revision)}
            ) on conflict (account_id, waiter_id, generation, wake_revision) do nothing`);
          // The generic durable wake is the crash-safe backstop: the global
          // dispatcher delivers it even if this outbox row's typed signal is
          // never sent.
          await enqueueSessionWorkflowWake(tx, {
            accountId: input.accountId,
            workspaceId,
            sessionId: row.session_id,
            temporalWorkflowId: `session-${row.session_id}`,
            reason: "subscription_capacity",
          });
        }
        if (woken.length > 0) touched.push({ accountId: input.accountId, workspaceId });
      }
      await setRlsContext(tx, { accountId: input.accountId, workspaceId: null });
      return touched;
    }),
  );
}
