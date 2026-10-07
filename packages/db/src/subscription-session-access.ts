import { and, eq, sql } from "drizzle-orm";

import {
  currentSessionRlsActorContext,
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
 * in the caller's trusted service context (no subject), which already sees
 * every session row of the workspace; the value it returns can only narrow
 * the later pool-worker transaction to that human's sessions.
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
 * - A caller whose ambient session actor already carries an initiating human
 *   owns its context; this helper never overrides it.
 * - Otherwise (background recovery, wake handlers, failure settlement) the
 *   exact turn's frozen initiating human is re-established for the duration
 *   of `fn`, so private and shared sessions behave identically. The turn is
 *   read in the caller's own context: an ambient actor that cannot see the
 *   turn gains nothing.
 */
export async function withSubscriptionPoolSessionAccess<T>(
  db: Database,
  input: { workspaceId: string; subjectId: string; sessionId: string; turnId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!isSubscriptionPoolWorkerSubject(input.subjectId)) return await fn();
  const ambient = currentSessionRlsActorContext();
  if (ambient?.initiatingHumanSubjectId) return await fn();
  const initiatingHumanSubjectId = await readFrozenInitiatingHuman(db, input);
  if (!initiatingHumanSubjectId) return await fn();
  return await withSessionRlsActorContext(
    { ...ambient, subjectId: ambient?.subjectId ?? input.subjectId, initiatingHumanSubjectId },
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
