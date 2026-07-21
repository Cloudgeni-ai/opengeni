import { describe, expect, test } from "bun:test";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../src/concurrency";

describe("worker concurrency contract", () => {
  test("pins the temporary production turn density independently of control work", () => {
    expect(TURN_WORKER_MAX_CONCURRENT_TURNS).toBe(16);
    expect(CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES).toBe(32);
    expect(CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS).toBe(40);
  });
});
