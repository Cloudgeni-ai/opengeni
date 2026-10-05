import { and, eq, inArray, sql } from "drizzle-orm";
import type { CodemodeOperation } from "@opengeni/contracts";
import { type Database, withRlsContext } from "./database";
import * as schema from "./schema";
import { lockTurnAttemptWriteFenceTx } from "./session-attempt-fence";
import { CodemodeOperationNotExecutableError, mapCodemodeOperation } from "./codemode-operations";

export type CodemodeContinuationScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

async function lockActiveTurn(tx: Database, input: CodemodeContinuationScope): Promise<void> {
  const fence = await lockTurnAttemptWriteFenceTx(tx, input);
  if (!fence.allowed || fence.turn.accountId !== input.accountId || fence.turn.status !== "running")
    throw new CodemodeOperationNotExecutableError();
}

/** Persist semantics before policy preparation can create a linked review. */
export async function bindCodemodePreparation(
  db: Database,
  input: CodemodeContinuationScope & {
    operationId: string;
    claimId: string;
    effectDigest: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    input,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        await lockActiveTurn(tx as unknown as Database, input);
        const rows = await tx
          .update(schema.sessionAttemptCodemodeCalls)
          .set({ effectDigest: input.effectDigest, updatedAt: new Date() })
          .where(
            and(
              eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
              eq(schema.sessionAttemptCodemodeCalls.state, "running"),
              eq(schema.sessionAttemptCodemodeCalls.claimId, input.claimId),
              sql`${schema.sessionAttemptCodemodeCalls.executionStartedAt} is null`,
              sql`coalesce(${schema.sessionAttemptCodemodeCalls.executionAttemptId}, ${schema.sessionAttemptCodemodeCalls.attemptId}) = ${input.attemptId}`,
              sql`(${schema.sessionAttemptCodemodeCalls.effectDigest} is null or ${schema.sessionAttemptCodemodeCalls.effectDigest} = ${input.effectDigest})`,
            ),
          )
          .returning({ id: schema.sessionAttemptCodemodeCalls.operationId });
        return rows.length === 1;
      }),
  );
}

/** Waiting is a durable pre-effect state. It releases the worker claim and never rewrites origin. */
export async function waitForCodemodeApproval(
  db: Database,
  input: CodemodeContinuationScope & {
    operationId: string;
    claimId: string;
    requestId: string;
    actionFingerprint: string;
    effectDigest: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    input,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        await lockActiveTurn(tx as unknown as Database, input);
        const [request] = await tx
          .select()
          .from(schema.connectorActionRequests)
          .where(
            and(
              eq(schema.connectorActionRequests.id, input.requestId),
              eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
              eq(schema.connectorActionRequests.sessionId, input.sessionId),
              eq(schema.connectorActionRequests.turnId, input.turnId),
              eq(schema.connectorActionRequests.approvalId, input.operationId),
              eq(schema.connectorActionRequests.actionFingerprint, input.actionFingerprint),
              eq(schema.connectorActionRequests.status, "pending"),
            ),
          )
          .limit(1);
        if (!request) return false;
        const rows = await tx
          .update(schema.sessionAttemptCodemodeCalls)
          .set({
            state: "waiting_for_approval",
            approvalRequestId: request.id,
            effectDigest: input.effectDigest,
            claimId: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
              eq(schema.sessionAttemptCodemodeCalls.durableApproval, true),
              eq(schema.sessionAttemptCodemodeCalls.state, "running"),
              eq(schema.sessionAttemptCodemodeCalls.claimId, input.claimId),
              sql`${schema.sessionAttemptCodemodeCalls.executionStartedAt} is null`,
              sql`coalesce(${schema.sessionAttemptCodemodeCalls.executionAttemptId}, ${schema.sessionAttemptCodemodeCalls.attemptId}) = ${input.attemptId}`,
            ),
          )
          .returning({ id: schema.sessionAttemptCodemodeCalls.operationId });
        return rows.length === 1;
      }),
  );
}

/** Worker-owned inventory for this logical turn. Public access additionally proves the current caller. */
export async function listTurnCodemodeApprovals(
  db: Database,
  input: Pick<CodemodeContinuationScope, "accountId" | "workspaceId" | "sessionId" | "turnId">,
): Promise<CodemodeOperation[]> {
  return await withRlsContext(db, input, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.sessionAttemptCodemodeCalls)
      .where(
        and(
          eq(schema.sessionAttemptCodemodeCalls.workspaceId, input.workspaceId),
          eq(schema.sessionAttemptCodemodeCalls.sessionId, input.sessionId),
          eq(schema.sessionAttemptCodemodeCalls.turnId, input.turnId),
          eq(schema.sessionAttemptCodemodeCalls.durableApproval, true),
          inArray(schema.sessionAttemptCodemodeCalls.state, [
            "queued",
            "running",
            "waiting_for_approval",
          ]),
        ),
      )
      .orderBy(schema.sessionAttemptCodemodeCalls.createdAt)
      .limit(129);
    if (rows.length > 128) throw new Error("Too many programmatic approvals in one turn");
    return rows.map(mapCodemodeOperation);
  });
}

/** Current worker adopts the exact reviewed operation only after a committed human decision.
 * Catalog and origin remain immutable; the separate execution FK names the new owner.
 */
export async function adoptCodemodeApproval(
  db: Database,
  input: CodemodeContinuationScope & {
    operationId: string;
    callerSubjectId: string;
    catalogDigest: string;
    effectDigest: string | null;
  },
  onTerminal?: (tx: Database, operation: CodemodeOperation) => Promise<void>,
): Promise<CodemodeOperation | null> {
  return await withRlsContext(
    db,
    input,
    async (scoped) =>
      await scoped.transaction(async (tx) => {
        await lockActiveTurn(tx as unknown as Database, input);
        const [row] = await tx
          .select()
          .from(schema.sessionAttemptCodemodeCalls)
          .where(
            and(
              eq(schema.sessionAttemptCodemodeCalls.workspaceId, input.workspaceId),
              eq(schema.sessionAttemptCodemodeCalls.sessionId, input.sessionId),
              eq(schema.sessionAttemptCodemodeCalls.turnId, input.turnId),
              eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row?.durableApproval || !codemodeCallerCanContinue(row, input)) return null;
        if (!["waiting_for_approval", "queued", "running"].includes(row.state))
          return mapCodemodeOperation(row);
        if (
          ["queued", "running"].includes(row.state) &&
          (row.executionAttemptId ?? row.attemptId) === input.attemptId
        )
          return mapCodemodeOperation(row);
        if (row.executionStartedAt) {
          const [uncertain] = await tx
            .update(schema.sessionAttemptCodemodeCalls)
            .set({
              executionAttemptId: input.attemptId,
              executionAttemptGeneration: input.executionGeneration,
              executionCatalogDigest: input.catalogDigest,
              state: "outcome_unknown",
              completedAt: new Date(),
              updatedAt: new Date(),
              errorCode: "worker_lost_during_execution",
              errorMessage:
                "Execution started before its worker ended. Inspect actual state before retrying.",
            })
            .where(eq(schema.sessionAttemptCodemodeCalls.operationId, row.operationId))
            .returning();
          const operation = mapCodemodeOperation(uncertain!);
          await onTerminal?.(tx as unknown as Database, operation);
          return operation;
        }
        const [request] = await tx
          .select()
          .from(schema.connectorActionRequests)
          .where(
            and(
              ...(row.approvalRequestId
                ? [eq(schema.connectorActionRequests.id, row.approvalRequestId)]
                : []),
              eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
              eq(schema.connectorActionRequests.sessionId, input.sessionId),
              eq(schema.connectorActionRequests.turnId, input.turnId),
              eq(schema.connectorActionRequests.approvalId, row.operationId),
            ),
          )
          .limit(1);
        const stale = input.effectDigest === null || row.effectDigest !== input.effectDigest;
        const now = new Date();
        if (request?.status === "pending" && !stale) {
          // Repair a crash after request creation but before the waiting link committed.
          const [waiting] = await tx
            .update(schema.sessionAttemptCodemodeCalls)
            .set({
              state: "waiting_for_approval",
              approvalRequestId: request.id,
              claimId: null,
              claimedAt: null,
              claimExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(schema.sessionAttemptCodemodeCalls.operationId, row.operationId))
            .returning();
          return mapCodemodeOperation(waiting!);
        }
        const approved = (!request || request.status === "approved") && !stale;
        const [updated] = await tx
          .update(schema.sessionAttemptCodemodeCalls)
          .set(
            approved
              ? {
                  state: "queued",
                  claimId: null,
                  claimedAt: null,
                  claimExpiresAt: null,
                  executionAttemptId: input.attemptId,
                  executionAttemptGeneration: input.executionGeneration,
                  executionCatalogDigest: input.catalogDigest,
                  ...(request ? { approvalRequestId: request.id } : {}),
                  updatedAt: now,
                }
              : {
                  executionAttemptId: input.attemptId,
                  executionAttemptGeneration: input.executionGeneration,
                  executionCatalogDigest: input.catalogDigest,
                  state: "cancelled",
                  claimId: null,
                  claimedAt: null,
                  claimExpiresAt: null,
                  completedAt: now,
                  updatedAt: now,
                  errorCode: stale ? "approval_stale" : "approval_rejected",
                  errorMessage: stale
                    ? "The tool or account changed. Prepare a new action for review."
                    : "This action was declined or is no longer available.",
                },
          )
          .where(eq(schema.sessionAttemptCodemodeCalls.operationId, row.operationId))
          .returning();
        const operation = mapCodemodeOperation(updated!);
        if (!approved) await onTerminal?.(tx as unknown as Database, operation);
        return operation;
      }),
  );
}

/**
 * Read a handle with the current exact attempt and same original caller; old
 * bearer authority is insufficient. This is a status read polled while a
 * caller waits, so it is one plain snapshot select: it proves the exact live
 * attempt in the same statement but takes no session/turn/attempt row locks
 * and is not refused by a pending Pause/Steer, which owns the write fence only.
 */
export async function readTurnCodemodeOperation(
  db: Database,
  input: CodemodeContinuationScope & {
    operationId: string;
    callerSubjectId: string;
  },
): Promise<CodemodeOperation | null> {
  return await withRlsContext(db, input, async (scoped) => {
    const [live] = await scoped
      .select({ attemptId: schema.sessionTurnAttempts.id })
      .from(schema.sessionTurns)
      .innerJoin(
        schema.sessionTurnAttempts,
        and(
          eq(schema.sessionTurnAttempts.id, schema.sessionTurns.activeAttemptId),
          eq(schema.sessionTurnAttempts.turnId, schema.sessionTurns.id),
          eq(schema.sessionTurnAttempts.sessionId, schema.sessionTurns.sessionId),
          eq(schema.sessionTurnAttempts.accountId, schema.sessionTurns.accountId),
          eq(
            schema.sessionTurnAttempts.executionGeneration,
            schema.sessionTurns.executionGeneration,
          ),
        ),
      )
      .where(
        and(
          eq(schema.sessionTurns.id, input.turnId),
          eq(schema.sessionTurns.accountId, input.accountId),
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, input.sessionId),
          eq(schema.sessionTurns.status, "running"),
          eq(schema.sessionTurns.activeAttemptId, input.attemptId),
          eq(schema.sessionTurns.executionGeneration, input.executionGeneration),
          inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
        ),
      )
      .limit(1);
    if (!live) throw new CodemodeOperationNotExecutableError();
    const [row] = await scoped
      .select()
      .from(schema.sessionAttemptCodemodeCalls)
      .where(
        and(
          eq(schema.sessionAttemptCodemodeCalls.workspaceId, input.workspaceId),
          eq(schema.sessionAttemptCodemodeCalls.sessionId, input.sessionId),
          eq(schema.sessionAttemptCodemodeCalls.turnId, input.turnId),
          eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
        ),
      )
      .limit(1);
    return row && codemodeCallerCanContinue(row, input) ? mapCodemodeOperation(row) : null;
  });
}

/** Signed sandbox subjects are attempt-bound; only the same owning turn can use this mapping. */
export function codemodeCallerCanContinue(
  row: { attemptId: string; callerSubjectId: string },
  current: { attemptId: string; callerSubjectId: string },
): boolean {
  return (
    row.callerSubjectId === current.callerSubjectId ||
    (row.callerSubjectId === `sandbox:${row.attemptId}` &&
      current.callerSubjectId === `sandbox:${current.attemptId}`)
  );
}
