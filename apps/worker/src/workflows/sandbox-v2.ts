import {
  ParentClosePolicy,
  WorkflowIdReusePolicy,
  continueAsNew,
  log,
  proxyActivities,
  startChild,
  workflowInfo,
  patched,
} from "@temporalio/workflow";
import type { SandboxMachineInventoryItem } from "@opengeni/db";
import type * as activities from "../activities";
import { sandboxV2ControlTaskQueue, type SandboxV2RecoveryCursor } from "../sandbox-v2-control";

function inventoryActivities() {
  return proxyActivities<Pick<typeof activities, "listSandboxV2Machines">>({
    taskQueue: sandboxV2ControlTaskQueue(workflowInfo().taskQueue),
    startToCloseTimeout: "30 seconds",
    retry: { maximumAttempts: 3 },
  });
}
function machineActivities() {
  return proxyActivities<Pick<typeof activities, "reconcileSandboxV2Machine">>({
    taskQueue: sandboxV2ControlTaskQueue(workflowInfo().taskQueue),
    startToCloseTimeout: "5 minutes",
    heartbeatTimeout: "20 seconds",
    // A later sweep resumes the same persisted transition. No retry wraps a
    // whole logical command; the native journal binds Read/Cancel exactly.
    retry: { maximumAttempts: 1 },
  });
}

/** Each sweep starts one independent owner per durable machine. Long or broken
 * provider calls cannot hold the global inventory or another machine's work. */
export async function sandboxMachineSweepWorkflow(
  input: { afterMachineId?: string } = {},
): Promise<void> {
  let cursor = input.afterMachineId;
  for (let page = 0; page < 16; page++) {
    const batch = await inventoryActivities().listSandboxV2Machines(
      cursor ? { afterMachineId: cursor } : {},
    );
    await Promise.all(
      batch.items.map(async (target) => {
        try {
          await startChild(sandboxMachineReconcileWorkflow, {
            workflowId: `sandbox-machine-v2:${target.accountId}:${target.workspaceId}:${target.machineId}`,
            taskQueue: sandboxV2ControlTaskQueue(workflowInfo().taskQueue),
            workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
            parentClosePolicy: ParentClosePolicy.ABANDON,
            args: [target],
          });
        } catch (error) {
          if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError")
            return;
          // Start failure changes no durable machine/command ownership. The next
          // sweep starts it again; never turn this into cleanup/absence proof.
          log.warn("sandbox machine child start deferred", {
            failure: error instanceof Error ? error.name : "unknown",
          });
        }
      }),
    );
    if (!batch.nextMachineId) return;
    cursor = batch.nextMachineId;
  }
  await continueAsNew<typeof sandboxMachineSweepWorkflow>({ afterMachineId: cursor! });
}

/** Complete each inventory independently. A finished inventory is not reset
 * while another has later pages, avoiding starvation behind live owners.
 * Subsequent sweep children restart all scans, catching inserts behind cursors. */
export async function sandboxMachineReconcileWorkflow(
  target: SandboxMachineInventoryItem & SandboxV2RecoveryCursor,
): Promise<void> {
  const jobInventory = patched("sandbox-machine-v2-background-custody-v1");
  for (let page = 0; page < 32; page++) {
    const result = await machineActivities().reconcileSandboxV2Machine(target);
    if (result.status === "deferred") return;
    target = {
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      sandboxGroupId: target.sandboxGroupId,
      machineId: target.machineId,
      provider: target.provider,
      attemptsComplete: target.attemptsComplete === true || result.nextDemandId === null,
      commandsComplete: target.commandsComplete === true || result.nextOperationId === null,
      ...(result.nextDemandId ? { afterDemandId: result.nextDemandId } : {}),
      ...(result.nextOperationId ? { afterOperationId: result.nextOperationId } : {}),
      ...(jobInventory
        ? {
            jobsComplete: target.jobsComplete === true || result.nextJobId === null,
            ...(result.nextJobId ? { afterJobId: result.nextJobId } : {}),
          }
        : {}),
    };
    if (
      target.attemptsComplete &&
      target.commandsComplete &&
      (!jobInventory || target.jobsComplete)
    )
      return;
  }
  await continueAsNew<typeof sandboxMachineReconcileWorkflow>(target);
}
