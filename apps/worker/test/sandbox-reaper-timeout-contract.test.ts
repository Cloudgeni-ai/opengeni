import { describe, expect, test } from "bun:test";
import { sandboxArchiveCaptureTimeoutMs } from "@opengeni/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSandboxReaperActivityTimeout } from "../src/sandbox-reaper-timeout";
import {
  SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS,
} from "../src/workflows/sandbox-reaper-contract";

describe("sandbox reaper activity timeout contract", () => {
  test("outlives the production snapshot fence and cleanup margin", () => {
    const settings = { sandboxSnapshotTimeoutMs: 10 * 60_000 };
    const requiredMs =
      sandboxArchiveCaptureTimeoutMs(settings) + SANDBOX_REAPER_ACTIVITY_CLEANUP_MARGIN_MS;

    expect(SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS).toBeGreaterThan(requiredMs);
    expect(() => assertSandboxReaperActivityTimeout(settings)).not.toThrow();
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

    expect(workflowSource).toContain("startToCloseTimeout: SANDBOX_REAPER_ACTIVITY_TIMEOUT_MS");
    expect(workflowSource).not.toContain('startToCloseTimeout: "5 minutes"');
    expect(workerSource).toContain("assertSandboxReaperActivityTimeout(settings);");
  });
});
