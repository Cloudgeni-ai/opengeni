import { continueAsNew, sleep } from "@temporalio/workflow";
import { videoGenerationActivityForTaskQueue } from "../../src/workflows/activities";

type Input = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  baseTaskQueue: string;
  iterations?: number;
};

// Pre-cutover orchestration, kept immutable for real-history replay proof.
export async function videoGenerationWorkflow(input: Input): Promise<void> {
  const activity = videoGenerationActivityForTaskQueue(input.baseTaskQueue);
  let iterations = input.iterations ?? 0;
  while (iterations < 100) {
    const result = await activity.reconcileVideoGenerationOperation({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
    });
    if (result.action === "terminal") return;
    await sleep(result.delayMs);
    iterations += 1;
  }
  await continueAsNew<typeof videoGenerationWorkflow>({ ...input, iterations: 0 });
}