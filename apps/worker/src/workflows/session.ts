import { CancellationScope, condition, defineSignal, setHandler, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities";
import { activity, workflowFailureMessage } from "./activities";

export const userMessage = defineSignal<[string]>("userMessage");
export const queueChanged = defineSignal("queueChanged");
export const approvalDecision = defineSignal<[string]>("approvalDecision");
export const interrupt = defineSignal<[string]>("interrupt");

export type SessionWorkflowInput = {
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
    const turn = await activity.claimNextQueuedTurn({ sessionId: input.sessionId, workflowId });
    if (!turn) {
      const seenWakeups = wakeups;
      const woke = await condition(() => interruptedEventId !== null || wakeups !== seenWakeups, "5s");
      if (interruptedEventId) {
        interruptedEventId = null;
        await activity.markSessionIdle({ sessionId: input.sessionId });
        return;
      }
      if (woke) {
        continue;
      }
      const finalTurn = await activity.claimNextQueuedTurn({ sessionId: input.sessionId, workflowId });
      if (!finalTurn) {
        await activity.markSessionIdle({ sessionId: input.sessionId });
        return;
      }
      if (!await runTurn(input.sessionId, finalTurn.id, finalTurn.triggerEventId)) {
        return;
      }
      continue;
    }
    if (!await runTurn(input.sessionId, turn.id, turn.triggerEventId)) {
      return;
    }
  }

  async function runTurn(sessionId: string, turnId: string, triggerEventId: string): Promise<boolean> {
    if (interruptedEventId) {
      await activity.interruptActiveTurn({
        sessionId,
        triggerEventId: interruptedEventId,
        workflowId: workflowInfo().workflowId,
      });
      interruptedEventId = null;
      return true;
    }

    const scope = new CancellationScope();
    const workflowId = workflowInfo().workflowId;
    const segment: Promise<activities.RunAgentSegmentResult> = scope.run(() => activity.runAgentSegment({
      sessionId,
      triggerEventId,
      workflowId,
      turnId,
    }));
    const outcome: { kind: "result"; result: activities.RunAgentSegmentResult } | { kind: "interrupt" } | { kind: "failure"; error: unknown } = await Promise.race([
      segment.then(
        (result: activities.RunAgentSegmentResult) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      ),
      condition(() => interruptedEventId !== null).then(() => ({ kind: "interrupt" as const })),
    ]);

    if (outcome.kind === "interrupt") {
      scope.cancel();
      await activity.interruptActiveTurn({
        sessionId,
        triggerEventId: interruptedEventId!,
        workflowId: workflowInfo().workflowId,
      });
      interruptedEventId = null;
      return true;
    }

    if (outcome.kind === "failure") {
      await activity.failSession({
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
          sessionId,
          triggerEventId: interruptedEventId,
          workflowId,
        });
        interruptedEventId = null;
        return true;
      }
      const approvalEventId = approvalQueue.shift();
      if (approvalEventId) {
        return await runTurn(sessionId, turnId, approvalEventId);
      }
    }
    return true;
  }
}
