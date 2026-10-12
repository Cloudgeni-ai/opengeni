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
  provider: ProviderId | null,
  input: { workspaceId: string; turnIds: readonly string[]; sessionId?: string },
): Promise<number> {
  // Null: the waiter of whichever provider the turn parked on (a turn waits
  // on at most one), including a provider that is not registered yet.
  if (provider !== null) subscriptionCoreProvider(provider);
  if (input.turnIds.length === 0) return 0;
  const deleted = await db
    .delete(schema.subscriptionCapacityWaiters)
    .where(
      and(
        eq(schema.subscriptionCapacityWaiters.workspaceId, input.workspaceId),
        ...(input.sessionId
          ? [eq(schema.subscriptionCapacityWaiters.sessionId, input.sessionId)]
          : []),
        ...(provider === null ? [] : [eq(schema.subscriptionCapacityWaiters.provider, provider)]),
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
  /**
   * Only waiters of sessions owned by this organization membership (for
   * example a person's own preference change, which can make only their own
   * sessions placeable). Composes with `workspaceIds` and `sessionIds`.
   */
  ownerMembershipId?: string;
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
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (input.ownerMembershipId !== undefined && !UUID.test(input.ownerMembershipId))
    throw new Error("A subscription-core wake owner membership must be a uuid");
  const ownerMembershipId = input.ownerMembershipId?.toLowerCase() ?? null;
  const sessionIds = input.sessionIds ? [...new Set(input.sessionIds)] : null;
  if (sessionIds !== null && sessionIds.length === 0) return [];
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) =>
    withPoolWakeServiceScopeInTransaction(tx, async () => {
      const cutover = await readSubscriptionProviderCutoverState(tx, {
        accountId: input.accountId,
        provider,
      });
      if (cutover !== "enabled") return [];
      // Workspaces in ascending id order (lowercase text sorts as the uuid
      // does), as the membership commands walk them, so wakes never cross.
      const workspaceIds =
        (input.workspaceIds
          ? [...new Set(input.workspaceIds.map((id) => id.toLowerCase()))].sort()
          : null) ??
        (
          await rawRows<{ workspace_id: string }>(
            tx,
            sql`select inventory.workspace_id::text as workspace_id
              from list_organization_subscription_workspace_ids(${input.accountId}::uuid) as inventory
              order by inventory.workspace_id`,
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
        const sessionFilter =
          sessionIds === null
            ? sql``
            : sql`and session_id in (${sql.join(
                sessionIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`;
        // Owned sessions only: the owner is read again under the session
        // lock below, so a session whose owner changed since is skipped.
        const ownerFilter =
          ownerMembershipId === null
            ? sql``
            : sql`and session_id in (
                select owned.id from sessions owned
                where owned.workspace_id = ${workspaceId}::uuid
                  and owned.owner_organization_membership_id = ${ownerMembershipId}::uuid
              )`;
        // Lock order: workspace, then session, then waiter. Steer, Cancel and
        // a resume lock the session before its waiter, and the generic wake's
        // archive guard locks the session too. So read the waiters without
        // locking, lock their sessions in session order, and only then bump
        // those sessions' waiters and record their typed wakes (whose foreign
        // key share-locks the waiter). Holding a waiter while waiting for its
        // session deadlocks with Steer or Cancel, and concurrent multi-row
        // bumps of one pool deadlock with each other. A session has at most
        // one core waiter (its primary key), so it gets one generic wake.
        const waiting = await rawRows<{ session_id: string }>(
          tx,
          sql`select session_id::text as session_id from subscription_capacity_waiters
            where account_id = ${input.accountId}::uuid
              and workspace_id = ${workspaceId}::uuid and provider = ${provider}
              ${sessionFilter}
              ${ownerFilter}
            order by subscription_capacity_waiters.session_id`,
        );
        if (waiting.length === 0) continue;
        // The canonical prefix locks the workspace row after the tenancy
        // fence (a visibility change or a fork takes the fence exclusively,
        // then the workspace FOR UPDATE) and before any session
        // (`lockSessionEventWriteRows`; a runnable wake and a context clear
        // take it FOR UPDATE, then the session). The outbox inserts below
        // key-share-lock it through their foreign keys, so take it before
        // the sessions: a wake that held a session while waiting for its
        // workspace would deadlock with them. Only a key share: session-first
        // writers key-share it through foreign keys too, so a stronger lock
        // here would deadlock with them. Only where there is a waiter to wake
        // (the read above takes no row lock), so a wake does not hold
        // workspace FOR UPDATE lockers off in workspaces it leaves alone.
        // The weakest lock that excludes those FOR UPDATE lockers: a stronger
        // one would also hold off workspace updates, FOR SHARE authority
        // checks and concurrent wakes of the workspace.
        const [workspace] = await rawRows<{ id: string }>(
          tx,
          sql`select id::text as id from workspaces
            where id = ${workspaceId}::uuid and account_id = ${input.accountId}::uuid
            for key share`,
        );
        // Deleted since the read (its waiters went with it): nothing to wake.
        if (!workspace) continue;
        // Lock the sessions read, in ascending order, with the generic wake's
        // archive guard's own mode (so recording the wake never upgrades a
        // lock), and wake only those still present and executable. A session
        // deleted since the read (Cancel, then a quiescent delete) or archived
        // or imported (the guard would refuse its wake) drops out here instead
        // of failing the whole wake. Rows are locked in the sorted order, and
        // a row changed while this waits is rechecked against the filter.
        const present = await rawRows<{ session_id: string }>(
          tx,
          sql`select sessions.id::text as session_id from sessions
            where sessions.workspace_id = ${workspaceId}::uuid
              and sessions.id in (${sql.join(
                waiting.map((row) => sql`${row.session_id}::uuid`),
                sql`, `,
              )})
              and sessions.imported_archive_import_id is null
              and sessions.content_archive_state is null
              ${
                ownerMembershipId === null
                  ? sql``
                  : sql`and sessions.owner_organization_membership_id = ${ownerMembershipId}::uuid`
              }
            order by sessions.id
            for no key update of sessions`,
        );
        if (present.length === 0) continue;
        for (const row of present) {
          // The generic durable wake is the crash-safe backstop: the global
          // dispatcher delivers it even if the typed outbox row's signal is
          // never sent. A waiter that ended since the read leaves its (still
          // locked, still present) session a spurious but harmless wake. A
          // waiter armed since the read is not bumped by this wake: arming
          // evaluates fresh capacity, and the bounded recheck covers it, as
          // with a single-statement snapshot.
          await enqueueSessionWorkflowWake(tx, {
            accountId: input.accountId,
            workspaceId,
            sessionId: row.session_id,
            temporalWorkflowId: `session-${row.session_id}`,
            reason: "subscription_capacity",
          });
        }
        // Every session woken above is held by this transaction, so no
        // concurrent wake, Steer, Cancel or resume holds any of their waiters.
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
              and session_id in (${sql.join(
                present.map((row) => sql`${row.session_id}::uuid`),
                sql`, `,
              )})
            returning session_id::text as session_id, waiter_id::text as waiter_id,
              generation, wake_revision`,
        );
        for (const row of woken)
          await tx.execute(sql`insert into subscription_capacity_wake_outbox (
              account_id, workspace_id, session_id, waiter_id, generation, wake_revision
            ) values (
              ${input.accountId}::uuid, ${workspaceId}::uuid, ${row.session_id}::uuid,
              ${row.waiter_id}::uuid, ${Number(row.generation)}, ${Number(row.wake_revision)}
            ) on conflict (account_id, waiter_id, generation, wake_revision) do nothing`);
        if (woken.length > 0) touched.push({ accountId: input.accountId, workspaceId });
      }
      await setRlsContext(tx, { accountId: input.accountId, workspaceId: null });
      return touched;
    }),
  );
}
