import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const wakeActivity = proxyActivities<Pick<typeof activities, "dispatchSessionWorkflowWakes">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

const backgroundJobDispatchActivity = proxyActivities<
  Pick<typeof activities, "dispatchBackgroundJobControllers">
>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded delivery sweep; recursive controls trigger it immediately and
 * the global Schedule repeats it every ten seconds for repair. */
export async function sessionWorkflowWakeDispatcherWorkflow() {
  const [sessionWakes] = await Promise.all([
    wakeActivity.dispatchSessionWorkflowWakes(),
    backgroundJobDispatchActivity.dispatchBackgroundJobControllers(),
  ]);
  return sessionWakes;
}
