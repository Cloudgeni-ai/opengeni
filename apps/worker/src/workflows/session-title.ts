import { continueAsNew, proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities";
import { turnTaskQueue } from "./activities";

export type SessionTitleWorkflowInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  baseTaskQueue: string;
};

/** Only identifiers enter workflow history. Provider bytes live in the encrypted job. */
export async function sessionTitleWorkflow(input: SessionTitleWorkflowInput): Promise<void> {
  const activity = proxyActivities<Pick<typeof activities, "reconcileSessionTitleOperation">>({
    taskQueue: turnTaskQueue(input.baseTaskQueue),
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "10 seconds" },
  });
  for (let iteration = 0; iteration < 100; iteration++) {
    const result = await activity.reconcileSessionTitleOperation({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
    });
    if (result.action === "terminal") return;
    await sleep(result.delayMs);
  }
  await continueAsNew<typeof sessionTitleWorkflow>(input);
}
