import { and, eq, sql } from "drizzle-orm";
import { rawRows, withSessionActivityRlsContext, type Database } from "./database";
import {
  lockSessionEventWriteRows,
  registerSessionWorkflowWakeInTransaction,
} from "./session-control";
import * as schema from "./schema";

export type QuiescenceReceiptWakeRepairCursor = { workspaceId: string; sessionId: string };
type Candidate = QuiescenceReceiptWakeRepairCursor & { accountId: string };

/**
 * How long after its attempt closed a recovering session becomes a repair
 * candidate. The woken workflow can prove a dead activity gone only once
 * Temporal's server-owned `runAgentTurn` heartbeat lease (two minutes after
 * the last heartbeat, which precedes the close) has expired, so an earlier
 * wake would only be paced away. Must be at least that heartbeat timeout.
 * Migration 1260's inventory uses the same interval.
 */
export const QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS = 120;

/**
 * How long the session's latest wake must have been delivered before the
 * reaper wakes it again: one repair wake per window while it stays stranded.
 * A wake delivered after the activity lease expired already ran the exact
 * reconciliation, so the stranding wake is never later than the close grace
 * and a repair lands within close grace + this window (plus one dispatcher
 * period). `OpenGeniSessionRecoveryBacklogStale` must clearly outlast that, so
 * a self-repair within the designed time never pages; apps/worker's
 * recovery-repair alert test holds the two together.
 * Migration 1260's inventory uses the same interval.
 */
export const QUIESCENCE_REPAIR_WAKE_QUIET_SECONDS = 120;

/** The root's peekSessionWork, injected so this module never imports the root
 * barrel that re-exports it. */
export type QuiescenceRepairWorkPeek = (
  db: Database,
  workspaceId: string,
  sessionId: string,
) => Promise<{ kind: string }>;

/** Peek kinds whose workflow wake performs work: admission of the preserved
 * turn, or DB-only control settlement. Control settlement never executes the
 * turn, so it is permitted under Pause: a paused turn whose receipt is durable
 * but whose projection still says `recovering` is parked idle by exactly this
 * wake. Every other kind is a durable wait owned by its own unblocking wake. */
const ACTIONABLE_RECOVERY_PEEK_KINDS = new Set([
  "runnable",
  "interruption-pending",
  "cancellation-wait",
]);

/**
 * A recovering session whose interrupted attempt never received its physical
 * quiescence receipt is revisited only by a workflow wake. The closing activity
 * normally commits that receipt and wake atomically; if it died first, or the
 * workflow observed a still-leased activity and closed, nothing else wakes the
 * session and it strands in `recovering` forever.
 * A received physical receipt can strand too: accepting its transport signal
 * does not prove the workflow reclaimed the logical turn.
 *
 * This repair only registers an ordinary queue wake. It writes no receipt, no
 * turn, and no control state: the woken workflow routes the exact attempt
 * through `reconcileSessionAttemptQuiescence` when its receipt is missing,
 * proving through Temporal that the activity is gone and rechecking both writer
 * gates. Quiesced turns must pass ordinary peek admission. Discovery is not admission; every predicate is rechecked here
 * under the canonical session locks.
 *
 * Discovery (migration 0880) omits quiesced turns parked behind Pause, an
 * admission block or a sandbox setup marker. Those are legitimate waits whose
 * unblocking transaction commits its own wake, not lost wakes.
 */
async function repairCandidate(
  db: Database,
  peekSessionWork: QuiescenceRepairWorkPeek,
  candidate: Candidate,
): Promise<boolean> {
  return withSessionActivityRlsContext(db, candidate, (scoped) =>
    scoped.transaction(async (tx) => {
      // A busy target is retried on the next inventory lap rather than holding
      // the deployment-wide reconciler behind an unrelated transaction.
      await tx.execute(sql`select set_config('lock_timeout', '100ms', true)`);
      const locks = await lockSessionEventWriteRows(tx as unknown as Database, {
        workspaceId: candidate.workspaceId,
        controlLock: "share",
        sessionIds: [candidate.sessionId],
      });
      const session = locks.sessions[0];
      if (!session || session.accountId !== candidate.accountId || session.activeTurnId === null)
        return false;
      // Serialize with wake producers and the dispatcher before deciding.
      await tx
        .select({ sessionId: schema.sessionWorkflowWakeOutbox.sessionId })
        .from(schema.sessionWorkflowWakeOutbox)
        .where(
          and(
            eq(schema.sessionWorkflowWakeOutbox.workspaceId, candidate.workspaceId),
            eq(schema.sessionWorkflowWakeOutbox.sessionId, candidate.sessionId),
          ),
        )
        .for("update")
        .limit(1);
      const [eligible] = await rawRows<{ eligible: boolean; receipt_missing: boolean }>(
        tx as unknown as Database,
        sql`
        select exists (
          select 1
          from session_turns turn
          join lateral (
            select candidate.id, candidate.state, candidate.outcome, candidate.quiesced_at,
              coalesce(candidate.closed_at, candidate.updated_at) as closed_at
            from session_turn_attempts candidate
            where candidate.workspace_id = turn.workspace_id
              and candidate.session_id = turn.session_id
              and candidate.turn_id = turn.id
            order by candidate.execution_generation desc, candidate.updated_at desc, candidate.id desc
            limit 1
          ) attempt on true
          where turn.workspace_id = ${candidate.workspaceId}
            and turn.session_id = ${candidate.sessionId}
            and turn.id = ${session.activeTurnId}
            and turn.status = 'recovering'
            and turn.active_attempt_id is null
            and attempt.state = 'closed'
            and attempt.outcome = 'interrupted_recoverable'
            and (attempt.quiesced_at is not null or ${session.status} = 'recovering')
            and attempt.closed_at < now() - make_interval(secs => ${QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS})
            and (
              exists (
                select 1 from session_attempt_interruptions interruption
                where interruption.workspace_id = turn.workspace_id
                  and interruption.session_id = turn.session_id
                  and interruption.attempt_id = attempt.id
                  and interruption.state in ('settled', 'rejected_stale'))
              or exists (
                select 1 from session_events event
                where event.workspace_id = turn.workspace_id
                  and event.session_id = turn.session_id
                  and event.turn_id = turn.id
                  and event.turn_attempt_id = attempt.id
                  and event.type = 'turn.recovery.requested')
            )
        ) and not exists (
          select 1 from session_workflow_wake_outbox wake
          where wake.workspace_id = ${candidate.workspaceId}
            and wake.session_id = ${candidate.sessionId}
            and (wake.wake_revision > wake.delivered_revision
              or wake.updated_at >= now() - make_interval(secs => ${QUIESCENCE_REPAIR_WAKE_QUIET_SECONDS}))
        ) as eligible,
        coalesce((
          select attempt.quiesced_at is null from session_turn_attempts attempt
          where attempt.workspace_id = ${candidate.workspaceId}
            and attempt.session_id = ${candidate.sessionId}
            and attempt.turn_id = ${session.activeTurnId}
          order by attempt.execution_generation desc, attempt.updated_at desc, attempt.id desc
          limit 1
        ), false) as receipt_missing`,
      );
      if (!eligible?.eligible) return false;
      // Missing receipts must still be reconciled under Pause. A durable
      // receipt, however, permits execution only through ordinary admission;
      // do not wake intentionally paused or independently blocked work. A
      // paused stale `recovering` projection still needs its DB-only park.
      if (
        !eligible.receipt_missing &&
        !ACTIONABLE_RECOVERY_PEEK_KINDS.has(
          (
            await peekSessionWork(
              tx as unknown as Database,
              candidate.workspaceId,
              candidate.sessionId,
            )
          ).kind,
        )
      )
        return false;
      await registerSessionWorkflowWakeInTransaction(tx as unknown as Database, {
        accountId: candidate.accountId,
        workspaceId: candidate.workspaceId,
        sessionId: candidate.sessionId,
        temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
        reason: eligible.receipt_missing ? "attempt_quiescence_repair" : "turn_recovery_repair",
      });
      return true;
    }),
  );
}

/** A keyset cursor lets busy candidates coexist with later eligible sessions.
 * It is inventory progress only; every target is rechecked and a restart
 * safely begins another idempotent lap. */
export async function repairMissingQuiescenceReceiptWakesWith(
  peekSessionWork: QuiescenceRepairWorkPeek,
  db: Database,
  limit = 100,
  after: QuiescenceReceiptWakeRepairCursor | null = null,
): Promise<{
  examined: number;
  registered: number;
  failed: number;
  cursor: QuiescenceReceiptWakeRepairCursor | null;
}> {
  const batchLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await rawRows<{ account_id: string; workspace_id: string; session_id: string }>(
    db,
    sql`
    select * from opengeni_private.list_quiescence_receipt_wake_repairs_v1(
      ${batchLimit}, ${after?.workspaceId ?? null}::uuid, ${after?.sessionId ?? null}::uuid)`,
  );
  let registered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (
        await repairCandidate(db, peekSessionWork, {
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
        })
      )
        registered++;
    } catch (error) {
      // Lock conflicts are safely retryable on the next lap; anything else
      // stays visible to the caller.
      if ((error as { code?: string }).code !== "55P03") failed++;
    }
  }
  const last = rows.at(-1);
  return {
    examined: rows.length,
    registered,
    failed,
    cursor:
      rows.length === batchLimit && last
        ? { workspaceId: last.workspace_id, sessionId: last.session_id }
        : null,
  };
}
