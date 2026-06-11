import { CancellationScope, condition, defineSignal, isCancellation, setHandler, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { activity, workflowFailureMessage } from "./activities";

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
        interruptedEventId = null;
        // An idle interrupt is an explicit stop: pause an active goal before
        // shutting down so a later wake does not auto-continue it.
        await activity.pauseGoalForInterrupt({ workspaceId: input.workspaceId, sessionId: input.sessionId });
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
