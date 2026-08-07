import { describe, expect, test } from "bun:test";
import { sandboxArchiveCaptureTimeoutMs } from "@opengeni/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSandboxReaperActivityTimeout } from "../src/sandbox-reaper-timeout";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_MAX_DRAINABLE_BOXES_PER_ACTIVITY,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
  sandboxReaperDrainableBatch,
} from "../src/sandbox-reaper-contract";

describe("sandbox reaper activity timeout contract", () => {
  test("outlives the production snapshot fence and cleanup margin", () => {
    const settings = { sandboxSnapshotTimeoutMs: 10 * 60_000 };
    const requiredMs =
      sandboxArchiveCaptureTimeoutMs(settings) * SANDBOX_REAPER_MAX_DRAINABLE_BOXES_PER_ACTIVITY +
      SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;

    expect(SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS).toBeGreaterThan(requiredMs);
    expect(() => assertSandboxReaperActivityTimeout(settings)).not.toThrow();
  });

  test("admits only one capture-bearing drain per activity timeout", () => {
    const rows = [{ id: "first" }, { id: "second" }, { id: "third" }];

    expect(SANDBOX_REAPER_MAX_DRAINABLE_BOXES_PER_ACTIVITY).toBe(1);
    expect(sandboxReaperDrainableBatch(rows)).toEqual([{ id: "first" }]);
    expect(rows).toHaveLength(3);
  });

  test("fails closed when a near-boundary snapshot budget consumes the margin", () => {
    const allowed = { sandboxSnapshotTimeoutMs: 29 * 60_000 };
    const rejected = { sandboxSnapshotTimeoutMs: 30 * 60_000 };

    expect(() => assertSandboxReaperActivityTimeout(allowed)).not.toThrow();
    expect(() => assertSandboxReaperActivityTimeout(rejected)).toThrow(
      "must strictly exceed the durable archive capture fence plus cleanup margin",
    );
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
    expect(workerSource).toContain("assertSandboxReaperActivityTimeout(settings);");
    expect(activitySource).toContain("sandboxReaperDrainableBatch(");
  });
});
