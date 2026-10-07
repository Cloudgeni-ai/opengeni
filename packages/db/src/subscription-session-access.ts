import { and, eq, sql } from "drizzle-orm";

import {
  currentSessionRlsActorContext,
  isTransactionHandle,
  rawRows,
  withSessionRlsActorContext,
  withWorkspaceRls,
  type Database,
} from "./database";
import * as schema from "./schema";

/**
 * Subscription authority and session access are separate permissions.
 *
 * - Subscription authority decides which account pool a run may use. Shared
 *   (organization or workspace) pools are read and written under a synthetic
 *   pool-worker database subject, because no human owns those pool rows.
 * - Session access decides which session rows a database operation may see.
 *   FORCE RLS admits a `user_private` session only when the subject or the
 *   `opengeni.initiating_human_subject_id` setting is the session owner.
 *
 * Switching to a pool-worker subject must therefore never change who can see
 * the session the run belongs to. The helpers below re-establish the exact
 * turn's frozen initiating human (`session_turns.initiating_human_subject_id`)
 * alongside the pool-worker subject. That admits only sessions owned by that
 * human, which is exactly the access the accepted turn already carried, so the
 * pool worker gains no general visibility of private sessions.
 */

export type SubscriptionPoolProvider = "claude" | "xai";

const POOL_WORKER_SUBJECT_PREFIX = "worker:";
const POOL_WORKER_SUBJECT_SUFFIX = "-workspace";
const SUBSCRIPTION_POOL_PROVIDERS: readonly SubscriptionPoolProvider[] = ["claude", "xai"];

/** The synthetic database subject that owns a provider's shared pool rows. */
export function subscriptionPoolWorkerSubject(provider: SubscriptionPoolProvider): string {
  return POOL_WORKER_SUBJECT_PREFIX + provider + POOL_WORKER_SUBJECT_SUFFIX;
}

export function isSubscriptionPoolWorkerSubject(subjectId: string): boolean {
  return SUBSCRIPTION_POOL_PROVIDERS.some(
    (provider) => subscriptionPoolWorkerSubject(provider) === subjectId,
  );
}

/**
 * Read the frozen initiating human of the exact turn a subscription operation
 * acts for: `turnId` when supplied, otherwise the session's active turn. Runs
 * only in a trusted service context with no ambient actor and on a pool
 * handle (never an open transaction), so the read sees every session row of
 * the workspace and no inherited subject or initiating-human setting can
 * influence which turn it finds. The value it returns can only narrow the
 * later pool-worker transaction to that human's sessions. A `turnId` that
 * does not belong to `sessionId`, or a turn without an initiating human,
 * yields `null`.
 */
async function readFrozenInitiatingHuman(
  db: Database,
  input: { workspaceId: string; sessionId: string; turnId?: string | null },
): Promise<string | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = input.turnId
      ? await scopedDb
          .select({ initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          )
          .limit(1)
      : await scopedDb
          .select({ initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId })
          .from(schema.sessions)
          .innerJoin(
            schema.sessionTurns,
            and(
              eq(schema.sessionTurns.workspaceId, schema.sessions.workspaceId),
              eq(schema.sessionTurns.id, schema.sessions.activeTurnId),
            ),
          )
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
            ),
          )
          .limit(1);
    const subjectId = rows[0]?.initiatingHumanSubjectId?.trim();
    return subjectId ? subjectId : null;
  });
}

/**
 * Run a subscription operation that uses a pool-worker subject without losing
 * the session access of the turn it acts for.
 *
 * - Non-pool subjects (a human acting on their own private pool, or an API
 *   caller) already carry their own access and run unchanged.
 * - Any ambient session actor owns its context and `fn` runs unchanged,
 *   whatever its subject and whether or not it carries an initiating human
 *   (for example the agent-turn actor of a service turn whose initiating
 *   human is null). The restored human is never combined with a different
 *   subject, so an ambient actor can never gain another member's private
 *   session visibility through this helper.
 * - Otherwise (no ambient actor: background recovery, wake handlers, failure
 *   settlement) the exact turn's frozen initiating human is re-established
 *   together with the pool-worker subject for the duration of `fn`, so
 *   private and shared sessions behave identically. Pass the acting `turnId`;
 *   without it the session's active turn is used. A turn with no initiating
 *   human, or one that is not a turn of `sessionId`, restores nothing and
 *   private sessions stay hidden (fail closed).
 *
 * The restored actor applies to every scope `fn` opens. Wrapped functions are
 * single transactions already scoped to the pool-worker subject, so it only
 * affects that transaction.
 *
 * Call it with a pool handle. When restoration would be needed it refuses an
 * open transaction handle: such a transaction is already scoped to some
 * subject and initiating human, which would decide which turn the lookup can
 * see, and the restored actor would then apply inside a transaction whose
 * scope the caller chose.
 */
export async function withSubscriptionPoolSessionAccess<T>(
  db: Database,
  input: { workspaceId: string; subjectId: string; sessionId: string; turnId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!isSubscriptionPoolWorkerSubject(input.subjectId)) return await fn();
  if (currentSessionRlsActorContext()) return await fn();
  if (isTransactionHandle(db)) {
    throw new Error(
      "withSubscriptionPoolSessionAccess: pool-worker session access must be restored from a pool handle, not an open transaction",
    );
  }
  const initiatingHumanSubjectId = await readFrozenInitiatingHuman(db, input);
  if (!initiatingHumanSubjectId) return await fn();
  return await withSessionRlsActorContext(
    { subjectId: input.subjectId, initiatingHumanSubjectId },
    fn,
  );
}

/**
 * Transaction-local form for code that temporarily switches an open
 * transaction to a pool-worker subject (for example a session projection that
 * reads the provider waiter). The caller already reads `turnInitiatingHuman`
 * from the turn row under its own access, so re-establishing it cannot widen
 * that access. An initiating human already present on the transaction is kept.
 */
export async function withTemporaryPoolSessionAccessInTransaction<T>(
  tx: Database,
  turnInitiatingHuman: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const initiatingHuman = turnInitiatingHuman?.trim();
  if (!initiatingHuman) return await fn();
  const [prior] = await rawRows<{ initiating_human_subject_id: string | null }>(
    tx,
    sql`select current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id`,
  );
  const priorValue = prior?.initiating_human_subject_id ?? "";
  if (priorValue.trim()) return await fn();
  await tx.execute(
    sql`select set_config('opengeni.initiating_human_subject_id', ${initiatingHuman}, true)`,
  );
  const restore = async () =>
    await tx.execute(
      sql`select set_config('opengeni.initiating_human_subject_id', ${priorValue}, true)`,
    );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // An aborted transaction cannot run the restore; the setting dies with it.
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  return result;
}

/**
 * Run `fn` in the trusted service scope (no subject, no initiating human) of
 * an open, workspace-scoped transaction, then restore both settings.
 *
 * Used only to wake a shared (workspace or organization) pool's capacity
 * waiters after the caller's own subject has resolved that pool. Waking is
 * durable invalidation: it bumps the waiter's wake revision and enqueues a
 * workflow wake, and each waiter then rechecks its own immutable pool. This is
 * the Codex rule: Codex waiters are woken in the same service scope. Under a
 * member's subject, FORCE RLS would hide every other member's `user_private`
 * waiter, which then waited for its periodic recheck. `fn` must stay limited
 * to the exact pool scope and must not return session rows or ids to the
 * caller, so the caller gains no read access to another member's session.
 */
export async function withPoolWakeServiceScopeInTransaction<T>(
  tx: Database,
  fn: () => Promise<T>,
): Promise<T> {
  const [prior] = await rawRows<{
    subject_id: string | null;
    initiating_human_subject_id: string | null;
  }>(
    tx,
    sql`select current_setting('opengeni.subject_id', true) as subject_id,
      current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id`,
  );
  await tx.execute(
    sql`select set_config('opengeni.subject_id', '', true), set_config('opengeni.initiating_human_subject_id', '', true)`,
  );
  const restore = async () =>
    await tx.execute(
      sql`select set_config('opengeni.subject_id', ${prior?.subject_id ?? ""}, true), set_config('opengeni.initiating_human_subject_id', ${prior?.initiating_human_subject_id ?? ""}, true)`,
    );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // An aborted transaction cannot run the restore; the setting dies with it.
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  return result;
}
