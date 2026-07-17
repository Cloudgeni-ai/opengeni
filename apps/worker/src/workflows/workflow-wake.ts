import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const wakeActivity = proxyActivities<Pick<typeof activities, "dispatchSessionWorkflowWakes">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded delivery sweep; recursive controls trigger it immediately and
 * the global Schedule repeats it every ten seconds for repair. */
export async function sessionWorkflowWakeDispatcherWorkflow() {
  return await wakeActivity.dispatchSessionWorkflowWakes();
}
