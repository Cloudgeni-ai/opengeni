import { continueAsNew, patched, sleep } from "@temporalio/workflow";
import { videoGenerationActivityForTaskQueue } from "./activities";

export type VideoGenerationWorkflowInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  baseTaskQueue: string;
  controlQueueRoutingEnabled?: boolean;
  iterations?: number;
};

const CONTINUE_AS_NEW_AFTER = 100;
export const VIDEO_RECONCILIATION_CONTROL_QUEUE_PATCH = "video-reconciliation-control-queue-v1";

export function videoGenerationWorkflowId(operationId: string): string {
  return `video-generation:${operationId}`;
}

/** Small deterministic orchestration; all private/provider state remains in Postgres. */
export async function videoGenerationWorkflow(input: VideoGenerationWorkflowInput): Promise<void> {
  let iterations = input.iterations ?? 0;
  while (iterations < CONTINUE_AS_NEW_AFTER) {
    // Evaluate the version marker at the dispatch boundary, not at startup.
    // The default-off input is frozen when a run starts: legacy runs (including
    // their timer-held work and continue-as-new successors) drain on turns.
    // Only new opted-in runs route to control after all control pollers upgrade.
    const activity = videoGenerationActivityForTaskQueue(
      input.baseTaskQueue,
      input.controlQueueRoutingEnabled === true &&
        patched(VIDEO_RECONCILIATION_CONTROL_QUEUE_PATCH),
    );
    const result = await activity.reconcileVideoGenerationOperation({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
    });
    if (result.action === "terminal") return;
    await sleep(result.delayMs);
    iterations += 1;
  }
  await continueAsNew<typeof videoGenerationWorkflow>({
    ...input,
    iterations: 0,
  });
}
