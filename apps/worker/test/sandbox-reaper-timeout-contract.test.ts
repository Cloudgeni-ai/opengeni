import { describe, expect, test } from "bun:test";
import { sandboxArchiveCaptureTimeoutMs } from "@opengeni/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertSandboxReaperActivityTimeout,
  sandboxReaperDrainCapacity,
  sandboxReaperPreludeAllowsCapture,
} from "../src/sandbox-reaper-timeout";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
  SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS,
  sandboxReaperDrainableBatch,
} from "../src/sandbox-reaper-contract";

describe("sandbox reaper activity timeout contract", () => {
  test("outlives the production snapshot fence and cleanup margin", () => {
    const settings = { sandboxSnapshotTimeoutMs: 10 * 60_000 };
    const capacity = sandboxReaperDrainCapacity(settings);
    const requiredMs =
      SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS +
      (sandboxArchiveCaptureTimeoutMs(settings) + SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS) * capacity +
      SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;

    expect(SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS).toBeGreaterThan(requiredMs);
    expect(capacity).toBe(2);
    expect(() => assertSandboxReaperActivityTimeout(settings)).not.toThrow();
  });

  test("derives capture throughput from the configured provider fence", () => {
    const rows = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const defaultCapacity = sandboxReaperDrainCapacity({ sandboxSnapshotTimeoutMs: 60_000 });
    const expensiveCapacity = sandboxReaperDrainCapacity({
      sandboxSnapshotTimeoutMs: 10 * 60_000,
    });

    expect(defaultCapacity).toBe(18);
    expect(expensiveCapacity).toBe(2);
    expect(sandboxReaperDrainableBatch(rows, defaultCapacity)).toEqual(rows);
    expect(sandboxReaperDrainableBatch(rows, expensiveCapacity)).toEqual([
      { id: "first" },
      { id: "second" },
    ]);
    expect(rows).toHaveLength(3);
  });

  test("fails closed when one capture cannot fit after every reserved phase", () => {
    const allowed = { sandboxSnapshotTimeoutMs: 26 * 60_000 };
    const rejected = { sandboxSnapshotTimeoutMs: 27 * 60_000 };

    expect(sandboxReaperDrainCapacity(allowed)).toBe(1);
    expect(sandboxReaperDrainCapacity(rejected)).toBe(0);
    expect(() => assertSandboxReaperActivityTimeout(allowed)).not.toThrow();
    expect(() => assertSandboxReaperActivityTimeout(rejected)).toThrow(
      "must strictly exceed the prelude budget, one durable archive capture fence",
    );
  });

  test("never starts provider capture after the actual prelude budget is spent", () => {
    const startedAtMs = 1_000;

    expect(
      sandboxReaperPreludeAllowsCapture(
        startedAtMs,
        startedAtMs + SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS - 1,
      ),
    ).toBe(true);
    expect(
      sandboxReaperPreludeAllowsCapture(
        startedAtMs,
        startedAtMs + SANDBOX_REAPER_ACTIVITY_PRELUDE_BUDGET_MS,
      ),
    ).toBe(false);
  });

  test("wires the shared timeout into workflow execution and startup validation", () => {
    const workflowSource = readFileSync(
      fileURLToPath(new URL("../src/workflows/sandbox-reaper.ts", import.meta.url)),
      "utf8",
    );
    const workerSource = readFileSync(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    const activitySource = readFileSync(
      fileURLToPath(new URL("../src/activities/sandbox-lease.ts", import.meta.url)),
      "utf8",
    );

    expect(workflowSource).toContain("startToCloseTimeout: SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS");
    expect(workflowSource).not.toContain('startToCloseTimeout: "5 minutes"');
    const workerFactoryStart = workerSource.indexOf("export async function createOpenGeniWorker(");
    const workerFactoryValidation = workerSource.indexOf(
      "assertSandboxReaperActivityTimeout(settings);",
      workerFactoryStart,
    );
    const temporalConnection = workerSource.indexOf(
      'retryStartupDependency(\n        "Temporal"',
      workerFactoryStart,
    );
    expect(workerFactoryValidation).toBeGreaterThan(workerFactoryStart);
    expect(workerFactoryValidation).toBeLessThan(temporalConnection);
    expect(activitySource).toContain("sandboxReaperDrainCapacity(settings)");
    expect(activitySource).toContain("sandboxReaperPreludeAllowsCapture(");
    expect(activitySource).toContain("monotonicNowMs(),");
  });
});
