import { workflowInfo } from "@temporalio/workflow";
import { activity } from "./activities";

export type ScheduledTaskFireWorkflowInput = {
  accountId: string;
  workspaceId: string;
  taskId: string;
  triggerType: "scheduled" | "manual";
  agentRunUsageIdempotencyKey?: string;
};

export async function scheduledTaskFireWorkflow(
  input: ScheduledTaskFireWorkflowInput,
): Promise<void> {
  await activity.dispatchScheduledTaskRun({
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    triggerType: input.triggerType,
    producerKey: workflowInfo().workflowId,
    ...(input.agentRunUsageIdempotencyKey
      ? { agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey }
      : {}),
  });
}
