import { and, eq } from "drizzle-orm";
import { LatencyMode, ReasoningEffort } from "@opengeni/contracts";
import type { SessionActivityDatabase } from "./database";
import * as schema from "./schema";
import { withLosslessContentWriteVersion } from "./lossless-json";
import { withEffectiveSessionPolicy } from "./session-execution-policy";
import {
  assertAgentCommandAuthorityInTransaction,
  canonicalSessionCommandHash,
  lockSessionEventWriteRows,
  reserveSessionCommandReceipt,
  SessionCommandIdempotencyError,
  updateSessionCommandReceiptResult,
  type SessionCommandActor,
} from "./session-control";

/** Caller owns the RLS transaction. This never accepts, wakes or changes a turn. */
export async function setSessionModelInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    actor: SessionCommandActor;
    operationKey: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    /** Synchronous validation against the locked session, not an earlier read. */
    validate?: (session: typeof schema.sessions.$inferSelect) => void;
  },
) {
  const agent = input.actor.type === "agent_attempt" ? input.actor : null;
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "share",
    sessionIds: [input.sessionId, ...(agent ? [agent.sessionId] : [])],
    turnIds: agent ? [agent.turnId] : [],
    attemptIds: agent ? [agent.attemptId] : [],
  });
  const session = locks.sessions.find((row) => row.id === input.sessionId);
  if (!session || session.accountId !== input.accountId) throw new Error("Session not found");
  if (agent) {
    await assertAgentCommandAuthorityInTransaction(db, {
      workspaceId: input.workspaceId,
      actor: agent,
      targetSessionId: input.sessionId,
      action: "model_settings",
    });
  }
  const canonicalRequestHash = canonicalSessionCommandHash({
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  });
  // A reconnect can replace the caller attempt, not the command's identity.
  // The target lock serializes this lookup with every settings writer. Bind
  // reuse to the original attempt's durable session, never a supplied identity;
  // the current attempt and target authority were independently checked above.
  const [retained] = agent
    ? await db
        .select({ receipt: schema.sessionCommandReceipts })
        .from(schema.sessionCommandReceipts)
        .innerJoin(
          schema.sessionTurnAttempts,
          and(
            eq(schema.sessionTurnAttempts.workspaceId, schema.sessionCommandReceipts.workspaceId),
            eq(schema.sessionTurnAttempts.id, schema.sessionCommandReceipts.actorAttemptId),
          ),
        )
        .where(
          and(
            eq(schema.sessionCommandReceipts.workspaceId, input.workspaceId),
            eq(schema.sessionCommandReceipts.targetSessionId, input.sessionId),
            eq(schema.sessionCommandReceipts.action, "session.model_settings"),
            eq(schema.sessionCommandReceipts.operationKey, input.operationKey),
            eq(schema.sessionTurnAttempts.sessionId, agent.sessionId),
          ),
        )
        .limit(1)
    : [];
  if (retained && retained.receipt.canonicalRequestHash !== canonicalRequestHash) {
    throw new SessionCommandIdempotencyError();
  }
  const reserved = retained
    ? { receipt: retained.receipt, replay: true }
    : await reserveSessionCommandReceipt(db, {
        ...input,
        action: "session.model_settings",
        targetSessionId: input.sessionId,
        targetTurnId: null,
        canonicalRequestHash,
      });
  if (reserved.replay) {
    const result = reserved.receipt.result;
    if (typeof result.model !== "string" || typeof result.eventId !== "string") {
      throw new Error("Session model settings receipt is incomplete");
    }
    return {
      model: result.model,
      reasoningEffort: ReasoningEffort.parse(result.reasoningEffort),
      latencyMode: LatencyMode.parse(result.latencyMode),
      eventId: result.eventId,
      receiptId: reserved.receipt.id,
      timestamp: reserved.receipt.createdAt.toISOString(),
      replay: true,
    };
  }
  const [effective] = await withEffectiveSessionPolicy(db, input.workspaceId, [session]);
  input.validate?.(effective!);
  const settings = {
    model: input.model,
    reasoningEffort: ReasoningEffort.parse(input.reasoningEffort),
    latencyMode: LatencyMode.parse(effective!.latencyMode),
  };
  const sequence = session.lastSequence + 1;
  const now = new Date();
  await db
    .update(schema.sessions)
    .set({ ...settings, lastSequence: sequence, updatedAt: now })
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    );
  const [event] = await db
    .insert(schema.sessionEvents)
    .values(
      withLosslessContentWriteVersion(
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sequence,
          type: "session.model_settings.updated",
          payload: { ...settings, effectiveFrom: "future_turns", receiptId: reserved.receipt.id },
          occurredAt: now,
        },
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new Error("Session model settings event was not persisted");
  await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    result: { ...settings, eventId: event.id },
  });
  return {
    ...settings,
    eventId: event.id,
    receiptId: reserved.receipt.id,
    timestamp: reserved.receipt.createdAt.toISOString(),
    replay: false,
  };
}
