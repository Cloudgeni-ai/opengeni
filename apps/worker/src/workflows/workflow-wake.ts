import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "../activities";

const wakeActivity = proxyActivities<Pick<typeof activities, "dispatchSessionWorkflowWakes">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** Must equal SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL in @opengeni/core;
 * workflow code cannot import that package. */
export const sessionWorkflowWakeDispatchRequestedSignal = defineSignal("dispatchRequested");

/** Bounds one execution's history. A request still pending at the cap is
 * picked up by the control worker's next repair tick. */
export const SESSION_WORKFLOW_WAKE_DISPATCHER_MAX_SWEEPS = 50;

/**
 * Bounded delivery sweeps. Producers and the control worker's repair cadence
 * signal-with-start one fixed execution; a request that arrives during a sweep
 * runs one more sweep afterwards, so no committed wake waits for a later tick.
 */
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
