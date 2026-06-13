import { ActivityFailure, CancellationScope, condition, defineSignal, isCancellation, patched, setHandler, TimeoutFailure, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { activity, workflowFailureMessage } from "./activities";

/**
 * True when an agent-turn activity failure means "the worker hosting the
 * turn died or vanished" rather than "the turn itself failed": the server
 * closed the activity with a HEARTBEAT timeout (the worker was killed before
 * the graceful-preempt checkpoint could run — SIGKILL, OOM, node loss, or a
 * rollout whose grace period expired) or a SCHEDULE_TO_START timeout (no
 * worker ever picked the task up). Detection uses the SDK's typed failure
 * classes, not message-string matching: the failure converter rehydrates
 * ActivityFailure/TimeoutFailure instances deterministically from recorded
 * history on replay, so instanceof + timeoutType checks are replay-safe and
 * do not depend on server-controlled message text. START_TO_CLOSE /
 * SCHEDULE_TO_CLOSE timeouts are deliberately excluded: with the 30-day
 * startToClose they mean the turn truly overran, which stays a real failure.
 */
function isWorkerDeathFailure(error: unknown): boolean {
  if (!(error instanceof ActivityFailure)) {
    return false;
  }
  const cause = error.cause;
  return cause instanceof TimeoutFailure
    && (cause.timeoutType === "HEARTBEAT" || cause.timeoutType === "SCHEDULE_TO_START");
}

export const userMessage = defineSignal<[string]>("userMessage");
export const queueChanged = defineSignal("queueChanged");
export const approvalDecision = defineSignal<[string]>("approvalDecision");
export const interrupt = defineSignal<[string]>("interrupt");

export type SessionWorkflowInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  initialEventId?: string;
};

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  const approvalQueue: string[] = [];
  let interruptedEventId: string | null = null;
  let wakeups = 0;

  setHandler(userMessage, () => {
    wakeups += 1;
  });
  setHandler(queueChanged, () => {
    wakeups += 1;
  });
  setHandler(approvalDecision, (eventId) => {
    approvalQueue.push(eventId);
  });
  setHandler(interrupt, (eventId) => {
    interruptedEventId = eventId;
  });

  while (true) {
    const workflowId = workflowInfo().workflowId;
    const turn = await activity.claimNextQueuedTurn({ workspaceId: input.workspaceId, sessionId: input.sessionId, workflowId });
    if (!turn) {
      if (interruptedEventId === null) {
        // With an active goal, idling out is replaced by a synthesized
        // continuation turn; the queue (any non-terminal turn) always wins and
        // the no-progress/max-continuation guards auto-pause runaway goals.
        let continuation: activities.MaybeContinueGoalResult = { action: "none" };
        try {
          continuation = await activity.maybeContinueGoal({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            workflowId,
          });
        } catch (error) {
          if (isCancellation(error)) {
            throw error;
          }
          // A failing goal check must not kill the session (activity retry is
          // 1). Fall through to the idle path: the goal stays active in the
          // database and the next wake retries, which means the workflow CAN
          // complete normally with an active goal on this error path.
        }
        if (continuation.action === "continue" || continuation.action === "queue") {
          // "continue": a goal continuation turn was just enqueued; "queue":
          // queued work appeared concurrently. Claim it on the next loop pass.
          continue;
        }
      }
      const seenWakeups = wakeups;
      const woke = await condition(() => interruptedEventId !== null || wakeups !== seenWakeups, "5s");
      if (interruptedEventId) {
        const idleInterruptEventId = interruptedEventId;
        interruptedEventId = null;
        // An idle interrupt is an explicit stop: pause an active goal before
        // shutting down so a later wake does not auto-continue it. The
        // activity inspects the trigger and skips the pause for steer-tagged
        // interrupts (steering redirects work, it does not stop it).
        await activity.pauseGoalForInterrupt({ workspaceId: input.workspaceId, sessionId: input.sessionId, triggerEventId: idleInterruptEventId });
        await activity.markSessionIdle({ workspaceId: input.workspaceId, sessionId: input.sessionId });
        return;
      }
      if (woke) {
        continue;
      }
      const finalTurn = await activity.claimNextQueuedTurn({ workspaceId: input.workspaceId, sessionId: input.sessionId, workflowId });
      if (!finalTurn) {
        await activity.markSessionIdle({ workspaceId: input.workspaceId, sessionId: input.sessionId });
        // A queueChanged/userMessage signal can land between the final claim and
        // completion; Temporal blocks completion while a signal is buffered, so
        // re-checking here guarantees the queued turn is picked up instead of
        // stranding it (the signaler skips its start-child fallback on success).
        if (interruptedEventId !== null || wakeups !== seenWakeups) {
          continue;
        }
        return;
      }
      if (!await runTurn(input.accountId, input.workspaceId, input.sessionId, finalTurn.id, finalTurn.triggerEventId)) {
        return;
      }
      continue;
    }
    if (!await runTurn(input.accountId, input.workspaceId, input.sessionId, turn.id, turn.triggerEventId)) {
      return;
    }
  }

  async function runTurn(accountId: string, workspaceId: string, sessionId: string, turnId: string, triggerEventId: string): Promise<boolean> {
    if (interruptedEventId) {
      await activity.interruptActiveTurn({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId: interruptedEventId,
        workflowId: workflowInfo().workflowId,
      });
      interruptedEventId = null;
      return true;
    }

    const scope = new CancellationScope();
    const workflowId = workflowInfo().workflowId;
    // Deliberately schedules the LEGACY activity name: in-flight session
    // workflows (multi-day by design) recorded this name in their histories,
    // and scheduling a different activity type at the same position is a
    // non-deterministic change on replay. Migrate to runAgentTurn with
    // patched() once pre-rename sessions have drained.
    const turn: Promise<activities.RunAgentTurnResult> = scope.run(() => activity.runAgentSegment({
      accountId,
      workspaceId,
      sessionId,
      triggerEventId,
      workflowId,
      turnId,
    }));
    const outcome: { kind: "result"; result: activities.RunAgentTurnResult } | { kind: "interrupt" } | { kind: "failure"; error: unknown } = await Promise.race([
      turn.then(
        (result: activities.RunAgentTurnResult) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      ),
      condition(() => interruptedEventId !== null).then(() => ({ kind: "interrupt" as const })),
    ]);

    if (outcome.kind === "interrupt") {
      scope.cancel();
      await activity.interruptActiveTurn({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId: interruptedEventId!,
        workflowId: workflowInfo().workflowId,
      });
      interruptedEventId = null;
      return true;
    }

    if (outcome.kind === "failure") {
      // An ungraceful worker death never reaches the activity's graceful
      // preemption path — it surfaces here as a heartbeat-timeout failure.
      // Conversation truth was still dual-written during the turn, so the
      // turn is re-queued (resume notice when it persisted progress, original
      // trigger otherwise) and the loop re-claims it on a healthy worker —
      // bounded by a per-turn redispatch counter persisted on the turn row.
      // patched() keeps replays of histories recorded before this branch
      // existed on their original failSession path.
      if (isWorkerDeathFailure(outcome.error) && patched("worker-death-redispatch")) {
        const requeue = await activity.requeueTurnAfterWorkerDeath({
          accountId,
          workspaceId,
          sessionId,
          triggerEventId,
          workflowId,
          turnId,
        });
        if (requeue.action !== "exceeded") {
          // "requeued": the next claim re-dispatches the turn. "stale": the
          // timed-out attempt actually settled the turn (a zombie finished
          // after the server gave up on its heartbeats); nothing to redo.
          return true;
        }
        await activity.failSession({
          accountId,
          workspaceId,
          sessionId,
          triggerEventId,
          workflowId,
          error: `Worker died ${requeue.redispatches + 1} times while running this turn (heartbeat timeout); giving up after ${requeue.redispatches} re-dispatches.`,
        });
        return false;
      }
      await activity.failSession({
        accountId,
        workspaceId,
        sessionId,
        triggerEventId,
        workflowId,
        error: workflowFailureMessage(outcome.error),
      });
      return false;
    }

    if (outcome.result.status === "failed" || outcome.result.status === "cancelled") {
      return outcome.result.status === "cancelled";
    }

    if (outcome.result.status === "preempted") {
      // The hosting worker shut down gracefully mid-turn: the activity
      // checkpointed conversation truth and put the turn back on the queue
      // before completing. Loop again so the next claim re-dispatches it on a
      // healthy worker (a pending interrupt is honored first by the loop).
      return true;
    }

    if (outcome.result.status === "requires_action") {
      await condition(() => interruptedEventId !== null || approvalQueue.length > 0);
      if (interruptedEventId) {
        await activity.interruptActiveTurn({
          accountId,
          workspaceId,
          sessionId,
          triggerEventId: interruptedEventId,
          workflowId,
        });
        interruptedEventId = null;
        return true;
      }
      const approvalEventId = approvalQueue.shift();
      if (approvalEventId) {
        return await runTurn(accountId, workspaceId, sessionId, turnId, approvalEventId);
      }
    }

    if (outcome.result.status === "idle" && outcome.result.continueDelayMs) {
      // Provider backpressure: hold the loop so an active goal's continuation
      // does not immediately re-enter the same rate-limit window. An interrupt
      // or user signal ends the wait early and is handled by the main loop.
      const seenWakeups = wakeups;
      await condition(() => interruptedEventId !== null || wakeups !== seenWakeups, outcome.result.continueDelayMs);
    }
    return true;
  }
}
