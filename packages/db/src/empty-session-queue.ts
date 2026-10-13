import { and, eq, sql } from "drizzle-orm";
import { rawRows, withSessionActivityRlsContext, type Database } from "./database";
import { withLosslessContentWriteVersion } from "./lossless-json";
import { lockSessionEventWriteRows } from "./session-control";
import { sessionAttemptPendingWritersSql } from "./session-attempt-writers";
import * as schema from "./schema";

/** Call only while holding the canonical session lock. A label is not an
 * execution obligation, but neither age nor an absent active pointer proves
 * the queue empty. Keep every accepted input and physical writer authoritative. */
export async function sessionQueueIsEmptyInTransaction(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const [row] = await rawRows<{ empty: boolean }>(
    db,
    sql`
    select exists (
      select 1 from sessions s where s.workspace_id = ${workspaceId} and s.id = ${sessionId}
        and s.active_turn_id is null and not s.compact_requested
        and s.admission_block is null and s.input_wait_until is null
        and s.content_archive_state is null
        and not exists (select 1 from session_turns t
          where t.workspace_id = s.workspace_id and t.session_id = s.id
            and t.status in ('queued', 'running', 'recovering', 'waiting_capacity', 'requires_action'))
        and not exists (select 1 from session_turn_attempts a
          where a.workspace_id = s.workspace_id and a.session_id = s.id
            and (a.state <> 'closed' or ${sessionAttemptPendingWritersSql(sql`a`)}))
        and not exists (select 1 from session_system_updates u
          where u.workspace_id = s.workspace_id and u.session_id = s.id and u.state = 'pending')
        and not exists (select 1 from session_goals g
          where g.workspace_id = s.workspace_id and g.session_id = s.id and g.status = 'active')
        and not exists (select 1 from subscription_capacity_waiters w
          where w.workspace_id = s.workspace_id and w.session_id = s.id)
        and not exists (select 1 from session_realtime_modes r
          where r.workspace_id = s.workspace_id and r.session_id = s.id
            and r.state = 'active' and r.lease_expires_at > now())
        and not exists (select 1 from session_system_update_outbox o
          where o.workspace_id = s.workspace_id and o.target_session_id = s.id and o.status = 'pending')
    ) as empty`,
  );
  return row?.empty === true;
}

export type EmptyQueuedSessionRepairTarget = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  expectedLastSequence: number;
};

/** The existing operator manifest can correct an uninitialized shell without
 * manufacturing a failed turn, a parent result, or permission to replay it. */
export async function repairEmptyQueuedSessionProjection(
  db: Database,
  input: EmptyQueuedSessionRepairTarget & { operationId: string },
): Promise<void> {
  await withSessionActivityRlsContext(db, input, async (scoped) =>
    scoped.transaction(async (tx) => {
      const locks = await lockSessionEventWriteRows(tx, {
        workspaceId: input.workspaceId,
        controlLock: "share",
        sessionIds: [input.sessionId],
      });
      const session = locks.sessions[0];
      if (!locks.workspace || !session || session.accountId !== input.accountId)
        throw new Error("Empty queued session repair scope changed");
      const [prior] = await tx
        .select({ id: schema.sessionEvents.id })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.type, "session.status.changed"),
            sql`${schema.sessionEvents.payload}->>'code' = 'empty_queue_projection_repaired'`,
            sql`${schema.sessionEvents.payload}->>'retirementOperationId' = ${input.operationId}`,
            sql`${schema.sessionEvents.payload}->>'repairedLastSequence' = ${String(input.expectedLastSequence)}`,
          ),
        )
        .limit(1);
      // Receipt replay never changes a newer epoch, even if new work arrived.
      if (prior) return;
      if (
        session.status !== "queued" ||
        session.lastSequence !== input.expectedLastSequence ||
        !(await sessionQueueIsEmptyInTransaction(tx, input.workspaceId, input.sessionId))
      )
        throw new Error("Empty queued session repair target changed or has accepted work");
      const [started] = await rawRows<{ started: boolean }>(
        tx,
        sql`
        select exists (select 1 from session_turns
          where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId})
          or exists (select 1 from session_events
            where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
              and type = 'session.created')
          or exists (select 1 from scheduled_task_runs
            where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
              and status in ('queued', 'dispatched')) as started`,
      );
      if (started?.started)
        throw new Error("Empty queued session repair requires an uninitialized session");
      const now = new Date();
      await tx.insert(schema.sessionEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            sequence: session.lastSequence + 1,
            type: "session.status.changed",
            payload: {
              status: "idle",
              code: "empty_queue_projection_repaired",
              retirementOperationId: input.operationId,
              repairedLastSequence: input.expectedLastSequence,
              notificationOnly: true,
            },
            occurredAt: now,
          },
          "payload",
          "payloadCodecVersion",
        ),
      );
      await tx
        .update(schema.sessions)
        .set({
          status: "idle",
          lastSequence: session.lastSequence + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
    }),
  );
}
