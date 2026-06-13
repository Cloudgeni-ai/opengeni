import type { Settings } from "@opengeni/config";
import type { Session, SessionGoal } from "@opengeni/contracts";
import { getSession, getSessionGoal, wakeParentSessionForChildCompletion, type Database } from "@opengeni/db";
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
): Promise<void> {
  try {
    const child = await getSession(svc.db, workspaceId, childSessionId);
    if (!child || !child.parentSessionId) {
      return;
    }
    const goal = await getSessionGoal(svc.db, workspaceId, childSessionId);
    // lastSequence after the terminal transition's events is the episode key.
    const clientEventId = `child-completion:${childSessionId}:${child.lastSequence}`;
    const result = await wakeParentSessionForChildCompletion(svc.db, {
      workspaceId,
      parentSessionId: child.parentSessionId,
      clientEventId,
      text: childCompletionWakeText(child, goal, terminalStatus),
      childCompletion: childCompletionPayload(child, goal, terminalStatus),
      reasoningEffortFallback: svc.settings.openaiReasoningEffort,
    });
    if (!result.delivered) {
      return;
    }
    await svc.bus.publish(workspaceId, child.parentSessionId, result.events);
    if (svc.wakeSessionWorkflow) {
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

function childCompletionPayload(child: Session, goal: SessionGoal | null, terminalStatus: "idle" | "failed"): Record<string, unknown> {
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

function childCompletionWakeText(child: Session, goal: SessionGoal | null, terminalStatus: "idle" | "failed"): string {
  const lines: string[] = [];
  if (terminalStatus === "failed") {
    lines.push(`A worker session you spawned has FAILED. Worker session id: ${child.id}.`);
  } else if (goal?.status === "completed") {
    lines.push(`A worker session you spawned has COMPLETED its goal. Worker session id: ${child.id}.`);
  } else if (goal?.status === "paused") {
    lines.push(`A worker session you spawned has PAUSED its goal and gone idle. Worker session id: ${child.id}.`);
  } else {
    lines.push(`A worker session you spawned has finished its work and gone idle. Worker session id: ${child.id}.`);
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
  lines.push("Read the worker's session events/notebook output for its result, then continue. If your own goal was paused awaiting this worker, resume it now.");
  return lines.join("\n");
}
