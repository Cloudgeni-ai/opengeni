import { and, desc, eq, exists, gt, sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";

export const CONTEXT_COMPACTION_FAILED_CODE = "context_compaction_failed";

/**
 * The compaction-failure hold. When the newest finished turn ended with a
 * terminal `context_compaction_failed`, machine input that was already pending
 * at that failure saw only the unchanged history and must not start another
 * inference by itself. Returns the exact `turn.failed` event sequence that
 * bounds the hold, or null when no hold applies.
 *
 * Input whose `system.update.pending` event is newer than that sequence is new
 * truth: it makes one new attempt and the held backlog rides along with it
 * (see docs/context-compaction.md). Session event sequences are allocated under
 * the session row lock that both the failure settlement and every producer
 * take, so the comparison is exact commit order, unlike row timestamps.
 */
export async function compactionFailureHoldSequenceTx(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number | null> {
  const [latestFinished] = await db
    .select({ id: schema.sessionTurns.id })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        sql`${schema.sessionTurns.finishedAt} is not null`,
      ),
    )
    .orderBy(
      desc(schema.sessionTurns.finishedAt),
      desc(schema.sessionTurns.position),
      desc(schema.sessionTurns.createdAt),
    )
    .limit(1);
  if (!latestFinished) return null;
  const [failure] = await db
    .select({ sequence: schema.sessionEvents.sequence })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        eq(schema.sessionEvents.turnId, latestFinished.id),
        eq(schema.sessionEvents.type, "turn.failed"),
        sql`${schema.sessionEvents.payload} ->> 'code' = ${CONTEXT_COMPACTION_FAILED_CODE}`,
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1);
  return failure ? Number(failure.sequence) : null;
}

/**
 * Correlated predicate over `session_system_updates`: the row's own
 * `system.update.pending` event was appended after `afterSequence`.
 */
export function systemUpdatePendingAfterSequenceSql(
  db: Database,
  workspaceId: string,
  sessionId: string,
  afterSequence: number,
): SQL {
  return exists(
    db
      .select({ value: sql`1` })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.sessionId, sessionId),
          eq(schema.sessionEvents.type, "system.update.pending"),
          gt(schema.sessionEvents.sequence, afterSequence),
          sql`${schema.sessionEvents.payload} ->> 'updateId' = ${schema.sessionSystemUpdates.id}::text`,
        ),
      ),
  );
}
