import type { Settings } from "@opengeni/config";
import type { Session, SessionGoal } from "@opengeni/contracts";
import {
  getSession,
  getSessionGoal,
  addSessionSystemUpdate,
  type Database,
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

/**
 * Deliver exactly one completion wake to a spawned worker's parent (manager)
 * session when the worker reaches a terminal-for-now state. No-op for a
 * parentless session (direct API create / scheduled run). Idempotent per
 * terminal episode: the idempotency key is the child's current lastSequence,
 * which advances every time the child does work, so a retry of the same
 * terminal transition (activity retry, the workflow's idle re-check, the
 * runAgentTurn-failed path overlapping a workflow-level wake) is deduped while
 * a genuinely new idle-after-work episode notifies again. The parent's queued
 * turn is delivered by the DB wake; signalling the parent's workflow
 * (signalWithStart) ensures a parent whose workflow already completed gets a
 * fresh run to claim it. Failures here never fail the child: the wake is a
 * best-effort nudge layered on durable DB state.
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
  // child session, but must not manufacture parent chat input/turn work. Keep
  // this check before every DB read, event publish, and workflow signal so the
  // disabled path cannot mutate or wake the parent.
  if (!svc.settings.childCompletionParentWakeEnabled) {
    return;
  }
  try {
    const child = await getSession(svc.db, workspaceId, childSessionId);
    if (!child || !child.parentSessionId) {
      return;
    }
    const goal = await getSessionGoal(svc.db, workspaceId, childSessionId);
    // Sacred user pause: if the MANAGER's own goal was stopped by the user, the
    // wake must not tell it to "resume it now" — that instruction is exactly
    // what re-arms the loop the user just stopped. Suppress the resume nudge and
    // tell the agent to stay stopped. Paired with the goal_set reactivation
    // guard so a nudge that slips through still cannot revive the goal.
    const clientEventId = `child-completion:${childSessionId}:${episodeKey ?? child.lastSequence}`;
    const payload = childCompletionPayload(child, goal, terminalStatus);
    const result = await addSessionSystemUpdate(svc.db, {
      accountId: child.accountId,
      workspaceId,
      sessionId: child.parentSessionId,
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
      reasoningEffortFallback: svc.settings.openaiReasoningEffort,
    });
    if (!result.added) {
      return;
    }
    await svc.bus.publish(workspaceId, child.parentSessionId, result.events);
    if (result.shouldWake && svc.wakeSessionWorkflow) {
      await svc.wakeSessionWorkflow({
        accountId: child.accountId,
        workspaceId,
        sessionId: child.parentSessionId,
        workflowId: result.temporalWorkflowId,
      });
    }
    svc.observability.info("Woke parent session on worker completion", {
      childSessionId,
      parentSessionId: child.parentSessionId,
      terminalStatus,
    });
  } catch (error) {
    // A parent-wake failure must never fail the child's terminal activity.
    svc.observability.error("Failed to wake parent session on worker completion", {
      childSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
 * completions can be coalesced into ONE digest turn: the DB layer stores each
 * child's summary and rebuilds a single numbered digest with ONE shared
 * trailing instruction, instead of enqueuing N turns (N model runs) that a
 * human's stop button can never outrun.
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
 * wake. Suppresses the "resume it now" nudge when the manager's own goal was
 * stopped by the user — that nudge is exactly what re-arms the loop the user
 * just stopped (paired with the goal_set reactivation guard).
 */
export function childCompletionTrailing(parentGoalUserPaused: boolean): string {
  return parentGoalUserPaused
    ? "Read each worker's session events/notebook output for its result. This session was paused by the user — do NOT resume or replace your goal; summarize the result for the user and stop."
    : "Read each worker's session events/notebook output for its result, then continue. If your own goal was paused awaiting these workers, resume it now.";
}
