import {
  metadataWithTurnExecutionPolicyV1,
  type SessionRetryRequest,
  type SessionRetryResponse,
  SessionRetryResponse as SessionRetryResponseSchema,
  type TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { rawRows, type Database, type SessionActivityDatabase } from "./database";
import * as schema from "./schema";
import { clearCodexCapacityRecovery } from "./codex-capacity-recovery";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "./lossless-json";
import { sessionAttemptPendingWritersSql } from "./session-attempt-writers";
import {
  canonicalSessionCommandHash,
  evaluateSessionControl,
  lockSessionEventWriteRows,
  registerSessionWorkflowWakeInTransaction,
  reserveSessionCommandReceipt,
  updateSessionCommandReceiptResult,
  SessionCommandIdempotencyError,
} from "./session-control";

export class SessionRetryConflictError extends Error {
  constructor(
    readonly code:
      | "RETRY_STALE_FAILURE"
      | "RETRY_EXECUTION_UNRESOLVED"
      | "RETRY_PAUSED"
      | "RETRY_UNSUPPORTED_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "SessionRetryConflictError";
  }
}

/** Authorized receipt reads precede mutable model/billing admission checks. */
export async function getSessionRetryReceiptInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    request: SessionRetryRequest;
  },
): Promise<SessionRetryResponse | null> {
  const [receipt] = await db
    .select()
    .from(schema.sessionCommandReceipts)
    .where(
      and(
        eq(schema.sessionCommandReceipts.workspaceId, input.workspaceId),
        eq(schema.sessionCommandReceipts.targetSessionId, input.sessionId),
        eq(schema.sessionCommandReceipts.actorType, "human"),
        eq(schema.sessionCommandReceipts.actorSubjectId, input.subjectId),
        eq(schema.sessionCommandReceipts.action, "session.retry"),
        eq(schema.sessionCommandReceipts.operationKey, input.request.clientEventId),
      ),
    )
    .limit(1);
  if (!receipt) return null;
  if (receipt.canonicalRequestHash !== canonicalSessionCommandHash(input.request))
    throw new SessionCommandIdempotencyError();
  return { ...SessionRetryResponseSchema.parse(receipt.result), outcome: "replayed" };
}

/** Caller owns the tenant/activity transaction and authorization. No provider I/O. */
export async function retryFailedSessionInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    request: SessionRetryRequest;
    executionPolicy: TurnExecutionPolicyV1;
  },
): Promise<SessionRetryResponse & { eventIds: string[] }> {
  const { accountId, workspaceId, sessionId, request } = input;
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId,
    controlLock: "share",
    sessionIds: [sessionId],
  });
  const session = locks.sessions[0];
  if (!session || session.accountId !== accountId)
    throw new SessionRetryConflictError("RETRY_STALE_FAILURE", "Session is unavailable");
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId,
    workspaceId,
    targetSessionId: sessionId,
    targetTurnId: null,
    actor: { type: "human", subjectId: input.subjectId },
    action: "session.retry",
    operationKey: request.clientEventId,
    canonicalRequestHash: canonicalSessionCommandHash(request),
  });
  if (reserved.replay)
    return {
      ...SessionRetryResponseSchema.parse(reserved.receipt.result),
      outcome: "replayed",
      eventIds: [],
    };
  const control = await evaluateSessionControl(db, workspaceId, sessionId, {
    workspaceControl: locks.control ?? undefined,
  });
  if (control.state !== "active")
    throw new SessionRetryConflictError(
      "RETRY_PAUSED",
      "Resume the deliberately paused workstream before retrying",
    );
  if (session.status !== "failed" || session.activeTurnId !== null)
    throw new SessionRetryConflictError(
      "RETRY_STALE_FAILURE",
      "The failed session boundary changed",
    );
  const [failure] = await db
    .select()
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        sql`(${schema.sessionEvents.turnAssociation} is null or ${schema.sessionEvents.turnAssociation} = 'current')`,
        sql`(${schema.sessionEvents.type} = 'turn.failed' or (${schema.sessionEvents.type} = 'session.status.changed' and ${schema.sessionEvents.payload}->>'status' = 'failed' and ${schema.sessionEvents.turnId} is null))`,
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1);
  if (!failure || failure.id !== request.failureEventId)
    throw new SessionRetryConflictError(
      "RETRY_STALE_FAILURE",
      "The failure event is no longer current",
    );
  const failurePayload = fromPostgresLosslessJson(failure.payload, failure.payloadCodecVersion);
  if (
    failurePayload !== null &&
    typeof failurePayload === "object" &&
    !Array.isArray(failurePayload) &&
    (failurePayload as Record<string, unknown>).code === "provider_safety_refusal"
  )
    throw new SessionRetryConflictError(
      "RETRY_UNSUPPORTED_FAILURE",
      "A provider safety refusal cannot be retried as the same logical turn",
    );
  if (!failure.turnId)
    throw new SessionRetryConflictError(
      "RETRY_UNSUPPORTED_FAILURE",
      "This failure has no retained logical turn to retry",
    );
  const [turn] = await db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        eq(schema.sessionTurns.id, failure.turnId),
      ),
    )
    .for("update");
  if (!turn || turn.status !== "failed" || turn.activeAttemptId !== null)
    throw new SessionRetryConflictError("RETRY_STALE_FAILURE", "The failed turn changed");
  if (failure.turnGeneration !== null && failure.turnGeneration !== turn.executionGeneration)
    throw new SessionRetryConflictError(
      "RETRY_STALE_FAILURE",
      "The failed execution generation changed",
    );
  if (turn.scheduledTaskRunId !== null)
    throw new SessionRetryConflictError(
      "RETRY_UNSUPPORTED_FAILURE",
      "A settled scheduled occurrence cannot be reopened as a human retry",
    );
  const [unresolved] = await rawRows<{ pending: boolean }>(
    db,
    sql`select (
    exists (select 1 from session_turn_attempts attempt where attempt.workspace_id = ${workspaceId} and attempt.session_id = ${sessionId}
      and (attempt.state <> 'closed' or ${sessionAttemptPendingWritersSql(sql`attempt`)}
        or (attempt.quiesced_at is null and exists (select 1 from session_attempt_interruptions interruption where interruption.attempt_id = attempt.id))))
    or exists (select 1 from session_pending_tool_calls pending where pending.workspace_id = ${workspaceId} and pending.session_id = ${sessionId})
    or exists (select 1 from session_events tool_event where tool_event.workspace_id = ${workspaceId} and tool_event.session_id = ${sessionId} and tool_event.turn_id = ${turn.id}
      and tool_event.type = 'agent.toolCall.output' and tool_event.payload->'recovery'->>'outcome' = 'unknown')
    or exists (select 1 from session_turns live where live.workspace_id = ${workspaceId} and live.session_id = ${sessionId} and live.status in ('running', 'recovering', 'requires_action', 'waiting_capacity'))
  ) as pending`,
  );
  if (unresolved?.pending)
    throw new SessionRetryConflictError(
      "RETRY_EXECUTION_UNRESOLVED",
      "Execution or tool settlement is unresolved; retry cannot replay it",
    );
  const now = new Date();
  // A never-claimed prompt must traverse normal first claim exactly once so
  // its original user history item is inserted. Started turns retain history.
  const preclaim = turn.executionGeneration === 0;
  const policy = input.executionPolicy;
  const capacityRecoveryRetry =
    failurePayload !== null &&
    typeof failurePayload === "object" &&
    !Array.isArray(failurePayload) &&
    (failurePayload as Record<string, unknown>).code === "codex_capacity_recovery_exhausted";
  // Only this explicitly authorized, exact failure-event Retry may replenish
  // the breaker. Preserve accepted credential policy/refusal ledgers and all
  // unrelated recovery budgets. Receipt replay returned above cannot reset it.
  const retryMetadata = capacityRecoveryRetry
    ? clearCodexCapacityRecovery(turn.metadata ?? {})
    : turn.metadata;
  if (capacityRecoveryRetry) {
    await db
      .update(schema.sessionGoals)
      .set({ continuationSuppressedTurnId: null, updatedAt: now })
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          eq(schema.sessionGoals.sessionId, sessionId),
          eq(schema.sessionGoals.continuationSuppressedTurnId, turn.id),
        ),
      );
  }
  await db
    .update(schema.sessionTurns)
    .set({
      status: preclaim ? "queued" : "recovering",
      finishedAt: null,
      updatedAt: now,
      version: turn.version + 1,
      model: policy.productModelId,
      reasoningEffort: policy.reasoningEffort,
      latencyMode: policy.latencyMode,
      metadata: metadataWithTurnExecutionPolicyV1(retryMetadata, policy),
    })
    .where(eq(schema.sessionTurns.id, turn.id));
  const events = await db
    .insert(schema.sessionEvents)
    .values(
      withLosslessContentWriteVersion(
        [
          {
            accountId,
            workspaceId,
            sessionId,
            sequence: session.lastSequence + 1,
            type: "turn.recovery.requested",
            turnId: turn.id,
            turnGeneration: turn.executionGeneration,
            turnAssociation: "current",
            payload: {
              reason: "human_retry",
              failureEventId: failure.id,
              operationId: request.clientEventId,
              model: policy.productModelId,
              reasoningEffort: policy.reasoningEffort,
              latencyMode: policy.latencyMode,
            },
            occurredAt: now,
          },
          {
            accountId,
            workspaceId,
            sessionId,
            sequence: session.lastSequence + 2,
            type: "session.status.changed",
            turnId: turn.id,
            turnGeneration: turn.executionGeneration,
            turnAssociation: "current",
            payload: { status: preclaim ? "queued" : "recovering" },
            occurredAt: now,
          },
        ],
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionEvents.id });
  await db
    .update(schema.sessions)
    .set({
      status: preclaim ? "queued" : "recovering",
      activeTurnId: preclaim ? null : turn.id,
      admissionBlock: null,
      lastSequence: session.lastSequence + 2,
      queueVersion: session.queueVersion + 1,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, sessionId));
  await registerSessionWorkflowWakeInTransaction(db, {
    accountId,
    workspaceId,
    sessionId,
    temporalWorkflowId: session.temporalWorkflowId ?? `session-${sessionId}`,
    reason: "human_failed_session_retry",
  });
  const response = { outcome: "accepted", turnId: turn.id, failureEventId: failure.id } as const;
  await updateSessionCommandReceiptResult(db, reserved.receipt.id, { result: response });
  return { ...response, eventIds: events.map((event) => event.id) };
}
