import { continueAsNew, sleep } from "@temporalio/workflow";
import { videoGenerationActivityForTaskQueue } from "./activities";

export type VideoGenerationWorkflowInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  baseTaskQueue: string;
  iterations?: number;
};

const CONTINUE_AS_NEW_AFTER = 100;

export function videoGenerationWorkflowId(operationId: string): string {
  return `video-generation:${operationId}`;
}

/** Small deterministic orchestration; all private/provider state remains in Postgres. */
export async function videoGenerationWorkflow(input: VideoGenerationWorkflowInput): Promise<void> {
  const activity = videoGenerationActivityForTaskQueue(input.baseTaskQueue);
  let iterations = input.iterations ?? 0;
  while (iterations < CONTINUE_AS_NEW_AFTER) {
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
