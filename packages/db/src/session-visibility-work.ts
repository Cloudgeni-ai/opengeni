import { createHash } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { rawRows, type Database, type SessionActivityDatabase } from "./database";
import { cancelTurnInteractionInterventionsInTransaction } from "./browser-auth";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";
import {
  lockSessionEventWriteRows,
  lockWorkspaceInferenceControl,
  registerSessionWorkflowWakeInTransaction,
} from "./session-control";
import { withBoundSessionEventPayloads } from "./session-event-write-bounds";
import { SESSION_GOAL_SUPPRESSION_CLEARED } from "./session-goal-pacing";
import { closePendingSessionToolCallsInTransaction } from "./session-tool-call-settlement";
import { deleteSubscriptionCoreWaitersForTurns } from "./subscription-core/waiters";

/**
 * Making a chat Only me never refuses because of what is in the chat. What is
 * in it falls into four groups:
 *
 * - leftovers: turns still marked queued/recovering/waiting for capacity while
 *   the session itself no longer shows work, an expired voice lease, a voice
 *   connection whose session already ended. Nothing will ever use them; they
 *   are settled silently.
 * - stoppable work: what the person can see running or waiting in the chat
 *   (the current response, queued messages, a pending question, an active
 *   goal, a live voice session).
 * - other people's authority: pending updates that carry another member's
 *   frozen authority and subscription account choices the owner cannot use.
 *   The transition routine drops them.
 * - live attempts: a worker is executing the turn right now. Stopping it needs
 *   a durable interruption the worker settles, so it is a separate commit.
 *
 * Stoppable work and other people's authority are acted on only with the
 * owner's one confirmation ("make private anyway").
 *
 * Everything here runs under the transaction's exclusive session-tenancy fence,
 * which excludes every ordinary session-activity writer in the workspace.
 */

const NONTERMINAL_TURN_STATUSES = [
  "queued",
  "running",
  "requires_action",
  "recovering",
  "waiting_capacity",
] as const;
const WORK_SESSION_STATUSES = new Set<string>(NONTERMINAL_TURN_STATUSES);

/** The cancellation reason shared with membership revocation. */
export const VISIBILITY_WORK_CANCEL_REASON = "authority_changed";

type SessionEventInsertWithPayload = typeof schema.sessionEvents.$inferInsert & {
  payload: unknown;
};

export type SessionVisibilityWork = {
  /** Responses running or parked mid-turn (approval, question, capacity, recovery). */
  runningTurnCount: number;
  /** Messages waiting behind the current response. */
  queuedTurnCount: number;
  activeGoal: boolean;
  /** A voice session is live in the chat. */
  liveVoice: boolean;
  /** Pending updates that carry another member's authority. */
  otherPeoplePendingUpdateCount: number;
  /** Subscription account choices for the chat that the owner cannot use. */
  otherPeopleAccountChoiceCount: number;
};

export type SessionVisibilityWorkInventory = {
  work: SessionVisibilityWork;
  liveAttempts: Array<{ id: string; turnId: string }>;
  pendingTurnIds: string[];
  leftoverTurnCount: number;
  sessionShowsWork: boolean;
};

export function sessionVisibilityWorkIsEmpty(work: SessionVisibilityWork): boolean {
  return (
    work.runningTurnCount === 0 &&
    work.queuedTurnCount === 0 &&
    !work.activeGoal &&
    !work.liveVoice &&
    work.otherPeoplePendingUpdateCount === 0 &&
    work.otherPeopleAccountChoiceCount === 0
  );
}

export const EMPTY_SESSION_VISIBILITY_WORK: SessionVisibilityWork = {
  runningTurnCount: 0,
  queuedTurnCount: 0,
  activeGoal: false,
  liveVoice: false,
  otherPeoplePendingUpdateCount: 0,
  otherPeopleAccountChoiceCount: 0,
};

/**
 * Read-only classification; callers that act on it must hold the tenancy
 * fence. The other-people counts come from an owner-only routine, so the
 * caller's RLS subject must be the session owner.
 */
export async function readSessionVisibilityWork(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; sessionStatus: string },
): Promise<SessionVisibilityWorkInventory> {
  const turns = await db
    .select({ id: schema.sessionTurns.id, status: schema.sessionTurns.status })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        inArray(schema.sessionTurns.status, [...NONTERMINAL_TURN_STATUSES]),
      ),
    )
    .orderBy(schema.sessionTurns.id);
  const liveAttempts = await db
    .select({ id: schema.sessionTurnAttempts.id, turnId: schema.sessionTurnAttempts.turnId })
    .from(schema.sessionTurnAttempts)
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
        eq(schema.sessionTurnAttempts.sessionId, input.sessionId),
        inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
      ),
    )
    .orderBy(schema.sessionTurnAttempts.id);
  const [goal] = await db
    .select({ status: schema.sessionGoals.status })
    .from(schema.sessionGoals)
    .where(
      and(
        eq(schema.sessionGoals.workspaceId, input.workspaceId),
        eq(schema.sessionGoals.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  const [voice] = await db
    .select({ id: schema.sessionRealtimeModes.id })
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.state, "active"),
        gt(schema.sessionRealtimeModes.leaseExpiresAt, new Date()),
      ),
    )
    .limit(1);
  const [others] = await rawRows<{ pendingUpdateCount: number; accountChoiceCount: number }>(
    db,
    sql`select pending_update_count as "pendingUpdateCount",
        account_choice_count as "accountChoiceCount"
      from session_visibility_foreign_authority_items(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid
      )`,
  );
  const liveTurnIds = new Set(liveAttempts.map((attempt) => attempt.turnId));
  const pending = turns.filter((turn) => !liveTurnIds.has(turn.id));
  const sessionShowsWork = WORK_SESSION_STATUSES.has(input.sessionStatus);
  const visiblePending = sessionShowsWork ? pending : [];
  return {
    work: {
      runningTurnCount:
        liveTurnIds.size + visiblePending.filter((turn) => turn.status !== "queued").length,
      queuedTurnCount: visiblePending.filter((turn) => turn.status === "queued").length,
      activeGoal: goal?.status === "active",
      liveVoice: voice !== undefined,
      otherPeoplePendingUpdateCount: Number(others?.pendingUpdateCount ?? 0),
      otherPeopleAccountChoiceCount: Number(others?.accountChoiceCount ?? 0),
    },
    liveAttempts,
    pendingTurnIds: pending.map((turn) => turn.id),
    leftoverTurnCount: sessionShowsWork ? 0 : pending.length,
    sessionShowsWork,
  };
}

export type SessionVisibilityWorkLock = {
  session: typeof schema.sessions.$inferSelect;
};

/**
 * Canonical prefix for a visibility change that may write session events. The
 * caller already holds the organization-membership and exclusive
 * session-tenancy advisory fences. The workspace row is taken FOR UPDATE here,
 * exactly as the visibility transition function takes it next, so the definer never
 * upgrades a weaker workspace lock while holding session rows.
 */
export async function lockSessionForVisibilityWork(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<SessionVisibilityWorkLock | null> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share");
  await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, input.workspaceId))
    .for("update");
  const [exists] = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    )
    .for("update");
  if (!exists) return null;
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    sessionIds: [input.sessionId],
  });
  const session = locks.sessions[0];
  return session ? { session } : null;
}

export type SessionVisibilityWorkSettlement = {
  eventIds: string[];
  cancelledTurnCount: number;
  pausedGoal: boolean;
  workflowWake: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
    wakeRevision: number;
  } | null;
};

/**
 * Cancel the exact non-live turns, optionally pause the active goal, retire
 * interruptions left on already closed attempts, and settle the public
 * projection. Live attempts are never touched here. Callers hold
 * {@link lockSessionForVisibilityWork}.
 */
export async function settleSessionVisibilityWorkInTransaction(
  db: SessionActivityDatabase,
  input: {
    session: typeof schema.sessions.$inferSelect;
    actorSubjectId: string;
    cancelTurnIds: string[];
    pauseGoal: boolean;
    /** The session still has a live attempt whose settlement owns the projection. */
    liveTurnId: string | null;
  },
): Promise<SessionVisibilityWorkSettlement> {
  const { session } = input;
  const workspaceId = session.workspaceId;
  const sessionId = session.id;
  const now = new Date();
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    sessionIds: [sessionId],
    turnIds: input.cancelTurnIds,
  });
  const locked = locks.sessions[0];
  if (!locked) throw new Error(`Session not found: ${sessionId}`);
  const turns = locks.turns.filter(
    (turn) =>
      turn.sessionId === sessionId &&
      (NONTERMINAL_TURN_STATUSES as readonly string[]).includes(turn.status),
  );
  const turnIds = turns.map((turn) => turn.id);
  let sequence = locked.lastSequence;
  const eventIds: string[] = [];
  const insertEvents = async (values: SessionEventInsertWithPayload[]) => {
    if (values.length === 0) return;
    const rows = await db
      .insert(schema.sessionEvents)
      .values(
        withLosslessContentWriteVersion(
          withBoundSessionEventPayloads(values),
          "payload",
          "payloadCodecVersion",
        ),
      )
      .returning({ id: schema.sessionEvents.id, sequence: schema.sessionEvents.sequence });
    eventIds.push(
      ...rows.sort((left, right) => left.sequence - right.sequence).map((row) => row.id),
    );
  };

  if (turnIds.length > 0) {
    await db
      .update(schema.sessionTurns)
      .set({
        status: "cancelled",
        activeAttemptId: null,
        cancelledBy: input.actorSubjectId,
        cancelReason: VISIBILITY_WORK_CANCEL_REASON,
        version: sql`${schema.sessionTurns.version} + 1`,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          inArray(schema.sessionTurns.id, turnIds),
        ),
      );
    const cancelledInputs = await db
      .update(schema.sessionHumanInputRequests)
      .set({
        status: "cancelled",
        response: { outcome: "cancelled" },
        respondedBy: input.actorSubjectId,
        respondedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sessionHumanInputRequests.workspaceId, workspaceId),
          inArray(schema.sessionHumanInputRequests.turnId, turnIds),
          eq(schema.sessionHumanInputRequests.status, "pending"),
        ),
      )
      .returning({
        id: schema.sessionHumanInputRequests.id,
        turnId: schema.sessionHumanInputRequests.turnId,
      });
    await deleteSubscriptionCoreWaitersForTurns(db, null, { workspaceId, turnIds });
    for (const turn of turns) {
      const association = turn.id === locked.activeTurnId ? ("current" as const) : null;
      await cancelTurnInteractionInterventionsInTransaction(db, {
        accountId: session.accountId,
        workspaceId,
        sessionId,
        turnId: turn.id,
      });
      const closedTools = await closePendingSessionToolCallsInTransaction(db, {
        accountId: session.accountId,
        workspaceId,
        sessionId,
        turnId: turn.id,
        reason: VISIBILITY_WORK_CANCEL_REASON,
        sequence,
        now,
        turnAssociation: association,
      });
      sequence = closedTools.sequence;
      eventIds.push(...closedTools.events.map((event) => event.id));
      const values: SessionEventInsertWithPayload[] = [];
      for (const request of cancelledInputs
        .filter((candidate) => candidate.turnId === turn.id)
        .sort((left, right) => left.id.localeCompare(right.id))) {
        values.push({
          accountId: session.accountId,
          workspaceId,
          sessionId,
          sequence: ++sequence,
          type: "user.humanInputResponse",
          turnId: turn.id,
          turnGeneration: turn.executionGeneration,
          ...(association ? { turnAssociation: association } : {}),
          payload: { requestId: request.id, response: { outcome: "cancelled" } },
          occurredAt: now,
        });
      }
      values.push({
        accountId: session.accountId,
        workspaceId,
        sessionId,
        sequence: ++sequence,
        type: "turn.cancelled",
        turnId: turn.id,
        turnGeneration: turn.executionGeneration,
        ...(association ? { turnAssociation: association } : {}),
        payload: { reason: VISIBILITY_WORK_CANCEL_REASON },
        occurredAt: now,
      });
      await insertEvents(values);
    }
  }

  // An interruption on an attempt that already closed can never be delivered;
  // the worker would mark it rejected_stale on its next look.
  await db
    .update(schema.sessionAttemptInterruptions)
    .set({ state: "rejected_stale", settledAt: now })
    .where(
      and(
        eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
        eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
        inArray(schema.sessionAttemptInterruptions.state, ["pending", "delivered", "acknowledged"]),
        sql`exists (
          select 1 from ${schema.sessionTurnAttempts} attempt
          where attempt.workspace_id = ${schema.sessionAttemptInterruptions.workspaceId}
            and attempt.id = ${schema.sessionAttemptInterruptions.attemptId}
            and attempt.state = 'closed'
        )`,
      ),
    );

  // A voice connection whose voice session already ended can never carry
  // audio again; close it with the chat's other leftovers.
  await db
    .update(schema.sessionRealtimeConnections)
    .set({ state: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.sessionRealtimeConnections.workspaceId, workspaceId),
        eq(schema.sessionRealtimeConnections.sessionId, sessionId),
        inArray(schema.sessionRealtimeConnections.state, ["negotiating", "ready", "active"]),
        sql`not exists (
          select 1 from ${schema.sessionRealtimeModes} mode
          where mode.workspace_id = ${schema.sessionRealtimeConnections.workspaceId}
            and mode.id = ${schema.sessionRealtimeConnections.realtimeId}
            and mode.state = 'active'
        )`,
      ),
    );

  let pausedGoal = false;
  if (input.pauseGoal) {
    const [goal] = await db
      .select()
      .from(schema.sessionGoals)
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          eq(schema.sessionGoals.sessionId, sessionId),
        ),
      )
      .for("update")
      .limit(1);
    if (goal?.status === "active") {
      // Identical to a person pausing the goal through the API.
      const [paused] = await db
        .update(schema.sessionGoals)
        .set({
          status: "paused",
          version: goal.version + 1,
          updatedAt: now,
          ...SESSION_GOAL_SUPPRESSION_CLEARED,
          rationale: null,
          pausedReason: "api",
          continuationObservedRevision: goal.continuationWakeRevision,
        })
        .where(eq(schema.sessionGoals.id, goal.id))
        .returning();
      if (paused) {
        pausedGoal = true;
        await insertEvents([
          {
            accountId: session.accountId,
            workspaceId,
            sessionId,
            sequence: ++sequence,
            type: "goal.paused",
            payload: {
              goalId: paused.id,
              actor: "api",
              reason: "api",
              autoContinuations: paused.autoContinuations,
              noProgressStreak: paused.noProgressStreak,
            },
            occurredAt: now,
          },
        ]);
      }
    }
  }

  // Settle the public projection unless a live attempt still owns it; that
  // attempt's interruption settlement recomputes it.
  const remainingQueued =
    input.liveTurnId === null
      ? []
      : await db
          .select({ position: schema.sessionTurns.position })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, workspaceId),
              eq(schema.sessionTurns.sessionId, sessionId),
              eq(schema.sessionTurns.status, "queued"),
            ),
          );
  // Only a projection this settlement invalidated moves to idle. A session
  // that merely reads `queued` (created, first turn not yet admitted) is left
  // to its workflow.
  const settleStatus =
    input.liveTurnId === null && turnIds.length > 0 && WORK_SESSION_STATUSES.has(locked.status);
  const clearActiveTurn =
    input.liveTurnId === null
      ? locked.activeTurnId !== null
      : locked.activeTurnId !== null && locked.activeTurnId !== input.liveTurnId;
  if (settleStatus) {
    await insertEvents([
      {
        accountId: session.accountId,
        workspaceId,
        sessionId,
        sequence: ++sequence,
        type: "session.status.changed",
        payload: { status: "idle", reason: VISIBILITY_WORK_CANCEL_REASON },
        occurredAt: now,
      },
    ]);
  }
  const changedProjection = settleStatus || clearActiveTurn || turnIds.length > 0;
  if (changedProjection || sequence !== locked.lastSequence) {
    const positions = remainingQueued.map((turn) => Number(turn.position));
    await db
      .update(schema.sessions)
      .set({
        ...(settleStatus ? { status: "idle" } : {}),
        ...(clearActiveTurn ? { activeTurnId: input.liveTurnId } : {}),
        ...(turnIds.length > 0
          ? {
              queueVersion: sql`${schema.sessions.queueVersion} + 1`,
              queueHeadPosition: positions.length > 0 ? Math.min(...positions) : 0,
              queueTailPosition: positions.length > 0 ? Math.max(...positions) : 0,
            }
          : {}),
        lastSequence: sequence,
        updatedAt: now,
      })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  }

  let workflowWake: SessionVisibilityWorkSettlement["workflowWake"] = null;
  if (turnIds.length > 0 || pausedGoal) {
    // A workflow parked on a capacity, approval or dispatch boundary re-reads
    // the terminal turns and exits instead of waiting forever.
    const temporalWorkflowId = session.temporalWorkflowId ?? `session-${sessionId}`;
    const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
      accountId: session.accountId,
      workspaceId,
      sessionId,
      temporalWorkflowId,
      reason: "session_visibility_work_settled",
      controlRequested: true,
    });
    workflowWake = {
      accountId: session.accountId,
      workspaceId,
      sessionId,
      temporalWorkflowId,
      wakeRevision,
    };
  }
  return { eventIds, cancelledTurnCount: turnIds.length, pausedGoal, workflowWake };
}

/**
 * Request a terminal stop of each live attempt. The interruption kind
 * `authority_change` makes the worker cancel the turn (not pause it) when it
 * settles, exactly like a revoked membership. The receipt row is the
 * interruption's operation identity.
 */
export async function interruptSessionAttemptsForVisibilityChangeInTransaction(
  db: Database,
  input: {
    session: typeof schema.sessions.$inferSelect;
    actorSubjectId: string;
    operationKey: string;
    attemptIds: string[];
  },
): Promise<number> {
  if (input.attemptIds.length === 0) return 0;
  const { session } = input;
  await db
    .insert(schema.sessionCommandReceipts)
    .values({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      actorType: "human",
      actorSubjectId: input.actorSubjectId,
      action: "session.visibility.stop_work",
      targetSessionId: session.id,
      operationKey: input.operationKey,
      canonicalRequestHash: createHash("sha256")
        .update(JSON.stringify({ version: 1, sessionId: session.id, action: "stop_work" }))
        .digest("hex"),
      result: { status: "applied" },
    })
    .onConflictDoNothing();
  const [receipt] = await db
    .select({ id: schema.sessionCommandReceipts.id })
    .from(schema.sessionCommandReceipts)
    .where(
      and(
        eq(schema.sessionCommandReceipts.workspaceId, session.workspaceId),
        eq(schema.sessionCommandReceipts.actorType, "human"),
        eq(schema.sessionCommandReceipts.actorSubjectId, input.actorSubjectId),
        eq(schema.sessionCommandReceipts.action, "session.visibility.stop_work"),
        eq(schema.sessionCommandReceipts.targetSessionId, session.id),
        eq(schema.sessionCommandReceipts.operationKey, input.operationKey),
      ),
    )
    .limit(1);
  if (!receipt) throw new Error("Session visibility stop receipt was not recorded");
  const inserted = await db
    .insert(schema.sessionAttemptInterruptions)
    .values(
      input.attemptIds.map((attemptId) => ({
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        operationId: receipt.id,
        attemptId,
        kind: "authority_change",
        controlRevision: session.authorityEpoch,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.sessionAttemptInterruptions.id });
  return inserted.length;
}
