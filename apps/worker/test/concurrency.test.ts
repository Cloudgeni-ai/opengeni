import { describe, expect, test } from "bun:test";
import {
  CONTROL_WORKER_MAX_CACHED_WORKFLOWS,
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
  turnWorkerConcurrencyLogFields,
  turnWorkerConcurrencyOptions,
  type TurnWorkerConcurrencySettings,
} from "../src/concurrency";

const fixed: TurnWorkerConcurrencySettings = {
  turnWorkerConcurrencyMode: "fixed",
  turnWorkerMaxConcurrentTurns: 16,
  turnWorkerTargetCpuUsage: 0.8,
  turnWorkerTargetMemoryUsage: 0.75,
};

describe("worker concurrency contract", () => {
  test("keeps ordinary horizontally-scaled workers on a fixed ceiling", () => {
    expect(turnWorkerConcurrencyOptions(fixed)).toEqual({
      maxConcurrentActivityTaskExecutions: 16,
    });
    expect(turnWorkerConcurrencyLogFields(fixed)).toEqual({
      concurrencyMode: "fixed",
      maxConcurrentTurns: 16,
      targetCpuUsage: null,
      targetMemoryUsage: null,
    });
    expect(CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES).toBe(32);
    expect(CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS).toBe(40);
    expect(CONTROL_WORKER_MAX_CACHED_WORKFLOWS).toBe(64);
    expect(CONTROL_WORKER_MAX_CACHED_WORKFLOWS).toBeGreaterThanOrEqual(
      CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
    );
  });

  test("lets one worker fill a machine within system resource targets", () => {
    const settings: TurnWorkerConcurrencySettings = {
      ...fixed,
      turnWorkerConcurrencyMode: "resource-based",
      turnWorkerMaxConcurrentTurns: 256,
    };
    expect(turnWorkerConcurrencyOptions(settings)).toEqual({
      tuner: {
        tunerOptions: {
          targetCpuUsage: 0.8,
          targetMemoryUsage: 0.75,
        },
        activityTaskSlotOptions: {
          minimumSlots: 1,
          maximumSlots: 256,
          rampThrottle: "250ms",
        },
      },
    });
    expect(turnWorkerConcurrencyLogFields(settings)).toEqual({
      concurrencyMode: "resource-based",
      maxConcurrentTurns: 256,
      targetCpuUsage: 0.8,
      targetMemoryUsage: 0.75,
    });
  });
});
