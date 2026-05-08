import { getExternalWorkflowHandle, ParentClosePolicy, startChild } from "@temporalio/workflow";
import { activity } from "./activities";
import { queueChanged } from "./session";

export type ScheduledTaskFireWorkflowInput = {
  taskId: string;
  triggerType: "scheduled" | "manual";
};

export async function scheduledTaskFireWorkflow(input: ScheduledTaskFireWorkflowInput): Promise<void> {
  const dispatched = await activity.dispatchScheduledTaskRun({
    taskId: input.taskId,
    triggerType: input.triggerType,
  });
  if (dispatched.action === "start") {
    await startSessionChild(dispatched.sessionId, dispatched.workflowId);
    return;
  }
  try {
    await getExternalWorkflowHandle(dispatched.workflowId).signal(queueChanged);
  } catch {
    await startSessionChild(dispatched.sessionId, dispatched.workflowId);
  }
}

async function startSessionChild(sessionId: string, workflowId: string): Promise<void> {
  await startChild("sessionWorkflow", {
    workflowId,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
    args: [{ sessionId }],
  });
}
