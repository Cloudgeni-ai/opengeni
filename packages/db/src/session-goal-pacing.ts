import { and, eq } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";

/** Column reset shared by every goal head mutation that retires a `goal_wait` hold. */
export const SESSION_GOAL_HOLD_CLEARED = {
  continuationHoldTurnId: null,
  continuationHoldUntil: null,
  continuationHoldReason: null,
  continuationHoldSetAt: null,
} as const;

/** The pause reason written when a per-goal or deployment continuation ceiling is reached. */
export const SESSION_GOAL_CAP_PAUSED_REASON = "max_auto_continuations";

/**
 * Column reset applied when a goal re-arms: a fresh continuation epoch starts
 * with zero consecutive no-input continuations and no pointer to a
 * pre-pause continuation turn.
 */
export const SESSION_GOAL_CONTINUATION_EPOCH_RESET = {
  autoContinuations: 0,
  noProgressStreak: 0,
  lastContinuationTurnId: null,
  versionAtLastContinuation: null,
} as const;

export type SessionGoalAutoResumeCause = {
  /** The system-update kind that arrived, or `human_prompt` for a Send/Steer. */
  kind: string;
  updateId?: string;
  turnId?: string;
};

export type SessionGoalAutoResumedByExternalInput = {
  goal: typeof schema.sessionGoals.$inferSelect;
  /** `goal.resumed` payload the caller appends at its next session sequence. */
  payload: {
    goalId: string;
    text: string;
    successCriteria?: string;
    version: number;
    objectiveRevision: number;
    mutationPolicy: string;
    actor: "system";
    reason: "external_input";
    cause: SessionGoalAutoResumeCause;
  };
};

/**
 * Resume a goal that the continuation ceiling paused, because new external
 * input arrived. The ceiling (`max_auto_continuations`) is pacing for
 * consecutive no-input continuations, never user intent: a `user_pause`,
 * `api`, `agent`, `limits`, or `no_progress` pause is deliberately left alone
 * and is never resumed here.
 *
 * Lock contract: the caller already holds the canonical event-write prefix
 * and the session row (`FOR NO KEY UPDATE`); this helper then takes the goal
 * row `FOR UPDATE`, the same order every goal tool uses. It mutates only the
 * goal head and returns the `goal.resumed` payload; the caller must append
 * that event at its next session sequence inside the SAME transaction so the
 * goal mutation and its timeline fact remain one session-sequenced commit.
 * Returns null when the session has no goal or its pause is not the ceiling.
 */
export async function autoResumeGoalPausedByCapInTransaction(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    cause: SessionGoalAutoResumeCause;
    now: Date;
  },
): Promise<SessionGoalAutoResumedByExternalInput | null> {
  const [existing] = await tx
    .select()
    .from(schema.sessionGoals)
    .where(
      and(
        eq(schema.sessionGoals.workspaceId, input.workspaceId),
        eq(schema.sessionGoals.sessionId, input.sessionId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !existing ||
    existing.status !== "paused" ||
    existing.pausedReason !== SESSION_GOAL_CAP_PAUSED_REASON
  ) {
    return null;
  }
  const [resumed] = await tx
    .update(schema.sessionGoals)
    .set({
      status: "active",
      rationale: null,
      pausedReason: null,
      version: existing.version + 1,
      continuationWakeRevision: existing.continuationWakeRevision + 1,
      ...SESSION_GOAL_CONTINUATION_EPOCH_RESET,
      ...SESSION_GOAL_HOLD_CLEARED,
      updatedAt: input.now,
    })
    .where(eq(schema.sessionGoals.id, existing.id))
    .returning();
  if (!resumed) throw new Error(`Session goal not found: ${input.sessionId}`);
  return {
    goal: resumed,
    payload: {
      goalId: resumed.id,
      text: resumed.text,
      ...(resumed.successCriteria ? { successCriteria: resumed.successCriteria } : {}),
      version: resumed.version,
      objectiveRevision: resumed.objectiveRevision,
      mutationPolicy: resumed.mutationPolicy,
      actor: "system",
      reason: "external_input",
      cause: input.cause,
    },
  };
}
