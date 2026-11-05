import { metadataWithTurnExecutionPolicyV1, type TurnExecutionPolicyV1 } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import type { Database, SessionActivityDatabase } from "./database";
import * as schema from "./schema";
import { capacityWaitNoticeWithdrawal, withoutCapacityWaitNotice } from "./capacity-wait-attention";
import { clearCodexCapacityRecovery } from "./codex-capacity-recovery";
import { withLosslessContentWriteVersion } from "./lossless-json";
import {
  evaluateSessionControl,
  registerSessionWorkflowWakeInTransaction,
} from "./session-control";
import { deleteSubscriptionCoreWaitersForTurns } from "./subscription-core/waiters";

/**
 * Releasing a turn parked on subscription capacity.
 *
 * A capacity wait belongs to its accepted turn, so on its own it outlives both
 * a model switch (which changes only the chat's future turns) and Pause
 * (which holds the wait for Resume). When a person or parent switches the
 * chat's model, or pauses it, they mean the waiting work: a model switch
 * moves the waiting turn onto the new model and it continues now; Pause
 * stops the wait, and Resume (or a later model switch) continues the turn.
 *
 * The released turn becomes `recovering` on the same logical turn, exactly
 * as a capacity resume or a paused running turn does, so nothing the model
 * already saw is replayed differently.
 */
export const CAPACITY_WAIT_RELEASE_KEY = "capacityWaitReleaseV1";

export type CapacityWaitReleaseTrigger = "model_switch" | "session_pause";

type SessionRow = typeof schema.sessions.$inferSelect;
type TurnRow = typeof schema.sessionTurns.$inferSelect;

/** A turn Pause released from its capacity wait and that has not run since. */
function pausedCapacityRelease(turn: TurnRow): boolean {
  const marker = (turn.metadata as Record<string, unknown> | null)?.[CAPACITY_WAIT_RELEASE_KEY];
  return (
    !!marker &&
    typeof marker === "object" &&
    (marker as { executionGeneration?: unknown }).executionGeneration === turn.executionGeneration
  );
}

/** Whether this session's active turn is one a release applies to now. */
export function capacityWaitReleasable(
  session: Pick<SessionRow, "status" | "activeTurnId">,
  turn: TurnRow,
  trigger: CapacityWaitReleaseTrigger,
): boolean {
  if (session.activeTurnId !== turn.id || turn.activeAttemptId !== null) return false;
  if (turn.status === "waiting_capacity") return session.status === "waiting_capacity";
  // A model switch also moves a turn Pause already released onto the new model.
  return trigger === "model_switch" && turn.status === "recovering" && pausedCapacityRelease(turn);
}

/**
 * The caller holds the canonical session-event locks for `sessionId` and
 * `turnId` (and, for Pause, has already committed the control change in this
 * transaction). Returns the inserted event ids, or null when the turn is not
 * releasable.
 */
export async function releaseCapacityWaitingTurnInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    trigger: CapacityWaitReleaseTrigger;
    /** The new model's accepted execution policy (model switch only). */
    executionPolicy?: TurnExecutionPolicyV1;
    now?: Date;
  },
): Promise<{ eventIds: string[]; paused: boolean } | null> {
  const now = input.now ?? new Date();
  // Re-read under the caller's locks: the caller may already have appended.
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    )
    .limit(1);
  const [turn] = await db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.id, input.turnId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  if (!session || !turn || session.accountId !== input.accountId) return null;
  if (!capacityWaitReleasable(session, turn, input.trigger)) return null;
  if (input.trigger === "model_switch" && !input.executionPolicy) {
    throw new Error("A model switch release needs the new execution policy");
  }
  const control = await evaluateSessionControl(
    db as unknown as Database,
    input.workspaceId,
    input.sessionId,
  );
  const paused = control.state !== "active";
  // Pause releases only what it actually pauses (a resumed sub-chat keeps running).
  if (input.trigger === "session_pause" && !paused) return null;

  if (turn.status === "waiting_capacity") {
    await deleteSubscriptionCoreWaitersForTurns(db, null, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnIds: [turn.id],
    });
  }
  const withdrawal = capacityWaitNoticeWithdrawal(turn.metadata);
  const baseMetadata = withoutCapacityWaitNotice({ ...(turn.metadata ?? {}) });
  delete baseMetadata[CAPACITY_WAIT_RELEASE_KEY];
  const policy = input.executionPolicy;
  const metadata = policy
    ? // A fresh model is a fresh capacity question: its breaker starts over.
      metadataWithTurnExecutionPolicyV1(clearCodexCapacityRecovery(baseMetadata), policy)
    : {
        ...baseMetadata,
        [CAPACITY_WAIT_RELEASE_KEY]: { executionGeneration: turn.executionGeneration },
      };
  await db
    .update(schema.sessionTurns)
    .set({
      status: "recovering",
      activeAttemptId: null,
      finishedAt: null,
      version: turn.version + 1,
      ...(policy
        ? {
            model: policy.productModelId,
            reasoningEffort: policy.reasoningEffort,
            latencyMode: policy.latencyMode,
          }
        : {}),
      metadata,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.id, turn.id),
      ),
    );

  const status = paused ? "idle" : "recovering";
  const base = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: turn.id,
    turnGeneration: turn.executionGeneration,
    turnAssociation: "current" as const,
    occurredAt: now,
  };
  const values = [
    {
      ...base,
      type: "turn.recovery.requested",
      payload: {
        reason: input.trigger,
        capacityWaitReleased: true,
        ...(policy
          ? {
              model: policy.productModelId,
              reasoningEffort: policy.reasoningEffort,
              latencyMode: policy.latencyMode,
            }
          : {}),
      },
    },
    {
      ...base,
      type: "session.status.changed",
      payload: paused
        ? { status, reason: "paused_recovery_settled" }
        : { status, reason: "capacity_wait_released" },
    },
    ...(withdrawal ? [{ ...base, ...withdrawal }] : []),
  ].map((value, index) => ({ ...value, sequence: session.lastSequence + index + 1 }));
  const events = await db
    .insert(schema.sessionEvents)
    .values(withLosslessContentWriteVersion(values, "payload", "payloadCodecVersion"))
    .returning({ id: schema.sessionEvents.id });
  await db
    .update(schema.sessions)
    .set({
      status,
      activeTurnId: turn.id,
      lastSequence: session.lastSequence + values.length,
      queueVersion: session.queueVersion + 1,
      updatedAt: now,
    })
    .where(
      and(eq(schema.sessions.workspaceId, input.workspaceId), eq(schema.sessions.id, session.id)),
    );
  // An interruption-class wake ends the workflow's capacity sleep at once; it
  // then finds no waiter and claims the turn, or idles while paused.
  await registerSessionWorkflowWakeInTransaction(db as unknown as Database, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    temporalWorkflowId: session.temporalWorkflowId ?? `session-${input.sessionId}`,
    reason: `capacity_wait_released_${input.trigger}`,
    controlRequested: true,
  });
  return { eventIds: events.map((event) => event.id), paused };
}
