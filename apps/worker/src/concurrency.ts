import type { Settings } from "@opengeni/config";
import type { WorkerOptions } from "@temporalio/worker";

export type TurnWorkerConcurrencySettings = Pick<
  Settings,
  | "turnWorkerConcurrencyMode"
  | "turnWorkerMaxConcurrentTurns"
  | "turnWorkerTargetCpuUsage"
  | "turnWorkerTargetMemoryUsage"
>;

export type TurnWorkerConcurrencyOptions = Pick<
  WorkerOptions,
  "maxConcurrentActivityTaskExecutions" | "tuner"
>;

/**
 * Fixed profiles keep a per-process ceiling. Resource-aware profiles retain a
 * hard per-process maximum while Temporal meters new activity admission against
 * cgroup/host CPU and memory. The ramp lets usage become visible before a burst
 * can reserve the entire ceiling.
 */
export function turnWorkerConcurrencyOptions(
  settings: TurnWorkerConcurrencySettings,
): TurnWorkerConcurrencyOptions {
  if (settings.turnWorkerConcurrencyMode === "fixed") {
    return {
      maxConcurrentActivityTaskExecutions: settings.turnWorkerMaxConcurrentTurns,
    };
  }

  return {
    tuner: {
      tunerOptions: {
        targetCpuUsage: settings.turnWorkerTargetCpuUsage,
        targetMemoryUsage: settings.turnWorkerTargetMemoryUsage,
      },
      activityTaskSlotOptions: {
        minimumSlots: 1,
        maximumSlots: settings.turnWorkerMaxConcurrentTurns,
        rampThrottle: "250ms",
      },
    },
  };
}

export function turnWorkerConcurrencyLogFields(settings: TurnWorkerConcurrencySettings): {
  concurrencyMode: "fixed" | "resource-based";
  maxConcurrentTurns: number;
  targetCpuUsage: number | null;
  targetMemoryUsage: number | null;
} {
  const resourceBased = settings.turnWorkerConcurrencyMode === "resource-based";
  return {
    concurrencyMode: settings.turnWorkerConcurrencyMode,
    maxConcurrentTurns: settings.turnWorkerMaxConcurrentTurns,
    targetCpuUsage: resourceBased ? settings.turnWorkerTargetCpuUsage : null,
    targetMemoryUsage: resourceBased ? settings.turnWorkerTargetMemoryUsage : null,
  };
}

export const CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES = 32;
export const CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS = 40;
// Session workflows finish at idle boundaries and replay from durable history.
// Bound sticky VM state explicitly: the SDK otherwise derives this from the
// host heap limit (roughly 600 cached workflows/GiB), which is far above this
// process's actual concurrent workflow-task capacity and permanently retains
// idle workflow state in every control replica.
export const CONTROL_WORKER_MAX_CACHED_WORKFLOWS = 64;
