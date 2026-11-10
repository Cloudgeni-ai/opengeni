import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "../../src/activities";

// Frozen pre-progress-heartbeat dispatcher. Keep its commands and control flow
// unchanged: real histories recorded here prove upgrade replay compatibility.
const wakeActivity = proxyActivities<Pick<typeof activities, "dispatchSessionWorkflowWakes">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

export const sessionWorkflowWakeDispatchRequestedSignal = defineSignal("dispatchRequested");
export const SESSION_WORKFLOW_WAKE_DISPATCHER_MAX_SWEEPS = 50;

export async function sessionWorkflowWakeDispatcherWorkflow() {
  let requested = false;
  setHandler(sessionWorkflowWakeDispatchRequestedSignal, () => {
    requested = true;
  });
  let result: Awaited<ReturnType<typeof wakeActivity.dispatchSessionWorkflowWakes>>;
  let sweeps = 0;
  do {
    requested = false;
    result = await wakeActivity.dispatchSessionWorkflowWakes();
    sweeps += 1;
  } while (requested && sweeps < SESSION_WORKFLOW_WAKE_DISPATCHER_MAX_SWEEPS);
  return result;
}
