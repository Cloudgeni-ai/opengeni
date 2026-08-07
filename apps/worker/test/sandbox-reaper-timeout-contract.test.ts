import { describe, expect, test } from "bun:test";
import { sandboxArchiveCaptureTimeoutMs } from "@opengeni/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertSandboxReaperActivityTimeout,
  assertSandboxReaperWorkerConfiguration,
} from "../src/sandbox-reaper-timeout";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
  SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS,
  sandboxReaperDrainCapacity,
  sandboxReaperDrainableBatch,
  sandboxReaperDrainSlotMs,
} from "../src/sandbox-reaper-contract";

describe("sandbox reaper activity timeout contract", () => {
  test("outlives the production snapshot fence and cleanup margin", () => {
    const settings = { sandboxSnapshotTimeoutMs: 10 * 60_000 };
    const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
    const requiredMs =
      SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS +
      sandboxReaperDrainSlotMs(captureTimeoutMs) +
      SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;

    expect(SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS).toBeGreaterThan(requiredMs);
    expect(() => assertSandboxReaperActivityTimeout(settings)).not.toThrow();
  });

  test("derives multi-row default throughput from the configured capture budget", () => {
    const settings = { sandboxSnapshotTimeoutMs: 60_000 };
    const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
    const rows = Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }));

    expect(captureTimeoutMs).toBe(2 * 60_000);
    expect(SANDBOX_REAPER_PER_DRAIN_OVERHEAD_MS).toBe(2 * 60_000);
    expect(sandboxReaperDrainCapacity(captureTimeoutMs)).toBe(13);
    expect(sandboxReaperDrainableBatch(rows, captureTimeoutMs, 0)).toEqual(rows.slice(0, 13));
    expect(rows).toHaveLength(20);
  });

  test("near-boundary configuration admits one drain and then fails closed", () => {
    const allowed = { sandboxSnapshotTimeoutMs: 26 * 60_000 };
    const rejected = { sandboxSnapshotTimeoutMs: 27 * 60_000 };

    expect(sandboxReaperDrainCapacity(sandboxArchiveCaptureTimeoutMs(allowed))).toBe(1);
    expect(() => assertSandboxReaperActivityTimeout(allowed)).not.toThrow();
    expect(() => assertSandboxReaperActivityTimeout(rejected)).toThrow(
      "must strictly exceed the prelude reserve, one durable archive capture fence",
    );
  });

  test("refuses to begin a capture after the real prelude consumes its reserve", () => {
    const settings = { sandboxSnapshotTimeoutMs: 60_000 };
    const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings);
    const rows = [{ id: "first" }, { id: "second" }];

    expect(
      sandboxReaperDrainableBatch(
        rows,
        captureTimeoutMs,
        SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS - 1,
      ),
    ).toEqual(rows);
    expect(
      sandboxReaperDrainableBatch(
        rows,
        captureTimeoutMs,
        SANDBOX_REAPER_ACTIVITY_PRELUDE_RESERVE_MS,
      ),
    ).toEqual([]);
  });

  test("every control worker validates even when it does not own schedules", () => {
    const rejected = { sandboxSnapshotTimeoutMs: 27 * 60_000 };

    expect(() => assertSandboxReaperWorkerConfiguration("control", rejected)).toThrow(
      "Sandbox reaper activity timeout",
    );
    expect(() => assertSandboxReaperWorkerConfiguration("turn", rejected)).not.toThrow();
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
    const contractSource = readFileSync(
      fileURLToPath(new URL("../src/sandbox-reaper-contract.ts", import.meta.url)),
      "utf8",
    );

    expect(workflowSource).toContain("startToCloseTimeout: SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS");
    expect(workflowSource).not.toContain('startToCloseTimeout: "5 minutes"');
    expect(workerSource).toContain(
      "assertSandboxReaperWorkerConfiguration(options.role, settings)",
    );
    expect(activitySource).toContain("assertSandboxReaperActivityTimeout(settings);");
    expect(activitySource).toContain("Date.now() - activityStartedAtMs");
    expect(activitySource).toContain("sandboxReaperDrainableBatch(");
    expect(contractSource).not.toContain("@opengeni/config");
  });
});
