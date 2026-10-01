import {
  ParentClosePolicy,
  WorkflowIdReusePolicy,
  log,
  proxyActivities,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { BrowserDeadlineCheckpointTarget } from "@opengeni/db";
import type * as activities from "../activities";

const inventory = proxyActivities<Pick<typeof activities, "listDueBrowserCheckpoints">>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "20 seconds",
});
const checkpoint = proxyActivities<Pick<typeof activities, "checkpointBrowserBeforeDeadline">>({
  startToCloseTimeout: "25 minutes",
  heartbeatTimeout: "20 seconds",
  retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
});

export async function browserDeadlineCheckpointWorkflow(target: BrowserDeadlineCheckpointTarget) {
  return await checkpoint.checkpointBrowserBeforeDeadline(target);
}

/** Runs from the existing lease-sweep dispatch. Inventory never performs provider
 * I/O; each exact browser has an independent durable capture/cleanup child. */
export async function browserDeadlineCheckpointSweepWorkflow(): Promise<void> {
  const targets = await inventory.listDueBrowserCheckpoints();
  await Promise.all(
    targets.map(async (target) => {
      try {
        await startChild(browserDeadlineCheckpointWorkflow, {
          workflowId: `browser-deadline:${target.browserSessionId}:${target.leaseEpoch}:${target.controllerGeneration}`,
          taskQueue: workflowInfo().taskQueue,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
          parentClosePolicy: ParentClosePolicy.ABANDON,
          args: [target],
        });
      } catch (error) {
        if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError") return;
        // Another sweep retries start; it cannot retire the browser's authority.
        log.warn("browser deadline checkpoint child start deferred", {
          browserSessionId: target.browserSessionId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }),
  );
}
