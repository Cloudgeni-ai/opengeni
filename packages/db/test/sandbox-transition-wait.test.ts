import { describe, expect, test } from "bun:test";
import {
  SANDBOX_LIFECYCLE_RETRY_HANDOFF_GRACE_MS as GRACE,
  SANDBOX_LIFECYCLE_TRANSITION_MAX_WAIT_MS as MAX_WAIT,
} from "@opengeni/config";
import { SandboxTransitionWaitBudget } from "../src/sandbox-transition-wait";

describe("sandbox transition wait budget", () => {
  test("a rolling timeout reduction still waits for the first child's frozen deadline", () => {
    const budget = new SandboxTransitionWaitBudget(25, 0);
    budget.observeCapture(60_000, 10);
    expect(budget.deadline).toBe(60_010 + GRACE);
    expect(75).toBeLessThan(budget.deadline);
  });

  test("139 renewed drain attempts cannot stretch the caller's wait to an hour", () => {
    const budget = new SandboxTransitionWaitBudget(110_000, 0);
    budget.observeCapture(70_000, 0);
    for (let attempt = 1; attempt <= 139; attempt++) {
      budget.observeCapture(70_000, attempt * 90_000);
    }
    expect(budget.deadline).toBe(110_000);
    expect(180_000).toBeGreaterThan(budget.deadline);
  });

  test("an expired durable claim cannot renew handoff grace on every poll", () => {
    const budget = new SandboxTransitionWaitBudget(25, 0);
    budget.observeCapture(0, 0);
    for (let now = 500; now <= MAX_WAIT; now += 500) budget.observeCapture(0, now);
    expect(budget.deadline).toBe(Math.max(25, GRACE));
  });

  test("a caller retains its configured budget when the first capture expires sooner", () => {
    const budget = new SandboxTransitionWaitBudget(120_000, 100);
    budget.observeCapture(1_000, 200);
    expect(budget.deadline).toBe(120_100);
  });

  test("zero-wait probes stay immediate even with an active capture", () => {
    const budget = new SandboxTransitionWaitBudget(0, 100);
    budget.observeCapture(60_000, 101);
    expect(budget.deadline).toBe(100);
  });

  test("invalid observations do not consume the first valid child's allowance", () => {
    const budget = new SandboxTransitionWaitBudget(25, 0);
    for (const value of [undefined, null, -1, NaN, Infinity, 1.5, MAX_WAIT + 1]) {
      budget.observeCapture(value, 10);
      expect(budget.deadline).toBe(25);
    }
    budget.observeCapture(60_000, 20);
    expect(budget.deadline).toBe(60_020 + GRACE);
  });

  test("the first observed claim cannot exceed the absolute lifecycle ceiling", () => {
    const budget = new SandboxTransitionWaitBudget(25, 100);
    budget.observeCapture(MAX_WAIT, 500);
    expect(budget.deadline).toBe(100 + MAX_WAIT);
  });
});
