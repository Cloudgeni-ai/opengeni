import type { Settings } from "@opengeni/config";
import type { Session, SessionGoal } from "@opengeni/contracts";
import {
  getSession,
  getSessionGoal,
  addSessionSystemUpdateWithSourceMutation,
  claimPendingSessionSystemUpdateOutbox,
  claimPendingSessionWorkflowWakes,
  getOrCreateSessionSystemUpdateOutbox,
  markSessionWorkflowWakeFailed,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  markSessionSystemUpdateOutboxFailed,
  type Database,
  type SessionSystemUpdateOutboxDelivery,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { ActivityServices, WakeSessionWorkflowSignal } from "./types";

export type NotifyServices = {
  db: Database;
  bus: EventBus;
  settings: Settings;
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
};

export type ReconcileParentSystemUpdateOverrides = Partial<{
  claimPendingSessionSystemUpdateOutbox: typeof claimPendingSessionSystemUpdateOutbox;
}>;

export type ReconcileSessionWorkflowWakeOverrides = Partial<{
  claimPendingSessionWorkflowWakes: typeof claimPendingSessionWorkflowWakes;
}>;

/**
 * Deliver exactly one completion wake to a spawned worker's parent (manager)
 * session when the worker reaches a terminal-for-now state. No-op for a
 * parentless session (direct API create / scheduled run). Idempotent per
 * terminal episode: the idempotency key is the child's current lastSequence,
 * which advances every time the child does work, so a retry of the same
 * terminal transition (activity retry, the workflow's idle re-check, the
 * runAgentTurn-failed path overlapping a workflow-level wake) is deduped while
 * a genuinely new idle-after-work episode notifies again. The parent receives
 * one typed internal update; signalling its workflow ensures an idle parent can
 * coalesce and process all pending updates in one inference. Failures here never
 * fail the child because the durable outbox remains retryable.
 *
 * Lives in its own module so both the session-state terminal activities
 * (markSessionIdle / failSession) and runAgentTurn's in-turn failure path can
 * call it without a circular import between those two activity modules.
 */
export async function notifyParentOfChildTerminal(
  svc: NotifyServices,
  workspaceId: string,
  childSessionId: string,
  terminalStatus: "idle" | "failed",
  // Stable identifier for the terminal episode, used as the idempotency key so
  // the same completion never wakes the parent twice. A FAILURE passes the
  // failed turn's id: both the in-turn wake (runAgentTurn) and the
  // workflow-level wake (failSession, after it appends more events that would
  // shift lastSequence) key on the same turn, so a finally-throw that turns one
  // failure into both paths still dedupes. An idle episode has no single
  // owning turn, so it falls back to the child's lastSequence — which advances
  // per work batch and is stable across retries of that same idle transition.
  episodeKey?: string | null,
): Promise<void> {
  // Temporarily disabled by default: child completion remains durable on the
  // child session, but must not manufacture parent system-update/inference
  // work. Keep this before every DB read, event publish, and workflow signal so
  // the disabled path cannot mutate or wake the parent.
  if (!svc.settings.childCompletionParentWakeEnabled) {
    return;
  }
  try {
    const child = await getSession(svc.db, workspaceId, childSessionId);
    if (!child || !child.parentSessionId) {
      return;
    }
    const goal = await getSessionGoal(svc.db, workspaceId, childSessionId);
    // Sacred user pause: if the MANAGER's own goal was paused by the user, the
    // wake must not tell it to "resume it now" — that instruction is exactly
    // what re-arms the loop the user just stopped. Suppress the resume nudge and
    // tell the agent to stay paused. Paired with the goal_set reactivation
    // guard so a nudge that slips through still cannot revive the goal.
    const clientEventId = `child-completion:${childSessionId}:${episodeKey ?? child.lastSequence}`;
    const payload = childCompletionPayload(child, goal, terminalStatus);
    const outbox = await getOrCreateSessionSystemUpdateOutbox(svc.db, {
      accountId: child.accountId,
      workspaceId,
      sourceSessionId: child.id,
      targetSessionId: child.parentSessionId,
      kind: "child_session_update",
      classification:
        terminalStatus === "failed"
          ? "failure"
          : goal?.status === "paused"
            ? "action_required"
            : "success",
      sourceId: child.id,
      dedupeKey: clientEventId,
      summary: childCompletionSummary(child, goal, terminalStatus),
      payload,
      lineage: { childSessionId: child.id, parentSessionId: child.parentSessionId },
    });
    if (outbox.status === "delivered") {
      return;
    }
    await deliverParentSystemUpdateOutbox(svc, outbox);
  } catch (error) {
    // A durable pending outbox row survives this boundary. The global worker
    // reaper retries it; child terminal settlement never depends on this turn.
    svc.observability.error("Failed to wake parent session on worker completion", {
      childSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function deliverParentSystemUpdateOutbox(
  svc: NotifyServices,
  outbox: SessionSystemUpdateOutboxDelivery,
): Promise<void> {
  try {
    const result = await addSessionSystemUpdateWithSourceMutation(
      svc.db,
      {
        accountId: outbox.accountId,
        workspaceId: outbox.workspaceId,
        sessionId: outbox.targetSessionId,
        kind: outbox.kind,
        classification: outbox.classification,
        sourceId: outbox.sourceId,
        dedupeKey: outbox.dedupeKey,
        summary: outbox.summary,
        payload: outbox.payload,
        lineage: outbox.lineage,
      },
      async (tx) => {
        await markSessionSystemUpdateOutboxDeliveredInTransaction(tx, outbox);
      },
    );
    if (result.reason === "session_cancelled") {
      return;
    }
    if (result.added && result.events.length > 0) {
      await svc.bus.publish(outbox.workspaceId, outbox.targetSessionId, result.events);
    }
    if (result.shouldWake && svc.wakeSessionWorkflow) {
      if (result.workflowWakeRevision === null) {
        throw new Error("Runnable system update has no workflow wake revision");
      }
      await svc.wakeSessionWorkflow({
        accountId: outbox.accountId,
        workspaceId: outbox.workspaceId,
        sessionId: outbox.targetSessionId,
        workflowId: result.temporalWorkflowId ?? `session-${outbox.targetSessionId}`,
        wakeRevision: result.workflowWakeRevision,
      });
    }
    svc.observability.info("Woke parent session on worker completion", {
      childSessionId: outbox.sourceSessionId,
      parentSessionId: outbox.targetSessionId,
      dedupeKey: outbox.dedupeKey,
    });
  } catch (error) {
    await markSessionSystemUpdateOutboxFailed(
      svc.db,
      outbox,
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  }
}

export async function reconcilePendingParentSystemUpdates(
  svc: NotifyServices,
  limit = 100,
  overrides: ReconcileParentSystemUpdateOverrides = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimPendingSessionSystemUpdateOutboxFn =
    overrides.claimPendingSessionSystemUpdateOutbox ?? claimPendingSessionSystemUpdateOutbox;
  // Do not claim or deliver the child-terminal outbox while completion wakes
  // are disabled. Atomic terminal producers use the same setting, so no new
  // backlog is manufactured either. Session-workflow wake repair is owned by
  // its dedicated dispatcher and never depends on sandbox or child settings.
  if (!svc.settings.childCompletionParentWakeEnabled) {
    return { claimed: 0, delivered: 0, failed: 0 };
  }
  const rows = await claimPendingSessionSystemUpdateOutboxFn(svc.db, limit);
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deliverParentSystemUpdateOutbox(svc, row);
      delivered += 1;
    } catch {
      failed += 1;
    }
  }
  return { claimed: rows.length, delivered, failed };
}

export async function reconcilePendingSessionWorkflowWakes(
  svc: NotifyServices,
  limit = 1_000,
  overrides: ReconcileSessionWorkflowWakeOverrides = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimPendingSessionWorkflowWakesFn =
    overrides.claimPendingSessionWorkflowWakes ?? claimPendingSessionWorkflowWakes;
  if (!svc.wakeSessionWorkflow) {
    return { claimed: 0, delivered: 0, failed: 0 };
  }
  const repairs = await claimPendingSessionWorkflowWakesFn(svc.db, limit);
  let delivered = 0;
  let failed = 0;
  const queue = [...repairs];
  const workers = Array.from({ length: Math.min(20, queue.length) }, async () => {
    for (;;) {
      const repair = queue.shift();
      if (!repair) return;
      try {
        await svc.wakeSessionWorkflow!({
          accountId: repair.accountId,
          workspaceId: repair.workspaceId,
          sessionId: repair.sessionId,
          workflowId: repair.temporalWorkflowId,
          wakeRevision: repair.wakeRevision,
          ...(repair.controlEventId ? { controlEventId: repair.controlEventId } : {}),
        });
        delivered += 1;
      } catch (error) {
        failed += 1;
        await markSessionWorkflowWakeFailed(
          svc.db,
          repair,
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      }
    }
  });
  await Promise.all(workers);
  return { claimed: repairs.length, delivered, failed };
}

function childCompletionPayload(
  child: Session,
  goal: SessionGoal | null,
  terminalStatus: "idle" | "failed",
): Record<string, unknown> {
  return {
    childSessionId: child.id,
    status: terminalStatus,
    ...(goal
      ? {
          goal: {
            status: goal.status,
            text: goal.text,
            ...(goal.evidence ? { evidence: goal.evidence } : {}),
            ...(goal.rationale ? { rationale: goal.rationale } : {}),
            ...(goal.pausedReason ? { pausedReason: goal.pausedReason } : {}),
          },
        }
      : {}),
  };
}

/**
 * The worker-specific lines for one child (what happened + its goal), WITHOUT
 * the trailing "what to do next" instruction. Kept separate so N child
 * completions can be coalesced into one internal-update inference: the DB layer
 * stores each child's summary and rebuilds a single numbered digest with one
 * shared trailing instruction instead of running N model calls.
 */
export function childCompletionSummary(
  child: Session,
  goal: SessionGoal | null,
  terminalStatus: "idle" | "failed",
): string {
  const lines: string[] = [];
  if (terminalStatus === "failed") {
    lines.push(`A worker session you spawned has FAILED. Worker session id: ${child.id}.`);
  } else if (goal?.status === "completed") {
    lines.push(
      `A worker session you spawned has COMPLETED its goal. Worker session id: ${child.id}.`,
    );
  } else if (goal?.status === "paused") {
    lines.push(
      `A worker session you spawned has PAUSED its goal and gone idle. Worker session id: ${child.id}.`,
    );
  } else {
    lines.push(
      `A worker session you spawned has finished its work and gone idle. Worker session id: ${child.id}.`,
    );
  }
  if (goal) {
    lines.push(`Worker goal: ${goal.text}`);
    if (goal.status === "completed" && goal.evidence) {
      lines.push(`Completion evidence: ${goal.evidence}`);
    }
    if (goal.status === "paused" && goal.rationale) {
      lines.push(`Pause rationale: ${goal.rationale}`);
    }
  }
  return lines.join("\n");
}

/**
 * The single trailing instruction appended to a child-completion (or digest)
 * inference. Suppresses the "resume it now" nudge when the manager's own goal
 * was paused by the user (paired with the goal_set reactivation guard).
 */
export function childCompletionTrailing(parentGoalUserPaused: boolean): string {
  return parentGoalUserPaused
    ? "Read each worker's session events/notebook output for its result. This session was paused by the user — do NOT resume or replace your goal; summarize the result for the user and remain paused."
    : "Read each worker's session events/notebook output for its result, then continue. If your own goal was paused awaiting these workers, resume it now.";
}
