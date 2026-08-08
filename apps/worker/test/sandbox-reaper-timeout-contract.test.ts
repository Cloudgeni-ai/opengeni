import { describe, expect, test } from "bun:test";
import { sandboxArchiveCaptureTimeoutMs } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import {
  assertSandboxDrainInputTiming,
  assertSandboxReaperActivityTimeout,
  sandboxDrainTiming,
} from "../src/sandbox-reaper-timeout";
import { sandboxDrainCaptureId } from "../src/activities/sandbox-lease";
import {
  SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS,
  SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS,
  SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS,
  SANDBOX_REAPER_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
  SANDBOX_REAPER_CHILD_DISPATCH_LIMIT,
  SANDBOX_REAPER_MAINTENANCE_WORKFLOW_ID,
  SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS,
  sandboxDrainActivityTimeoutMs,
  sandboxDrainTimeoutClass,
  sandboxDrainWorkflowId,
  sandboxLifecycleTaskQueue,
} from "../src/sandbox-reaper-contract";

describe("sandbox reaper per-box timeout contract", () => {
  test("normal captures use the short per-box activity", () => {
    const settings = { sandboxSnapshotTimeoutMs: 60_000 };
    const timing = sandboxDrainTiming(settings);

    expect(timing).toEqual({
      snapshotTimeoutMs: settings.sandboxSnapshotTimeoutMs,
      captureTimeoutMs: sandboxArchiveCaptureTimeoutMs(settings),
      timeoutClass: "fast",
      activityTimeoutMs: SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS,
    });
    expect(timing.captureTimeoutMs + SANDBOX_DRAIN_SETTLEMENT_MARGIN_MS).toBeLessThan(
      timing.activityTimeoutMs,
    );
    expect(() => assertSandboxReaperActivityTimeout(settings)).not.toThrow();
  });

  test("only an unusually large capture gets the isolated extended budget", () => {
    const settings = { sandboxSnapshotTimeoutMs: 30 * 60_000 };
    const timing = sandboxDrainTiming(settings);

    expect(timing.captureTimeoutMs).toBe(30 * 60_000 + 10_000);
    expect(timing.timeoutClass).toBe("extended");
    expect(timing.activityTimeoutMs).toBe(SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS);
    expect(() => assertSandboxReaperActivityTimeout(settings)).not.toThrow();
    expect(sandboxDrainTimeoutClass(60_000)).toBe("fast");
    expect(sandboxDrainActivityTimeoutMs("extended")).toBe(
      SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS,
    );
  });

  test("a child freezes a self-consistent provider budget across redeploys", () => {
    expect(() =>
      assertSandboxDrainInputTiming({
        timeoutClass: "fast",
        snapshotTimeoutMs: 60_000,
        captureTimeoutMs: 120_000,
      }),
    ).not.toThrow();
    // This is intentionally not the formula the current binary derives from a
    // 60s provider budget. A durable child freezes both values; a later binary
    // validates their safety relationship instead of re-deriving old input.
    expect(() =>
      assertSandboxDrainInputTiming({
        timeoutClass: "fast",
        snapshotTimeoutMs: 60_000,
        captureTimeoutMs: 100_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertSandboxDrainInputTiming({
        timeoutClass: "fast",
        snapshotTimeoutMs: 10 * 60_000,
        captureTimeoutMs: 120_000,
      }),
    ).toThrow("inconsistent with the fast activity budget");
    expect(() =>
      assertSandboxDrainInputTiming({
        timeoutClass: "extended",
        snapshotTimeoutMs: 60 * 60_000,
        captureTimeoutMs: 60 * 60_000,
      }),
    ).toThrow("timeout values are invalid");
    expect(() =>
      assertSandboxDrainInputTiming({
        timeoutClass: "extended",
        snapshotTimeoutMs: 59 * 60_000,
        captureTimeoutMs: 61 * 60_000,
      }),
    ).toThrow("timeout values are invalid");
  });

  test("exact workspace/group/epoch identity deduplicates only a live attempt", () => {
    const target = {
      workspaceId: "workspace-a",
      sandboxGroupId: "group-b",
      instanceId: "instance-c",
      leaseEpoch: 17,
    };
    expect(sandboxDrainWorkflowId(target)).toBe("sandbox-drain:workspace-a:group-b:17");
    expect(sandboxDrainWorkflowId({ ...target, leaseEpoch: 18 })).not.toBe(
      sandboxDrainWorkflowId(target),
    );
  });

  test("the lifecycle queue is stable and idempotent", () => {
    expect(SANDBOX_REAPER_CHILD_DISPATCH_LIMIT).toBe(500);
    expect(SANDBOX_REAPER_MAINTENANCE_WORKFLOW_ID).toBe("opengeni-sandbox-lease-maintenance-v1");
    expect(sandboxLifecycleTaskQueue("opengeni-runs-ts")).toBe(
      "opengeni-runs-ts-sandbox-lifecycle-v1",
    );
    expect(sandboxLifecycleTaskQueue("opengeni-runs-ts-sandbox-lifecycle-v1")).toBe(
      "opengeni-runs-ts-sandbox-lifecycle-v1",
    );
  });

  test("capture receipts are stable per logical operation and distinct per retry", () => {
    const operationId = "A3ECA6A6-BA96-4A71-AC8F-B9E3C5800EE9";
    expect(sandboxDrainCaptureId(operationId, 1)).toBe(operationId.toLowerCase());
    expect(sandboxDrainCaptureId(operationId, 2)).toBe(
      sandboxDrainCaptureId(operationId.toLowerCase(), 2),
    );
    expect(sandboxDrainCaptureId(operationId, 2)).not.toBe(sandboxDrainCaptureId(operationId, 3));
    expect(sandboxDrainCaptureId(operationId, 2)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() => sandboxDrainCaptureId("not-a-uuid", 1)).toThrow("operation id is invalid");
    expect(() => sandboxDrainCaptureId(operationId, 0)).toThrow("attempt is invalid");
  });

  test("the legacy activity command routes production runs without touching the database", async () => {
    const settings = testSettings();
    const observability = createObservability(settings, {
      component: "reaper-router-test",
    });
    let starts = 0;
    const services = async (): Promise<ActivityServices> => ({
      settings,
      db: null as never,
      bus: null as never,
      runtime: null as never,
      objectStorage: null,
      documentServices: null as never,
      observability,
      wakeSessionWorkflow: null,
      startSandboxReaperWorkflow: async () => {
        starts += 1;
        return "started";
      },
    });

    const result = await createSandboxLeaseActivities(services).reapSandboxLeases();

    expect(starts).toBe(1);
    expect(result).toEqual({
      examined: 0,
      terminated: 0,
      skipped: 0,
      metered: 0,
      forceDrained: 0,
      modalOrphansTerminated: 0,
    });
  });

  test("wires bounded scan work and independent parallel children", () => {
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

    expect(SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS).toBe(5 * 60_000);
    expect(SANDBOX_REAPER_ACTIVITY_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS).toBe(20_000);
    expect(workflowSource).toContain(
      "startToCloseTimeout: SANDBOX_REAPER_SCAN_ACTIVITY_TIMEOUT_MS",
    );
    expect(workflowSource).toContain(
      "heartbeatTimeout: SANDBOX_REAPER_ACTIVITY_HEARTBEAT_TIMEOUT_MS",
    );
    const sweepProxySource = workflowSource.slice(
      workflowSource.indexOf("function sweepActivities("),
      workflowSource.indexOf("function maintenanceActivity("),
    );
    expect(sweepProxySource).toContain('initialInterval: "1 second"');
    expect(sweepProxySource).not.toContain("maximumAttempts");
    const maintenanceProxySource = workflowSource.slice(
      workflowSource.indexOf("function maintenanceActivity("),
      workflowSource.indexOf("function drainActivity("),
    );
    expect(maintenanceProxySource).toContain("maximumAttempts: 1");
    expect(workflowSource).toMatch(
      /drainActivity\(\s*SANDBOX_DRAIN_FAST_ACTIVITY_TIMEOUT_MS,?\s*\)/,
    );
    expect(workflowSource).toMatch(
      /drainActivity\(\s*SANDBOX_DRAIN_EXTENDED_ACTIVITY_TIMEOUT_MS,?\s*\)/,
    );
    const drainProxySource = workflowSource.slice(
      workflowSource.indexOf("function drainActivity("),
      workflowSource.indexOf("// This proxy and workflow deliberately preserve"),
    );
    expect(drainProxySource).toContain('initialInterval: "1 second"');
    expect(drainProxySource).toContain('maximumInterval: "30 seconds"');
    expect(drainProxySource).not.toContain("maximumAttempts");
    expect(workflowSource).toContain("operationId: uuid4()");
    expect(workflowSource).toContain("taskQueue: lifecycleTaskQueue()");
    expect(workflowSource).toContain("export async function sandboxReaperWorkflowV2()");
    expect(workflowSource).toContain("await Promise.all(");
    expect(workflowSource).toContain("await startChild(sandboxDrainWorkflow");
    expect(workflowSource).toContain("await startChild(sandboxReaperMaintenanceWorkflow");
    expect(workflowSource).toContain("parentClosePolicy: ParentClosePolicy.ABANDON");
    expect(workflowSource).toContain("await legacyReaperActivity.reapSandboxLeases()");
    expect(workflowSource).not.toContain("patched(");
    expect(workflowSource).not.toContain("SANDBOX_REAPER_V2_WORKFLOW_ID");

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
    expect(workerSource).toContain("taskQueue: settings.temporalTaskQueue");
    expect(workerSource).toContain(
      "taskQueue: sandboxLifecycleTaskQueue(settings.temporalTaskQueue)",
    );
    expect(workerSource).toContain("combineWorkerRunTargets([worker, sandboxLifecycleWorker])");
    expect(workerSource).toContain('temporal.workflow.start("sandboxReaperWorkflowV2"');
    expect(workerSource).toContain("workflowId: SANDBOX_REAPER_V2_WORKFLOW_ID");
    expect(workerSource).toContain("Reconciled the global sandbox-lease reaper Schedule");
    expect(workerSource).toContain("Never move this action off the base queue");
    expect(activitySource).toContain("async function prepareSandboxLeaseSweep()");
    expect(activitySource).toContain("async function drainSandboxLease(");
    expect(activitySource).toContain("captureTimeoutMs: input.captureTimeoutMs");
    expect(activitySource).toContain("const captureTimeoutMs = attempt.captureTimeoutMs");
    expect(activitySource).not.toContain(
      "const captureTimeoutMs = sandboxArchiveCaptureTimeoutMs(settings)",
    );
    expect(activitySource).toContain("startSandboxReaperHeartbeat({");
    expect(activitySource).toContain("context.heartbeat({ ...details");
    expect(activitySource).toContain("await Promise.allSettled(");
    expect(activitySource).not.toContain("for (const row of drainable)");

    const prepareStart = activitySource.indexOf("async function prepareSandboxLeaseSweep()");
    const drainStart = activitySource.indexOf("async function drainSandboxLease(", prepareStart);
    const prepareSource = activitySource.slice(prepareStart, drainStart);
    expect(prepareSource).toContain("await requestDueSandboxRotationsGlobal(");
    expect(prepareSource).toContain("await reapStaleLeaseHoldersGlobal(");
    expect(prepareSource).not.toContain("accrueWarmTick(");
    expect(prepareSource).not.toContain("reconcileTerminalRetainedProcesses(");
    expect(prepareSource).not.toContain("sweepModalOrphans(");
    expect(prepareSource).not.toContain("refreshQueueLeaseAndCreditGauges(");

    const childStart = workflowSource.indexOf("await startChild(sandboxDrainWorkflow");
    const maintenanceStart = workflowSource.indexOf(
      "await startChild(sandboxReaperMaintenanceWorkflow",
    );
    expect(childStart).toBeGreaterThan(-1);
    expect(maintenanceStart).toBeGreaterThan(childStart);
    expect(workflowSource).toContain("parentClosePolicy: ParentClosePolicy.ABANDON");
    expect(workflowSource).toContain("sandbox reaper maintenance child start deferred");
  });
});
