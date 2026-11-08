import {
  continueAsNew,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "../activities";

const wakeActivity = proxyActivities<Pick<typeof activities, "dispatchSessionWorkflowWakes">>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "15 seconds",
  retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
});

const maintenanceActivity = proxyActivities<
  Pick<typeof activities, "maintainSessionWorkflowWakes">
>({
  startToCloseTimeout: "5 minutes",
  retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
});

export async function sessionWorkflowWakeMaintenanceWorkflow() {
  await maintenanceActivity.maintainSessionWorkflowWakes();
  // Timer commits need not wait another cadence. Reuse the same fenced claim
  // path; an independent dispatcher can still deliver while maintenance waits.
  await wakeActivity.dispatchSessionWorkflowWakes();
}

/** Must equal SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL in @opengeni/core;
 * workflow code cannot import that package. */
export const sessionWorkflowWakeDispatchRequestedSignal = defineSignal("dispatchRequested");

/** Bounds one execution's history without dropping an outstanding request. */
export const SESSION_WORKFLOW_WAKE_DISPATCHER_MAX_SWEEPS = 50;

/**
 * Bounded delivery sweeps. Producers and the control worker's repair cadence
 * signal-with-start one fixed execution; a request that arrives during a sweep
 * runs one more sweep afterwards, so no committed wake waits for a later tick.
 */
export async function sessionWorkflowWakeDispatcherWorkflow(): Promise<
  Awaited<ReturnType<typeof wakeActivity.dispatchSessionWorkflowWakes>>
> {
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
  // Older histories completed at the cap even with a pending signal. Preserve
  // that recorded command on replay; only new history may continue instead.
  if (requested && patched("workflow-wake-dispatcher-retain-pending-v1")) {
    return await continueAsNew<typeof sessionWorkflowWakeDispatcherWorkflow>();
  }
  return result;
}
