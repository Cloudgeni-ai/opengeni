import { getExternalWorkflowHandle, ParentClosePolicy, startChild } from "@temporalio/workflow";
import { activity } from "./activities";
import { queueChanged } from "./session";

export type ScheduledTaskFireWorkflowInput = {
  accountId: string;
  workspaceId: string;
  taskId: string;
  triggerType: "scheduled" | "manual";
  agentRunUsageIdempotencyKey?: string;
};

export async function scheduledTaskFireWorkflow(input: ScheduledTaskFireWorkflowInput): Promise<void> {
	  const dispatched = await activity.dispatchScheduledTaskRun({
	    workspaceId: input.workspaceId,
	    taskId: input.taskId,
	    triggerType: input.triggerType,
	    ...(input.agentRunUsageIdempotencyKey ? { agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey } : {}),
	  });
  if (dispatched.action === "start") {
    await startSessionChild(dispatched.accountId, dispatched.workspaceId, dispatched.sessionId, dispatched.workflowId);
    return;
  }
  try {
    await getExternalWorkflowHandle(dispatched.workflowId).signal(queueChanged);
  } catch {
    await startSessionChild(dispatched.accountId, dispatched.workspaceId, dispatched.sessionId, dispatched.workflowId);
  }
}

async function startSessionChild(accountId: string, workspaceId: string, sessionId: string, workflowId: string): Promise<void> {
  await startChild("sessionWorkflow", {
    workflowId,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
    args: [{ accountId, workspaceId, sessionId }],
  });
}
