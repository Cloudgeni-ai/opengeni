import { automationActivity } from "./activities";

export type AutomationRunWorkflowInput = {
  accountId: string;
  workspaceId: string;
  runId: string;
};

export async function automationRunWorkflow(input: AutomationRunWorkflowInput): Promise<void> {
  await automationActivity.dispatchAutomationRun(input);
}
