import { expect, test } from "bun:test";
import { createLogThrottle, createObservability } from "../src/index";

test("admits each key's first occurrence and reports what an interval suppressed", () => {
  let now = 1_000;
  const throttle = createLogThrottle({ intervalMs: 60_000, now: () => now });

  expect(throttle.admit("machine-a")).toEqual({ suppressedCount: 0 });
  // A different key is its own first occurrence, never hidden behind another.
  expect(throttle.admit("machine-b")).toEqual({ suppressedCount: 0 });
  for (let tick = 0; tick < 59; tick += 1) {
    now += 1_000;
    expect(throttle.admit("machine-a")).toBeNull();
  }
  now += 1_000;
  expect(throttle.admit("machine-a")).toEqual({ suppressedCount: 59 });
  // The count resets once reported.
  now += 60_000;
  expect(throttle.admit("machine-a")).toEqual({ suppressedCount: 0 });
});

test("a backwards clock never suppresses a key indefinitely", () => {
  let now = 100_000;
  const throttle = createLogThrottle({ intervalMs: 60_000, now: () => now });
  expect(throttle.admit("key")).toEqual({ suppressedCount: 0 });
  now = 10_000;
  expect(throttle.admit("key")).toEqual({ suppressedCount: 0 });
});

test("the key set is bounded by forgetting the least recently admitted key", () => {
  let now = 0;
  const throttle = createLogThrottle({ intervalMs: 60_000, maxKeys: 2, now: () => now });
  expect(throttle.admit("a")).toEqual({ suppressedCount: 0 });
  expect(throttle.admit("b")).toEqual({ suppressedCount: 0 });
  now += 1;
  expect(throttle.admit("a")).toBeNull();
  // A third key evicts "a" (admitted before "b"), which is then new again.
  expect(throttle.admit("c")).toEqual({ suppressedCount: 0 });
  expect(throttle.admit("b")).toBeNull();
  expect(throttle.admit("a")).toEqual({ suppressedCount: 0 });
});

test("suppressedCount and the closed reason survive the public structured-log projection", () => {
  const observed: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => observed.push(String(message));
  try {
    createObservability(
      {
        serviceName: "opengeni",
        environment: "test",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: false,
      },
      { component: "api" },
    ).warn("auth-callout: denied a revoked or unknown enrollment", {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      agentId: "agent-identifier",
      reason: "inactive_enrollment",
      suppressedCount: 59,
    });
  } finally {
    console.warn = originalWarn;
  }
  const line = JSON.parse(observed[0]!);
  expect(line).toMatchObject({ reason: "inactive_enrollment", suppressedCount: 59 });
  expect(line).not.toHaveProperty("workspaceId");
  expect(line).not.toHaveProperty("agentId");
});
