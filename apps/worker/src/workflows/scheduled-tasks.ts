import {
  getExternalWorkflowHandle,
  ParentClosePolicy,
  patched,
  startChild,
  workflowInfo,
  WorkflowIdReusePolicy,
} from "@temporalio/workflow";
import type { TurnInitiator } from "@opengeni/contracts";
import { scheduledTaskActivity } from "./activities";
import {
  knowledgeSourceSyncWake,
  knowledgeSourceSyncWorkflow,
  knowledgeSourceSyncWorkflowId,
} from "./knowledge-source-sync";

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
        triggerType: "manual" | "initial" | "provider_event" | "retry" | "repair";
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
  if (
    patched("scheduled-task-manual-initiator-v1") &&
    input.triggerType !== "scheduled" &&
    (!input.agentRunUsageIdempotencyKey || !input.initiator)
  ) {
    return;
  }
  const base = {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    producerKey: workflowInfo().workflowId,
  };
  const result = await scheduledTaskActivity.dispatchScheduledTaskRun(
    input.triggerType !== "scheduled"
      ? {
          ...base,
          triggerType: input.triggerType,
          agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey,
          initiator: input.initiator,
        }
      : { ...base, triggerType: "scheduled" },
  );
  if (result.action !== "knowledge_source_sync") return;

  const workflowId = knowledgeSourceSyncWorkflowId(result.sourceId);
  try {
    await startChild(knowledgeSourceSyncWorkflow, {
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      parentClosePolicy: ParentClosePolicy.ABANDON,
      args: [result],
    });
  } catch (error) {
    if (!alreadyRunningWorkflow(error)) throw error;
    await getExternalWorkflowHandle(workflowId).signal(knowledgeSourceSyncWake, result);
  }
}

function alreadyRunningWorkflow(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as { name?: unknown; cause?: unknown };
    if (record.name === "WorkflowExecutionAlreadyStartedError") return true;
    current = record.cause;
  }
  return false;
}
