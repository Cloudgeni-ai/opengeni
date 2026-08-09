export const SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS = 5 * 60_000;
export const SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS = 5 * 60_000;
export const SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS = 65 * 60_000;
export const SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS = 60_000;
export const SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS = 20_000;
export const SANDBOX_REAPER_ACTIVITY_HEARTBEAT_INTERVAL_MS = 5_000;
// Match the DB inventory's fair 500-row bound so one sweep never discovers a
// due box and then needlessly defers it for another schedule period. Five
// hundred small StartChild commands remain far below Temporal history limits;
// actual provider I/O stays bounded by worker activity concurrency.
export const SANDBOX_REAPER_CHILD_DISPATCH_LIMIT = 500;
export const SANDBOX_REAPER_V2_WORKFLOW_ID = "opengeni-sandbox-lease-reaper-v2";
export const SANDBOX_REAPER_MAINTENANCE_WORKFLOW_ID = "opengeni-sandbox-lease-maintenance-v1";

// A protocol-specific queue is the rolling-deploy compatibility boundary for
// the split reaper activities. An old control worker polls only the base queue,
// so it can replay already-started legacy workflows but can never receive a new
// activity type that its binary does not register.
export const SANDBOX_LIFECYCLE_TASK_QUEUE_SUFFIX = "-sandbox-lifecycle-v1";

export function sandboxLifecycleTaskQueue(baseTaskQueue: string): string {
  return baseTaskQueue.endsWith(SANDBOX_LIFECYCLE_TASK_QUEUE_SUFFIX)
    ? baseTaskQueue
    : `${baseTaskQueue}${SANDBOX_LIFECYCLE_TASK_QUEUE_SUFFIX}`;
}

export type SandboxDrainTimeoutClass = "fast" | "extended";

export type SandboxDrainTarget = {
  workspaceId: string;
  sandboxGroupId: string;
  instanceId: string | null;
  leaseEpoch: number;
};

export type SandboxDrainActivityInput = {
  target: SandboxDrainTarget;
  timeoutClass: SandboxDrainTimeoutClass;
  /** Provider operation budget frozen when the durable child is created. A
   * rolling config change cannot make an existing fast child retry forever. */
  snapshotTimeoutMs: number;
  captureTimeoutMs: number;
  /** Stable logical teardown operation; every Temporal activity retry keeps it
   * while receiving a distinct exact capture-attempt id. */
  operationId: string;
};

export type SandboxDrainWorkflowInput = Omit<SandboxDrainActivityInput, "operationId">;

export type SandboxLeaseSweepMaintenanceInput = {
  examined: number;
  started: number;
  alreadyRunning: number;
  startFailed: number;
  rotationsRequested: number;
};

export function sandboxDrainTimeoutClass(captureTimeoutMs: number): SandboxDrainTimeoutClass {
  return captureTimeoutMs + SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS <
    SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS
    ? "fast"
    : "extended";
}

export function sandboxDrainActivityTimeoutMs(timeoutClass: SandboxDrainTimeoutClass): number {
  return timeoutClass === "fast"
    ? SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS
    : SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS;
}

export function sandboxDrainWorkflowId(target: SandboxDrainTarget): string {
  return `sandbox-drain:${target.workspaceId}:${target.sandboxGroupId}:${target.leaseEpoch}`;
}
