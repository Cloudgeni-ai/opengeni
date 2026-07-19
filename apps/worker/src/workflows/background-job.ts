import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { BackgroundJobControllerInput } from "../activities/types";

const backgroundJobActivity = proxyActivities<
  Pick<typeof activities, "runBackgroundJobController">
>({
  startToCloseTimeout: "30 days",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

export type BackgroundJobWorkflowInput = BackgroundJobControllerInput;

/** One stable workflow per job; activity retries reattach to the same provider. */
export async function backgroundJobWorkflow(input: BackgroundJobWorkflowInput): Promise<void> {
  await backgroundJobActivity.runBackgroundJobController(input);
}
