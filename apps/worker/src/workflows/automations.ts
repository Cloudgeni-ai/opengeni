import { automationActivity, automationFailureActivity } from "./activities";

export type AutomationRunWorkflowInput = {
  accountId: string;
  workspaceId: string;
  runId: string;
};

export type AutomationRunWorkflowActivities = {
  dispatchAutomationRun: (input: AutomationRunWorkflowInput) => Promise<unknown>;
  settleAutomationRunFailure: (input: AutomationRunWorkflowInput) => Promise<void>;
};

export async function runAutomationRunWorkflow(
  input: AutomationRunWorkflowInput,
  activities: AutomationRunWorkflowActivities,
): Promise<void> {
  try {
    await activities.dispatchAutomationRun(input);
  } catch {
    await activities.settleAutomationRunFailure(input);
  }
}

export async function automationRunWorkflow(input: AutomationRunWorkflowInput): Promise<void> {
  await runAutomationRunWorkflow(input, {
    dispatchAutomationRun: automationActivity.dispatchAutomationRun,
    settleAutomationRunFailure: automationFailureActivity.settleAutomationRunFailure,
  });
}
