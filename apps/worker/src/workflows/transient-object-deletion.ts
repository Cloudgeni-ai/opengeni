import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

export type TransientObjectDeletionWorkflowInput = {
  workspaceId: string;
  objectKeys: string[];
};

const deletionActivity = proxyActivities<Pick<typeof activities, "deleteTransientObjects">>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 hour",
    maximumAttempts: 50,
  },
});

/**
 * Deletes objects a request staged in storage but may not get to clean up
 * itself. The caller starts it with a start delay, so it runs once the
 * objects can no longer be in use; deleting an object that is already gone
 * succeeds.
 */
export async function transientObjectDeletionWorkflow(
  input: TransientObjectDeletionWorkflowInput,
): Promise<void> {
  await deletionActivity.deleteTransientObjects(input);
}
