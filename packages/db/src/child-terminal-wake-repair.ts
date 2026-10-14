import { SessionSystemUpdatePayload } from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import { rawRows, withSessionActivityRlsContext, type Database } from "./database";
import { compactionFailureHoldSequenceTx } from "./compaction-failure-hold";
import { fromPostgresLosslessJson } from "./lossless-json";
import { sessionAttemptPendingWritersSql } from "./session-attempt-writers";
import {
  evaluateSessionControl,
  lockSessionEventWriteRows,
  registerInternalUpdateWakeInTransaction,
} from "./session-control";
import { sessionRealtimeIsActiveInTransaction } from "./session-realtime-state";
import * as schema from "./schema";

export type ChildTerminalWakeRepairCursor = { workspaceId: string; sessionId: string };
type Candidate = ChildTerminalWakeRepairCursor & { accountId: string };

/** Discovery is not admission. Revalidate the exact pending producer receipt
 * after the canonical session fence; never reconstruct or replay child work. */
async function repairCandidate(db: Database, candidate: Candidate): Promise<boolean> {
  return withSessionActivityRlsContext(db, candidate, (scoped) =>
    scoped.transaction(async (tx) => {
      // A busy target is retried on the next inventory lap, not allowed to hold
      // the deployment-wide reconciler behind an unrelated transaction.
      await tx.execute(sql`select set_config('lock_timeout', '100ms', true)`);
      const locks = await lockSessionEventWriteRows(tx as unknown as Database, {
        workspaceId: candidate.workspaceId,
        controlLock: "share",
        sessionIds: [candidate.sessionId],
      });
      const session = locks.sessions[0];
      if (
        !session ||
        session.accountId !== candidate.accountId ||
        session.status !== "idle" ||
        session.activeTurnId !== null ||
        session.admissionBlock
      )
        return false;
      const control = await evaluateSessionControl(
        tx as unknown as Database,
        candidate.workspaceId,
        candidate.sessionId,
        { workspaceControl: locks.control ?? undefined },
      );
      if (control.state !== "active") return false;
      const [goal] = await tx
        .select({ id: schema.sessionGoals.id })
        .from(schema.sessionGoals)
        .where(
          and(
            eq(schema.sessionGoals.workspaceId, candidate.workspaceId),
            eq(schema.sessionGoals.sessionId, candidate.sessionId),
          ),
        )
        .limit(1);
      if (
        goal ||
        (await sessionRealtimeIsActiveInTransaction(
          tx as unknown as Database,
          candidate.workspaceId,
          candidate.sessionId,
        ))
      )
        return false;
      const [blocked] = await rawRows<{ pending: boolean }>(
        tx as unknown as Database,
        sql`
        select exists (
          select 1 from session_turns turn
          where turn.workspace_id = ${candidate.workspaceId} and turn.session_id = ${candidate.sessionId}
            and turn.status in ('queued', 'running', 'requires_action', 'waiting_capacity')
        ) or exists (
          select 1 from session_turn_attempts attempt
          where attempt.account_id = ${candidate.accountId}
            and attempt.workspace_id = ${candidate.workspaceId} and attempt.session_id = ${candidate.sessionId}
            and (attempt.state <> 'closed'
              or (attempt.quiesced_at is null and (
                attempt.outcome = 'interrupted_recoverable'
                or exists (select 1 from session_attempt_interruptions interruption
                  where interruption.workspace_id = attempt.workspace_id
                    and interruption.session_id = attempt.session_id
                    and interruption.attempt_id = attempt.id
                    and interruption.state in ('pending', 'delivered', 'acknowledged', 'settled', 'rejected_stale'))
              ))
              or ${sessionAttemptPendingWritersSql(sql`attempt`, "physical")}
              or ${sessionAttemptPendingWritersSql(sql`attempt`, "inference")})
        ) as pending`,
      );
      if (blocked?.pending) return false;
      // A terminal compaction failure holds the input that was already pending;
      // re-registering a wake for it would only re-signal a workflow with
      // nothing admissible. Newer results still repair normally.
      const holdSequence = await compactionFailureHoldSequenceTx(
        tx as unknown as Database,
        candidate.workspaceId,
        candidate.sessionId,
      );
      const pending = await rawRows<{
        source_id: string;
        child_id: string;
        payload: unknown;
        payload_codec_version: number | null;
      }>(
        tx as unknown as Database,
        sql`
        select input.source_id, child.id as child_id, input.payload, input.payload_codec_version
        from session_system_updates input
        join session_system_update_outbox producer
          on producer.account_id = input.account_id and producer.workspace_id = input.workspace_id
          and producer.target_session_id = input.session_id and producer.dedupe_key = input.dedupe_key
          and producer.source_id = input.source_id and producer.kind = 'child_terminal_result'
          and producer.status = 'delivered'
          and (producer.update_id is null or producer.update_id = input.id)
          and producer.personal_connection_delegations = input.personal_connection_delegations
          and producer.mcp_account_bindings is not distinct from input.mcp_account_bindings
          and producer.xai_provider_account_authority_snapshot = input.xai_provider_account_authority_snapshot
          and producer.claude_provider_account_authority_snapshot = input.claude_provider_account_authority_snapshot
        join sessions child on child.id = producer.source_session_id
          and child.account_id = input.account_id and child.workspace_id = input.workspace_id
          and child.parent_session_id = input.session_id and child.id::text = input.source_id
        where input.account_id = ${candidate.accountId} and input.workspace_id = ${candidate.workspaceId}
          and input.session_id = ${candidate.sessionId} and input.state = 'pending'
          and input.kind = 'child_terminal_result'
          and input.payload ->> 'childSessionId' = input.source_id
          and input.lineage ->> 'parentSessionId' = input.session_id::text
          and (${holdSequence}::bigint is null or exists (
            select 1 from session_events pending_event
            where pending_event.workspace_id = input.workspace_id
              and pending_event.session_id = input.session_id
              and pending_event.type = 'system.update.pending'
              and pending_event.sequence > ${holdSequence}::bigint
              and pending_event.payload ->> 'updateId' = input.id::text
          ))
        limit 100`,
      );
      if (
        !pending.some((input) => {
          const payload = SessionSystemUpdatePayload.safeParse(
            fromPostgresLosslessJson(input.payload, input.payload_codec_version),
          );
          return (
            payload.success &&
            payload.data.type === "child_terminal_result" &&
            payload.data.childSessionId === input.child_id &&
            input.source_id === input.child_id
          );
        })
      )
        return false;
      const [wake] = await tx
        .select()
        .from(schema.sessionWorkflowWakeOutbox)
        .where(
          and(
            eq(schema.sessionWorkflowWakeOutbox.workspaceId, candidate.workspaceId),
            eq(schema.sessionWorkflowWakeOutbox.sessionId, candidate.sessionId),
          ),
        )
        .for("update")
        .limit(1);
      if (wake && wake.wakeRevision > wake.deliveredRevision) return false;
      await registerInternalUpdateWakeInTransaction(tx as unknown as Database, {
        ...candidate,
        temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
      });
      // Reserve exactly the accepted pending batch, as the immediate producer
      // does. The existing ACK gate retains queued machine input until claim;
      // no turn, model history, assistant output or quiescence is fabricated.
      await tx
        .update(schema.sessions)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(schema.sessions.id, session.id));
      return true;
    }),
  );
}

/** A keyset cursor lets paused/busy candidates coexist with later eligible
 * sessions. It is only inventory progress: all mutation authority is rechecked
 * per target and a restart safely begins another idempotent lap. */
export async function repairPendingChildTerminalResultWakes(
  db: Database,
  limit = 100,
  after: ChildTerminalWakeRepairCursor | null = null,
): Promise<{
  examined: number;
  registered: number;
  failed: number;
  cursor: ChildTerminalWakeRepairCursor | null;
}> {
  const batchLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await rawRows<{ account_id: string; workspace_id: string; session_id: string }>(
    db,
    sql`
    select * from opengeni_private.list_pending_child_terminal_wake_repairs_v1(
      ${batchLimit}, ${after?.workspaceId ?? null}::uuid, ${after?.sessionId ?? null}::uuid)`,
  );
  let registered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (
        await repairCandidate(db, {
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
        })
      )
        registered++;
    } catch (error) {
      // Lock conflicts are safely retryable. Unexpected failures must remain
      // visible to the caller; neither class marks an input delivered.
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
