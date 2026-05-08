import { CancellationScope, condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities";

const userMessage = defineSignal<[string]>("userMessage");
const approvalDecision = defineSignal<[string]>("approvalDecision");
const interrupt = defineSignal<[string]>("interrupt");

const activity = proxyActivities<typeof activities>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

export type SessionWorkflowInput = {
  sessionId: string;
  initialEventId: string;
};

export type DocumentIndexWorkflowInput = {
  documentId: string;
};

export async function documentIndexWorkflow(input: DocumentIndexWorkflowInput) {
  return await activity.indexDocument(input);
}

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  const messageQueue: string[] = [input.initialEventId];
  const approvalQueue: string[] = [];
  let interruptedEventId: string | null = null;
  let waitingForApproval = false;

  setHandler(userMessage, (eventId) => {
    messageQueue.push(eventId);
  });
  setHandler(approvalDecision, (eventId) => {
    approvalQueue.push(eventId);
  });
  setHandler(interrupt, (eventId) => {
    interruptedEventId = eventId;
  });

  while (true) {
    await condition(() => interruptedEventId !== null || messageQueue.length > 0 || (waitingForApproval && approvalQueue.length > 0));
    if (interruptedEventId) {
      await activity.cancelSession({
        sessionId: input.sessionId,
        triggerEventId: interruptedEventId,
        workflowId: workflowInfo().workflowId,
      });
      return;
    }

    const triggerEventId: string | undefined = waitingForApproval ? approvalQueue.shift() : messageQueue.shift();
    if (!triggerEventId) {
      continue;
    }

    const scope = new CancellationScope();
    const workflowId = workflowInfo().workflowId;
    const segment: Promise<activities.RunAgentSegmentResult> = scope.run(() => activity.runAgentSegment({
      sessionId: input.sessionId,
      triggerEventId,
      workflowId,
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
      await activity.cancelSession({
        sessionId: input.sessionId,
        triggerEventId: interruptedEventId!,
        workflowId: workflowInfo().workflowId,
      });
      return;
    }

    if (outcome.kind === "failure") {
      await activity.failSession({
        sessionId: input.sessionId,
        triggerEventId,
        workflowId,
        error: workflowFailureMessage(outcome.error),
      });
      return;
    }

    if (outcome.result.status === "failed" || outcome.result.status === "cancelled") {
      return;
    }

    waitingForApproval = outcome.result.status === "requires_action";
  }
}

function workflowFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
