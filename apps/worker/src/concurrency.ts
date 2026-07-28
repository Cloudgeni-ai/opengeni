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
 * Ordinary multi-worker deployments keep a fixed per-process ceiling so HPA or
 * an operator owns horizontal capacity. The single-machine profile selects the
 * resource tuner instead: Temporal admits activity slots while whole-system CPU
 * and memory remain below the configured targets, then stops polling more work.
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
        rampThrottle: "50ms",
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
