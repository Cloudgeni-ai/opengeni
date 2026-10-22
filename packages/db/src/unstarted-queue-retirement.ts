import { and, eq, inArray, sql } from "drizzle-orm";
import { withSessionActivityRlsContext, type Database } from "./database";
import { sessionQueueIsEmptyInTransaction } from "./empty-session-queue";
import { withLosslessContentWriteVersion } from "./lossless-json";
import { evaluateSessionControl, lockSessionEventWriteRows } from "./session-control";
import * as schema from "./schema";

export type UnstartedQueueRetirementTarget = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  expectedLastSequence: number;
  turns: Array<{ turnId: string; expectedVersion: number }>;
};

/** Explicitly withdraw a reviewed, never-run human queue. The entire queue is
 * fenced, not just its head: clearing an admission block must never release an
 * unreviewed sibling. All checks and receipts share the caller's transaction. */
export async function retireUnstartedSessionQueue(
  db: Database,
  input: UnstartedQueueRetirementTarget & { operationId: string },
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
        throw new Error("Unstarted queue retirement scope changed");
      const targets = [...input.turns].sort((a, b) => a.turnId.localeCompare(b.turnId));
      const [receipt] = await tx
        .select({ id: schema.sessionEvents.id })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.type, "session.status.changed"),
            sql`${schema.sessionEvents.payload}->>'code' = 'unstarted_queue_retired'`,
            sql`${schema.sessionEvents.payload}->>'retirementOperationId' = ${input.operationId}`,
            sql`${schema.sessionEvents.payload}->>'retiredLastSequence' = ${String(input.expectedLastSequence)}`,
            sql`${schema.sessionEvents.payload}->'retiredTurns' = ${JSON.stringify(targets)}::jsonb`,
          ),
        )
        .limit(1);
      if (receipt) return;
      const control = await evaluateSessionControl(tx, input.workspaceId, input.sessionId, {
        workspaceControl: locks.control ?? undefined,
      });
      if (
        control.state !== "active" ||
        session.activeTurnId !== null ||
        session.lastSequence !== input.expectedLastSequence ||
        !["queued", "requires_action", "idle"].includes(session.status)
      )
        throw new Error("Unstarted queue retirement target changed or is paused");
      const turnLocks = await lockSessionEventWriteRows(tx, {
        workspaceId: input.workspaceId,
        controlLock: "already_locked",
        workspaceLock: "already_locked",
        turnIds: targets.map((t) => t.turnId),
      });
      for (const target of targets) {
        const turn = turnLocks.turns.find((t) => t.id === target.turnId);
        if (
          !turn ||
          turn.accountId !== input.accountId ||
          turn.sessionId !== input.sessionId ||
          turn.status !== "queued" ||
          !["user", "api"].includes(turn.source) ||
          turn.version !== target.expectedVersion ||
          turn.executionGeneration !== 0 ||
          turn.activeAttemptId !== null ||
          turn.startedAt !== null ||
          turn.scheduledTaskRunId !== null
        )
          throw new Error("Unstarted queue retirement requires exact never-run prompts");
      }
      const [attempt] = await tx
        .select({ id: schema.sessionTurnAttempts.id })
        .from(schema.sessionTurnAttempts)
        .where(
          and(
            eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
            inArray(
              schema.sessionTurnAttempts.turnId,
              targets.map((t) => t.turnId),
            ),
          ),
        )
        .limit(1);
      if (attempt) throw new Error("Unstarted queue retirement found execution evidence");
      const now = new Date();
      await tx
        .update(schema.sessionTurns)
        .set({
          status: "cancelled",
          cancelledBy: "system:operator_retirement",
          cancelReason: "operator_not_run",
          version: sql`${schema.sessionTurns.version} + 1`,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, input.workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            inArray(
              schema.sessionTurns.id,
              targets.map((t) => t.turnId),
            ),
          ),
        );
      await tx
        .update(schema.sessions)
        .set({ admissionBlock: null })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      // These writes are still invisible. Any unreviewed input, live writer,
      // continuation, capacity wait or voice lease aborts the entire batch.
      if (!(await sessionQueueIsEmptyInTransaction(tx, input.workspaceId, input.sessionId)))
        throw new Error("Unstarted queue retirement has other accepted work");
      const [scheduled] = await tx
        .select({ id: schema.scheduledTaskRuns.id })
        .from(schema.scheduledTaskRuns)
        .where(
          and(
            eq(schema.scheduledTaskRuns.workspaceId, input.workspaceId),
            eq(schema.scheduledTaskRuns.sessionId, input.sessionId),
            inArray(schema.scheduledTaskRuns.status, ["queued", "dispatched"]),
          ),
        )
        .limit(1);
      if (scheduled) throw new Error("Unstarted queue retirement has a scheduled obligation");
      let sequence = session.lastSequence;
      const queueVersion = session.queueVersion + 1;
      await tx.insert(schema.sessionEvents).values(
        withLosslessContentWriteVersion(
          [
            ...targets.map((target) => ({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: target.turnId,
              sequence: ++sequence,
              type: "session.queue.changed" as const,
              payload: {
                operation: "delete",
                queueVersion,
                turnId: target.turnId,
                code: "operator_not_run",
                retirementOperationId: input.operationId,
              },
              occurredAt: now,
            })),
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "session.status.changed" as const,
              payload: {
                status: "idle",
                code: "unstarted_queue_retired",
                notificationOnly: true,
                retirementOperationId: input.operationId,
                retiredLastSequence: input.expectedLastSequence,
                retiredTurns: targets,
              },
              occurredAt: now,
            },
          ],
          "payload",
          "payloadCodecVersion",
        ),
      );
      await tx
        .update(schema.sessions)
        .set({ status: "idle", queueVersion, lastSequence: sequence, updatedAt: now })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
    }),
  );
}
