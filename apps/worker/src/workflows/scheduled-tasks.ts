import { workflowInfo } from "@temporalio/workflow";
import type { TurnInitiator } from "@opengeni/contracts";
import { scheduledTaskActivity } from "./activities";

type ScheduledTaskFireWorkflowBase = {
  accountId: string;
  workspaceId: string;
  taskId: string;
};

export type ScheduledTaskFireWorkflowInput = ScheduledTaskFireWorkflowBase &
  (
    | {
        triggerType: "scheduled";
        agentRunUsageIdempotencyKey?: never;
        initiator?: never;
      }
    | {
        triggerType: "manual";
        agentRunUsageIdempotencyKey: string;
        initiator: TurnInitiator;
      }
  );

export async function scheduledTaskFireWorkflow(
  input: ScheduledTaskFireWorkflowInput,
): Promise<void> {
  // Old malformed manual histories must terminate rather than retrying a usage
  // conflict forever. All current producers are statically required to provide
  // the exact charging identity.
  if (input.triggerType === "manual" && (!input.agentRunUsageIdempotencyKey || !input.initiator)) {
    return;
  }
  const base = {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    producerKey: workflowInfo().workflowId,
  };
  await scheduledTaskActivity.dispatchScheduledTaskRun(
    input.triggerType === "manual"
      ? {
          ...base,
          triggerType: "manual",
          agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey,
          initiator: input.initiator,
        }
      : { ...base, triggerType: "scheduled" },
  );
}
