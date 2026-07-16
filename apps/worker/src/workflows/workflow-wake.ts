import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const wakeActivity = proxyActivities<Pick<typeof activities, "dispatchSessionWorkflowWakes">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded delivery sweep; direct producer signals remain the fast path. */
export async function sessionWorkflowWakeDispatcherWorkflow() {
  return await wakeActivity.dispatchSessionWorkflowWakes();
}
