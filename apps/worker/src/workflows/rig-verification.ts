import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { RigVerificationWorkflowInput } from "../activities/rig-verification";

const rigVerificationActivities = proxyActivities<Pick<typeof activities, "verifyRigChange" | "verifyRigVersion">>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 1 },
});

export type { RigVerificationWorkflowInput };

export async function rigVerificationWorkflow(input: RigVerificationWorkflowInput): Promise<void> {
  if (input.changeId) {
    await rigVerificationActivities.verifyRigChange({ workspaceId: input.workspaceId, changeId: input.changeId });
    return;
  }
  if (input.versionId) {
    await rigVerificationActivities.verifyRigVersion({ workspaceId: input.workspaceId, versionId: input.versionId });
  }
}
