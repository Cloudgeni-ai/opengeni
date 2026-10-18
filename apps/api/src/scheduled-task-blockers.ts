import {
  NOTIFICATION_SUBTITLE_MAX_CHARS,
  SessionNotificationPostedPayload,
  SessionNotificationWithdrawnPayload,
} from "@opengeni/contracts";
import {
  getPendingScheduledTaskBlockerNotice,
  listScheduledTaskBlockerReviews,
  reviewScheduledTaskBlockers,
  settleScheduledTaskBlockerNotice,
  type Database,
  type ScheduledTaskBlockerDecision,
  type ScheduledTaskBlockerFacts,
  type ScheduledTaskBlockerRun,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

/**
 * A schedule must never stay stuck without its owner knowing. After each
 * settled scheduled run:
 *
 * - When the platform knows no later run can start until a person acts (its
 *   chat is paused or gone, a pinned account or other resource it needs is
 *   unavailable, or it was refused as non-retryable), the schedule pauses
 *   itself with that reason and its owner is told once.
 * - When runs keep failing or being skipped for a reason that may clear by
 *   itself, the owner is told once, after {@link SCHEDULED_TASK_BLOCKER_STREAK}
 *   in a row; the schedule keeps running. A single skip or failure is normal.
 *
 * The notice is withdrawn when a later run succeeds or a person resumes,
 * pauses or deletes the schedule. Only scheduled (not manual) runs count, and
 * only runs since the schedule was last edited or resumed.
 */
export const SCHEDULED_TASK_BLOCKER_STREAK = 3;

const SETTLED = new Set(["succeeded", "failed", "skipped"]);

type Blocker = { reason: string; text: string };

const RESUME = "then resume the schedule.";

const NON_RETRYABLE_REFUSAL_TEXT: Record<string, string> = {
  scheduled_authority_unavailable: `The access it was set up with is no longer valid. Refresh the schedule's access, ${RESUME}`,
  machine_target_unavailable: `The machine it runs on is no longer available. Choose another machine or reconnect this one, ${RESUME}`,
  machine_enrollment_inactive: `The machine it runs on is disconnected from Opengeni. Reconnect the machine, ${RESUME}`,
  variable_set_unavailable: `A variable set it uses no longer exists or can't be used. Edit the schedule, ${RESUME}`,
  rig_version_unavailable: `Its rig has no usable version. Publish a rig version or edit the schedule, ${RESUME}`,
  scheduled_model_unavailable: `Its model is no longer available. Edit the schedule to choose another model, ${RESUME}`,
};

const RETRYABLE_REFUSAL_TEXT: Record<string, string> = {
  machine_enrollment_inactive: "the machine it runs on is disconnected",
  insufficient_credits: "the workspace is out of credits",
  allowance_exhausted: "the usage allowance is used up",
  monthly_model_cost_limit: "the monthly model cost limit was reached",
  monthly_agent_run_limit: "the monthly run limit was reached",
  session_usage_limit: "the schedule reached its usage limit",
};

/** A blocker no later run can get past until a person acts, or null. */
export function scheduledRunHardBlocker(
  task: Pick<ScheduledTaskBlockerFacts["task"], "runMode">,
  run: ScheduledTaskBlockerRun,
): Blocker | null {
  if (run.admissionDiagnostic) {
    return {
      reason: "connection_account_unavailable",
      text: `A connected account it needs can no longer be used. Reconnect that account or refresh the schedule's access, ${RESUME}`,
    };
  }
  if (run.admissionRefusal && !run.admissionRefusal.retryable) {
    const reason = run.admissionRefusal.reason;
    return {
      reason,
      text:
        NON_RETRYABLE_REFUSAL_TEXT[reason] ??
        `Every run is refused before it starts (${reason}). Fix that, ${RESUME}`,
    };
  }
  switch (run.error) {
    case "scheduled_session_paused":
      return {
        reason: run.error,
        text: `Its chat is paused, so no run can start there. Resume the chat, ${RESUME}`,
      };
    case "session_cancelled":
      // A run that starts a new chat each time is not blocked by one ended chat.
      return task.runMode === "new_session_per_run"
        ? null
        : {
            reason: run.error,
            text: `The chat it runs in has ended, so no run can start there. Point the schedule at another chat or let it start a new chat each run, ${RESUME}`,
          };
    case "scheduled_target_session_unavailable":
      return {
        reason: run.error,
        text: `The chat it runs in no longer exists. Point the schedule at another chat or let it start a new chat each run, ${RESUME}`,
      };
    case "scheduled_model_unavailable":
      return { reason: run.error, text: NON_RETRYABLE_REFUSAL_TEXT.scheduled_model_unavailable! };
    default:
      return null;
  }
}

function streakBlocker(streak: readonly ScheduledTaskBlockerRun[]): Blocker {
  const count = streak.length;
  if (streak.every((run) => run.error === "scheduled_session_not_idle")) {
    return {
      reason: "scheduled_session_not_idle",
      text: `The last ${count} scheduled runs were skipped because its chat was still busy with earlier work. Check whether that chat is stuck. The schedule keeps trying.`,
    };
  }
  const refusal = streak[0]?.admissionRefusal;
  if (
    refusal?.retryable &&
    streak.every(
      (run) => run.admissionRefusal?.retryable && run.admissionRefusal.reason === refusal.reason,
    )
  ) {
    return {
      reason: refusal.reason,
      text: `The last ${count} scheduled runs were skipped because ${
        RETRYABLE_REFUSAL_TEXT[refusal.reason] ?? `they were refused (${refusal.reason})`
      }. Runs start again once that clears.`,
    };
  }
  const latest = streak[0]!;
  return {
    reason: latest.error ?? latest.status,
    text: `The last ${count} scheduled runs failed or were skipped. Open the latest run to see why. The schedule keeps trying.`,
  };
}

export function scheduledTaskBlockerNoticeKey(taskId: string): string {
  return `schedule-${taskId}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function notice(
  facts: ScheduledTaskBlockerFacts,
  run: ScheduledTaskBlockerRun,
  state: "notified" | "paused",
  blocker: Blocker,
): Extract<ScheduledTaskBlockerDecision, { kind: "block" }>["notice"] {
  // The chat the owner opens from the notice: the blocked run's own, else the
  // chat the schedule runs in, else the most recent run's.
  const sessionId =
    run.sessionId ??
    facts.task.reusableSessionId ??
    facts.runs.find((candidate) => candidate.sessionId !== null)?.sessionId ??
    null;
  if (!sessionId) return null;
  const key = scheduledTaskBlockerNoticeKey(facts.task.id);
  const payload = SessionNotificationPostedPayload.parse({
    key,
    title: state === "paused" ? "Schedule paused itself" : "Schedule needs attention",
    subtitle: clip(facts.task.name.trim() || "Scheduled task", NOTIFICATION_SUBTITLE_MAX_CHARS),
    body:
      state === "paused"
        ? `${blocker.text} It stays paused until someone resumes it.`
        : blocker.text,
    urgency: "normal",
    replaced: false,
  });
  return { sessionId, key, payload };
}

/** The pure review of one schedule's newest settled scheduled run. */
export function decideScheduledTaskBlocker(
  facts: ScheduledTaskBlockerFacts,
): ScheduledTaskBlockerDecision {
  const { task, review, runs } = facts;
  const blocked = review !== null && review.state !== "clear";
  // A person acted: resumed a self-paused schedule, or paused or deleted one
  // they were told about. Keep the reviewed run; a new one is reviewed next.
  if (task.deleted) return blocked ? { kind: "clear", reviewedRunId: null } : none(null);
  if (review?.state === "paused" && task.status === "active") {
    return { kind: "clear", reviewedRunId: null };
  }
  if (review?.state === "notified" && task.status !== "active") {
    return { kind: "clear", reviewedRunId: null };
  }
  if (task.status !== "active") return none(null);
  const latest = runs[0];
  if (!latest || !SETTLED.has(latest.status) || latest.id === review?.reviewedRunId) {
    return none(null);
  }
  if (latest.status === "succeeded") {
    return review?.state === "notified"
      ? { kind: "clear", reviewedRunId: latest.id }
      : none(latest.id);
  }
  // Runs before the last edit or resume say nothing about the schedule now.
  const current = (run: ScheduledTaskBlockerRun) => run.createdAt >= task.updatedAt;
  const hard = current(latest) ? scheduledRunHardBlocker(task, latest) : null;
  if (hard) {
    return {
      kind: "block",
      state: "paused",
      reason: hard.reason,
      message: hard.text,
      blockedRunId: latest.id,
      blockedSince: latest.createdAt,
      reviewedRunId: latest.id,
      notice: notice(facts, latest, "paused", hard),
    };
  }
  if (review?.state === "notified") return none(latest.id);
  const streak: ScheduledTaskBlockerRun[] = [];
  for (const run of runs) {
    if (!SETTLED.has(run.status) || run.status === "succeeded" || !current(run)) break;
    streak.push(run);
  }
  if (streak.length < SCHEDULED_TASK_BLOCKER_STREAK) return none(latest.id);
  const soft = streakBlocker(streak);
  const first = streak.at(-1)!;
  return {
    kind: "block",
    state: "notified",
    reason: soft.reason,
    message: soft.text,
    blockedRunId: first.id,
    blockedSince: first.createdAt,
    reviewedRunId: latest.id,
    notice: notice(facts, latest, "notified", soft),
  };
}

function none(reviewedRunId: string | null): ScheduledTaskBlockerDecision {
  return { kind: "none", reviewedRunId };
}

type Dependencies = {
  db: Database;
  bus: EventBus;
  observability?: Pick<Observability, "error"> | undefined;
};

function sessionMissing(error: unknown): boolean {
  return error instanceof Error && /^Session not found: /u.test(error.message);
}

/** Post or withdraw the owner notice a review left pending. */
export async function deliverScheduledTaskBlockerNotice(
  deps: Dependencies,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  const pending = await getPendingScheduledTaskBlockerNotice(deps.db, workspaceId, taskId);
  if (!pending) return;
  try {
    await appendAndPublishEvents(deps.db, deps.bus, workspaceId, pending.sessionId, [
      pending.pending === "post"
        ? {
            type: "session.notification.posted",
            payload: SessionNotificationPostedPayload.parse(pending.payload),
          }
        : {
            type: "session.notification.withdrawn",
            payload: SessionNotificationWithdrawnPayload.parse({ key: pending.key }),
          },
    ] as Parameters<typeof appendAndPublishEvents>[4]);
  } catch (error) {
    // A deleted chat cannot carry the notice; the schedule page still shows why.
    if (!sessionMissing(error)) throw error;
  }
  await settleScheduledTaskBlockerNotice(deps.db, workspaceId, taskId, pending);
}

/** One bounded pass over schedules with a run to review or a notice to deliver. */
export async function reviewScheduledTaskBlockerInventory(deps: Dependencies): Promise<void> {
  for (const candidate of await listScheduledTaskBlockerReviews(deps.db)) {
    try {
      await reviewScheduledTaskBlockers(
        deps.db,
        candidate.workspace_id,
        candidate.id,
        decideScheduledTaskBlocker,
      );
      await deliverScheduledTaskBlockerNotice(deps, candidate.workspace_id, candidate.id);
    } catch (error) {
      deps.observability?.error("Scheduled task blocker review will retry", {
        taskId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
