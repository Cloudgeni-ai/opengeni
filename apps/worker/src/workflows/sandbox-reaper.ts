// The global schedule performs only bounded inventory/maintenance work and
// starts one durable child per exact (workspace, group, epoch). Provider I/O is
// therefore parallel at the Temporal worker's activity-concurrency limit; one
// slow snapshot can delay only its own box, never the global reaper or a sibling.

import {
  ParentClosePolicy,
  WorkflowIdReusePolicy,
  log,
  proxyActivities,
  startChild,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
  SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS,
  SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS,
  SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
  SANDBOX_REAPER_MAINTENANCE_WORKFLOW_ID,
  SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS,
  sandboxDrainWorkflowId,
  sandboxLifecycleTaskQueue,
  type SandboxDrainActivityInput,
  type SandboxDrainWorkflowInput,
  type SandboxLeaseSweepMaintenanceInput,
} from "../sandbox-reaper-contract";

function lifecycleTaskQueue(): string {
  return sandboxLifecycleTaskQueue(workflowInfo().taskQueue);
}

function sweepActivities() {
  return proxyActivities<Pick<typeof activities, "prepareSandboxLeaseSweep">>({
    taskQueue: lifecycleTaskQueue(),
    startToCloseTimeout: SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS,
    heartbeatTimeout: SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
    // Inventory is the admission edge for every per-box child. A worker crash
    // must not silently consume the only scheduled sweep.
    retry: {
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumInterval: "30 seconds",
    },
  });
}

function maintenanceActivity() {
  return proxyActivities<Pick<typeof activities, "maintainSandboxLeaseSweep">>({
    taskQueue: lifecycleTaskQueue(),
    startToCloseTimeout: SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS,
    heartbeatTimeout: SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
    // Maintenance is ancillary and internally exact/idempotent. Never let one
    // pathological pass keep the fixed-id V2 workflow open forever and thereby
    // suppress all later drain inventories. The next Schedule tick retries it.
    retry: { maximumAttempts: 1 },
  });
}

function drainActivity(startToCloseTimeout: number) {
  return proxyActivities<Pick<typeof activities, "drainSandboxLease">>({
    taskQueue: lifecycleTaskQueue(),
    startToCloseTimeout,
    heartbeatTimeout: SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
    // Each retry is a new exact DB capture attempt under one logical operation.
    // Heartbeat timeout moves a crashed worker to a healthy poller promptly;
    // exact-attempt CAS fencing makes late callbacks harmless.
    retry: {
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumInterval: "30 seconds",
    },
  });
}

// This proxy and workflow deliberately preserve the exact pre-refactor
// ScheduleActivity command. A patch marker would let a new binary replay old
// histories, but an old binary could not replay a history first executed by a
// new worker during a rolling deployment. Routing happens inside the activity,
// where changing implementation is safe and mixed old/new workers remain valid.
const legacyReaperActivity = proxyActivities<Pick<typeof activities, "reapSandboxLeases">>({
  startToCloseTimeout: SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS,
  retry: { maximumAttempts: 1 },
});

export async function sandboxDrainWorkflow(input: SandboxDrainWorkflowInput): Promise<void> {
  const activityInput: SandboxDrainActivityInput = {
    ...input,
    operationId: uuid4(),
  };
  if (input.timeoutClass === "fast") {
    await drainActivity(SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS).drainSandboxLease(activityInput);
  } else {
    await drainActivity(SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS).drainSandboxLease(
      activityInput,
    );
  }
}

/** Ancillary billing/reconciliation/GC is durable but never allowed to hold the
 * fixed-ID inventory workflow open behind a provider backlog. One singleton
 * maintenance child may queue on the lifecycle workers while every schedule
 * tick remains free to inventory and dispatch newly-drainable boxes. */
export async function sandboxReaperMaintenanceWorkflow(
  input: SandboxLeaseSweepMaintenanceInput,
): Promise<void> {
  try {
    await maintenanceActivity().maintainSandboxLeaseSweep(input);
  } catch (error) {
    // The next Schedule tick starts another singleton after this run closes.
    // Drain children were already made durable before this workflow was started.
    log.warn("sandbox reaper maintenance deferred to a later sweep", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function alreadyRunningChild(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as { name?: unknown; cause?: unknown };
    if (record.name === "WorkflowExecutionAlreadyStartedError") return true;
    current = record.cause;
  }
  return false;
}

export async function sandboxReaperWorkflow(): Promise<void> {
  await legacyReaperActivity.reapSandboxLeases();
}

export async function sandboxReaperWorkflowV2(): Promise<void> {
  const sweep = sweepActivities();
  const plan = await sweep.prepareSandboxLeaseSweep();
  const starts = await Promise.all(
    plan.drainable.map(async (target) => {
      try {
        await startChild(sandboxDrainWorkflow, {
          workflowId: sandboxDrainWorkflowId(target),
          taskQueue: lifecycleTaskQueue(),
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
          parentClosePolicy: ParentClosePolicy.ABANDON,
          args: [
            {
              target,
              timeoutClass: plan.timeoutClass,
              snapshotTimeoutMs: plan.snapshotTimeoutMs,
              captureTimeoutMs: plan.captureTimeoutMs,
            },
          ],
        });
        return "started" as const;
      } catch (error) {
        if (alreadyRunningChild(error)) return "already_running" as const;
        log.error("sandbox reaper child start failed", {
          workspaceId: target.workspaceId,
          sandboxGroupId: target.sandboxGroupId,
          leaseEpoch: target.leaseEpoch,
          instanceId: target.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return "failed" as const;
      }
    }),
  );
  try {
    await startChild(sandboxReaperMaintenanceWorkflow, {
      workflowId: SANDBOX_REAPER_MAINTENANCE_WORKFLOW_ID,
      taskQueue: lifecycleTaskQueue(),
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      parentClosePolicy: ParentClosePolicy.ABANDON,
      args: [
        {
          examined: plan.drainable.length,
          started: starts.filter((outcome) => outcome === "started").length,
          alreadyRunning: starts.filter((outcome) => outcome === "already_running").length,
          startFailed: starts.filter((outcome) => outcome === "failed").length,
          rotationsRequested: plan.rotationsRequested,
        },
      ],
    });
  } catch (error) {
    if (alreadyRunningChild(error)) return;
    // Every drain child is already durable and this inventory workflow still
    // completes, so the next Schedule tick can retry maintenance independently.
    log.warn("sandbox reaper maintenance child start deferred to next sweep", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
