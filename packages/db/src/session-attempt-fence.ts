import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";
import {
  lockSessionEventWriteRows,
  evaluateSessionWriteAdmissionControl,
  assertSessionAuthoritySnapshot,
  sessionAuthoritySnapshotMatchesSession,
} from "./session-control";

export type TurnAttemptFenceRejectReason =
  | "workspace_paused"
  | "session_paused"
  | "pending_control"
  | "active_turn_changed"
  | "generation_changed"
  | "attempt_changed"
  | "turn_terminal"
  | "not_found";

type TurnAttemptFenceResult =
  | {
      allowed: true;
      workspace: typeof schema.workspaces.$inferSelect;
      session: typeof schema.sessions.$inferSelect;
      turn: typeof schema.sessionTurns.$inferSelect;
      attempt: typeof schema.sessionTurnAttempts.$inferSelect;
    }
  | {
      allowed: false;
      reason: TurnAttemptFenceRejectReason;
      workspace: typeof schema.workspaces.$inferSelect | null;
      session: typeof schema.sessions.$inferSelect | null;
      turn: typeof schema.sessionTurns.$inferSelect | null;
      attempt: typeof schema.sessionTurnAttempts.$inferSelect | null;
    };

/**
 * Lock order for every activity write fence: workspace control -> actual
 * workspace -> session -> exact turn -> exact attempt.
 *
 * Activity writes only need a shared workspace admission lock: concurrent
 * sessions may write independently, while an exclusive workspace Pause/Resume
 * still waits for every admitted write and prevents later writes from crossing
 * the control boundary. Using FOR UPDATE here serialized every active session in
 * one workspace behind a single row and turned streaming into a workspace-wide
 * lock queue.
 */
export async function lockTurnAttemptWriteFenceTx(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
    sessionLock?: "no_key_update" | "key_share";
  },
): Promise<TurnAttemptFenceResult> {
  const locks = await lockSessionEventWriteRows(tx, {
    workspaceId: input.workspaceId,
    controlLock: "share",
    sessionLock: input.sessionLock ?? "no_key_update",
    sessionIds: [input.sessionId],
    turnIds: [input.turnId],
    attemptIds: [input.attemptId],
  });
  const workspace = locks.workspace;
  const session = locks.sessions.find((row) => row.id === input.sessionId) ?? null;
  const turn = locks.turns.find((row) => row.id === input.turnId) ?? null;
  const attempt = locks.attempts.find((row) => row.id === input.attemptId) ?? null;
  const base = { workspace, session, turn, attempt };
  if (!workspace || !session || !turn || !attempt) {
    return { allowed: false, reason: "not_found", ...base };
  }
  const effectiveControl = await evaluateSessionWriteAdmissionControl(
    tx,
    input.workspaceId,
    input.sessionId,
    {
      workspaceControl: locks.control ?? undefined,
    },
  );
  if (effectiveControl.state === "paused") {
    return {
      allowed: false,
      reason:
        effectiveControl.primaryBlockerKind === "workspace" ? "workspace_paused" : "session_paused",
      ...base,
    };
  }
  if (session.activeTurnId !== input.turnId) {
    return { allowed: false, reason: "active_turn_changed", ...base };
  }
  if (turn.executionGeneration !== input.executionGeneration) {
    return { allowed: false, reason: "generation_changed", ...base };
  }
  if (turn.activeAttemptId !== input.attemptId) {
    return { allowed: false, reason: "attempt_changed", ...base };
  }
  if (
    turn.accountId !== session.accountId ||
    turn.sessionId !== input.sessionId ||
    attempt.accountId !== session.accountId ||
    attempt.sessionId !== input.sessionId ||
    attempt.turnId !== input.turnId ||
    attempt.executionGeneration !== input.executionGeneration ||
    !["claimed", "running"].includes(attempt.state)
  ) {
    return { allowed: false, reason: "attempt_changed", ...base };
  }
  let authoritySnapshot;
  try {
    authoritySnapshot = assertSessionAuthoritySnapshot({
      attemptId: input.attemptId,
      authorityEpoch: attempt.authorityEpoch,
      authorityVisibility: attempt.authorityVisibility,
      authorityOwnerOrganizationMembershipId: attempt.authorityOwnerOrganizationMembershipId,
    });
  } catch {
    // The 0222 insert trigger keeps old writers rolling-safe, but no missing
    // or partial tuple may cross an accepted-attempt write fence.
    return { allowed: false, reason: "attempt_changed", ...base };
  }
  if (!sessionAuthoritySnapshotMatchesSession(authoritySnapshot, session)) {
    return { allowed: false, reason: "attempt_changed", ...base };
  }
  const [interruption] = await tx
    .select({ id: schema.sessionAttemptInterruptions.id })
    .from(schema.sessionAttemptInterruptions)
    .where(
      and(
        eq(schema.sessionAttemptInterruptions.workspaceId, input.workspaceId),
        eq(schema.sessionAttemptInterruptions.sessionId, input.sessionId),
        eq(schema.sessionAttemptInterruptions.attemptId, input.attemptId),
        inArray(schema.sessionAttemptInterruptions.state, ["pending", "delivered", "acknowledged"]),
      ),
    )
    .limit(1);
  if (interruption) {
    return { allowed: false, reason: "pending_control", ...base };
  }
  if (!["running", "requires_action"].includes(turn.status)) {
    return { allowed: false, reason: "turn_terminal", ...base };
  }
  return { allowed: true, workspace, session, turn, attempt };
}
