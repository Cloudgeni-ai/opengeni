import { CancellationScope, isCancellation, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { RigVerificationWorkflowInput } from "../activities/rig-verification";

const rigVerificationActivities = proxyActivities<
  Pick<typeof activities, "verifyRigChange" | "verifyRigVersion" | "failRigChangeVerification">
>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 1 },
});

export type { RigVerificationWorkflowInput };

export async function rigVerificationWorkflow(input: RigVerificationWorkflowInput): Promise<void> {
  if (input.changeId) {
    try {
      await rigVerificationActivities.verifyRigChange({
        workspaceId: input.workspaceId,
        changeId: input.changeId,
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      });
    } catch (error) {
      // A workflow cancellation or activity-level Temporal failure must not
      // strand the DB-committed attempt in `verifying`. The failure settlement
      // activity is non-cancellable and attempt-fenced, so a late zombie
      // completion cannot overwrite recovery. Provider cleanup remains the
      // responsibility of the verification activity's bounded cleanup path.
      if (input.attempt !== undefined) {
        await CancellationScope.nonCancellable(async () => {
          await rigVerificationActivities.failRigChangeVerification({
            workspaceId: input.workspaceId,
            changeId: input.changeId,
            attempt: input.attempt!,
            reason: isCancellation(error)
              ? "Rig verification workflow was cancelled."
              : `Rig verification workflow failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
      throw error;
    }
    return;
  }
  if (input.versionId) {
    await rigVerificationActivities.verifyRigVersion({
      workspaceId: input.workspaceId,
      versionId: input.versionId,
    });
  }
}
