import { describe, expect, it } from "bun:test";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";
import { schedulePauseOwnedByRun, workerTopologyEvidence } from "./session-control-cutover";

describe("production cutover operator retry ownership", () => {
  it("re-emits only unpaused schedules or schedules already paused by the same run", () => {
    const note = "OpenGeni production maintenance opengeni-cutover-main";
    expect(schedulePauseOwnedByRun(false, null, note)).toBe(true);
    expect(schedulePauseOwnedByRun(true, note, note)).toBe(true);
    expect(schedulePauseOwnedByRun(true, "manual operator pause", note)).toBe(false);
    expect(schedulePauseOwnedByRun(true, null, note)).toBe(false);
  });
});

describe("production cutover preflight topology", () => {
  it("reads every worker ceiling from the runtime concurrency contract", () => {
    expect(workerTopologyEvidence()).toEqual({
      roles: ["control", "turn"],
      turnTaskQueueSuffix: "-turns",
      controlActivityConcurrencyPerPod: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
      controlWorkflowConcurrencyPerPod: CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
      turnActivityConcurrencyPerPod: TURN_WORKER_MAX_CONCURRENT_TURNS,
    });
  });
});
