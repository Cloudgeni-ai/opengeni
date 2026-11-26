import { ActivityFailure, deprecatePatch, patched, workflowInfo } from "@temporalio/workflow";
import type { TurnInitiator } from "@opengeni/contracts";
import type { DispatchScheduledTaskRunInput } from "../activities/types";
import { scheduledTaskActivity, scheduledTaskFailureActivity } from "./activities";

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
        credentialRestriction?: never;
      }
    | {
        /**
         * Events matched the automation. The workflow id is the occurrence's
         * producer key, `scheduled-task-event:<occurrenceId>`.
         */
        triggerType: "event";
        agentRunUsageIdempotencyKey?: never;
        initiator?: never;
        credentialRestriction?: never;
      }
    | {
        triggerType: "manual" | "initial" | "provider_event" | "retry" | "repair";
        agentRunUsageIdempotencyKey: string;
        initiator: TurnInitiator;
        credentialRestriction?: "developer_setup";
      }
  );

export function scheduledTaskDispatchInput(
  input: ScheduledTaskFireWorkflowInput,
  producerKey: string,
): DispatchScheduledTaskRunInput {
  const base = {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    producerKey,
  };
  if (input.triggerType === "scheduled" || input.triggerType === "event") {
    return { ...base, triggerType: input.triggerType };
  }
  return {
    ...base,
    triggerType: input.triggerType,
    agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey,
    initiator: input.initiator,
    ...(input.credentialRestriction === "developer_setup"
      ? { credentialRestriction: input.credentialRestriction }
      : {}),
  };
}

export async function scheduledTaskFireWorkflow(
  input: ScheduledTaskFireWorkflowInput,
): Promise<void> {
  // Every producer provides the charging identity; the guard for malformed
  // manual histories is retired. Remove this call once no open run carries
  // the non-deprecated marker.
  deprecatePatch("scheduled-task-manual-initiator-v1");
  const dispatch = scheduledTaskDispatchInput(input, workflowInfo().workflowId);
  try {
    await scheduledTaskActivity.dispatchScheduledTaskRun(dispatch);
  } catch (error) {
    if (
      (dispatch.triggerType === "scheduled" || dispatch.triggerType === "event") &&
      error instanceof ActivityFailure &&
      error.retryState === "MAXIMUM_ATTEMPTS_REACHED" &&
      patched("scheduled-task-dispatch-exhaustion-receipt-v1")
    ) {
      await scheduledTaskFailureActivity.recordScheduledTaskDispatchFailure(dispatch);
    }
    throw error;
  }
}
