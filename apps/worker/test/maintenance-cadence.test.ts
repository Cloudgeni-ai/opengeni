import { describe, expect, test } from "bun:test";
import { SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL } from "@opengeni/core";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { ScheduleNotFoundError, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  deleteLegacyMaintenanceSchedules,
  INTERNAL_MAINTENANCE_JOBS,
  internalMaintenanceCadences,
  KNOWLEDGE_INDEXING_PERIOD_MS,
  SITE_AUTH_MAINTENANCE_PERIOD_MS,
  startMaintenanceWorkflowOnce,
} from "../src/internal-maintenance";
import { startMaintenanceCadences, type MaintenanceCadence } from "../src/maintenance-cadence";
import { modalOrphanSweepMayHaveWork } from "../src/activities/sandbox-lease";
import { browserDeadlineCheckpointTaskQueue } from "../src/browser-deadline-checkpoint-contract";
import { sessionWorkflowWakeDispatchRequestedSignal } from "../src/workflows/workflow-wake";
import { deferred, flushTelemetry, telemetryClock } from "./fixtures/telemetry-clock";

function observability() {
  return createObservability(testSettings(), { component: "worker-control" });
}

function counter(metrics: string, job: string, outcome: string): number {
  const line = metrics
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith("opengeni_maintenance_cadence_ticks_total{") &&
        candidate.includes(`job="${job}"`) &&
        candidate.includes(`outcome="${outcome}"`),
    );
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : Number.NaN;
}

function cadence(overrides: Partial<MaintenanceCadence> = {}) {
  const calls = { hasWork: 0, start: 0 };
  const value: MaintenanceCadence = {
    job: "test-job",
    periodMs: 1_000,
    hasWork: async () => {
      calls.hasWork += 1;
      return false;
    },
    start: async () => {
      calls.start += 1;
      return "started";
    },
    ...overrides,
  };
  return { value, calls };
}

describe("maintenance cadence", () => {
  test("an idle tick checks for work and starts no workflow", async () => {
    const obs = observability();
    const job = cadence();
    const cadences = startMaintenanceCadences({
      cadences: [job.value],
      observability: obs,
      autoStart: false,
    });
    expect(await cadences.tick("test-job")).toBe("idle");
    expect(await cadences.tick("test-job")).toBe("idle");
    expect(job.calls).toEqual({ hasWork: 2, start: 0 });
    const metrics = await obs.prometheusMetrics();
    expect(counter(metrics, "test-job", "idle")).toBe(2);
    expect(counter(metrics, "test-job", "started")).toBe(0);
    expect(metrics).toContain(
      'opengeni_maintenance_cadence_last_success_timestamp_seconds{job="test-job",',
    );
    await cadences.close();
  });

  test("a tick with work starts the workflow, and a running one is reported", async () => {
    const obs = observability();
    let result: "started" | "already_running" = "started";
    const job = cadence({ hasWork: async () => true, start: async () => result });
    const cadences = startMaintenanceCadences({
      cadences: [job.value],
      observability: obs,
      autoStart: false,
    });
    expect(await cadences.tick("test-job")).toBe("started");
    result = "already_running";
    expect(await cadences.tick("test-job")).toBe("already_running");
    const metrics = await obs.prometheusMetrics();
    expect(counter(metrics, "test-job", "started")).toBe(1);
    expect(counter(metrics, "test-job", "already_running")).toBe(1);
    await cadences.close();
  });

  test("a failing work check fails open and still starts the workflow", async () => {
    const obs = observability();
    const job = cadence({
      hasWork: async () => {
        throw new Error("database unavailable");
      },
    });
    const cadences = startMaintenanceCadences({
      cadences: [job.value],
      observability: obs,
      autoStart: false,
    });
    expect(await cadences.tick("test-job")).toBe("probe_failed");
    expect(job.calls.start).toBe(1);
    expect(counter(await obs.prometheusMetrics(), "test-job", "probe_failed")).toBe(1);
    await cadences.close();
  });

  test("a failed start is counted and does not refresh the success timestamp", async () => {
    const obs = observability();
    const job = cadence({
      hasWork: async () => true,
      start: async () => {
        throw new Error("temporal unavailable");
      },
    });
    const cadences = startMaintenanceCadences({
      cadences: [job.value],
      observability: obs,
      autoStart: false,
    });
    expect(await cadences.tick("test-job")).toBe("start_failed");
    const metrics = await obs.prometheusMetrics();
    expect(counter(metrics, "test-job", "start_failed")).toBe(1);
    expect(metrics).not.toContain(
      'opengeni_maintenance_cadence_last_success_timestamp_seconds{job="test-job",',
    );
    await cadences.close();
  });

  test("an overlapping tick is busy, and close waits for the tick in flight", async () => {
    const obs = observability();
    const gate = deferred<boolean>();
    const job = cadence({ hasWork: async () => await gate.promise });
    const cadences = startMaintenanceCadences({
      cadences: [job.value],
      observability: obs,
      autoStart: false,
    });
    const first = cadences.tick("test-job");
    expect(await cadences.tick("test-job")).toBe("busy");
    let closed = false;
    const closing = cadences.close().then(() => {
      closed = true;
    });
    await flushTelemetry();
    expect(closed).toBe(false);
    gate.resolve(false);
    expect(await first).toBe("idle");
    await closing;
    expect(closed).toBe(true);
  });

  test("ticks immediately on start and then once per unchanged period", async () => {
    const clock = telemetryClock();
    const job = cadence({ periodMs: 10_000 });
    // Let each tick settle completely so the next period is not "busy".
    const settle = async () => await new Promise((resolve) => setTimeout(resolve, 0));
    const cadences = startMaintenanceCadences({
      cadences: [job.value],
      observability: observability(),
      scheduler: clock.scheduler,
      now: clock.now,
    });
    await settle();
    expect(job.calls.hasWork).toBe(1);
    clock.advance(9_999);
    await settle();
    expect(job.calls.hasWork).toBe(1);
    clock.advance(1);
    await settle();
    expect(job.calls.hasWork).toBe(2);
    for (let period = 0; period < 3; period += 1) {
      clock.advance(10_000);
      await settle();
    }
    expect(job.calls.hasWork).toBe(5);
    await cadences.close();
    expect(clock.timers()).toBe(0);
    clock.advance(60_000);
    await settle();
    expect(job.calls.hasWork).toBe(5);
  });

  test("rejects duplicate jobs and invalid periods", () => {
    const obs = observability();
    expect(() =>
      startMaintenanceCadences({
        cadences: [cadence().value, cadence().value],
        observability: obs,
        autoStart: false,
      }),
    ).toThrow("duplicate maintenance cadence test-job");
    expect(() =>
      startMaintenanceCadences({
        cadences: [cadence({ periodMs: 0 }).value],
        observability: obs,
        autoStart: false,
      }),
    ).toThrow("must be a positive integer");
  });
});

describe("internal maintenance jobs", () => {
  const settings = testSettings();
  const fakeDb = {} as never;

  test("keep every replaced Schedule's period", async () => {
    const cadences = await internalMaintenanceCadences({
      settings,
      observability: observability(),
      db: fakeDb,
      workflow: { start: async () => undefined, signalWithStart: async () => undefined } as never,
    });
    expect(Object.fromEntries(cadences.map((c) => [c.job, c.periodMs]))).toEqual({
      "session-workflow-wake-dispatcher": 10_000,
      "knowledge-indexing": KNOWLEDGE_INDEXING_PERIOD_MS,
      "site-auth-maintenance": SITE_AUTH_MAINTENANCE_PERIOD_MS,
      // The old reaper Schedule's period, which the boot invariants validate.
      "sandbox-lease-reaper": settings.sandboxLeaseReaperPeriodMs,
      "sandbox-idle-checkpoint": settings.sandboxLeaseReaperPeriodMs,
      "browser-deadline-checkpoint": settings.sandboxLeaseReaperPeriodMs,
    });
    expect(KNOWLEDGE_INDEXING_PERIOD_MS).toBe(15_000);
    expect(SITE_AUTH_MAINTENANCE_PERIOD_MS).toBe(60_000);
    expect(settings.sandboxLeaseReaperPeriodMs).toBeLessThan(settings.sandboxViewerHolderTtlMs);
  });

  test("each sandbox job starts its unchanged fixed-id workflow on its own queue", async () => {
    const started: Array<{ type: string; workflowId: string; taskQueue: string }> = [];
    const cadences = await internalMaintenanceCadences({
      settings,
      observability: observability(),
      db: fakeDb,
      jobs: ["sandbox-lease-reaper", "sandbox-idle-checkpoint", "browser-deadline-checkpoint"],
      workflow: {
        start: async (type: string, options: { workflowId: string; taskQueue: string }) => {
          started.push({ type, workflowId: options.workflowId, taskQueue: options.taskQueue });
        },
      } as never,
    });
    for (const job of cadences) expect(await job.start()).toBe("started");
    const queue = settings.temporalTaskQueue;
    expect(started).toEqual([
      {
        type: "sandboxReaperWorkflowV2",
        workflowId: "opengeni-sandbox-lease-reaper-v2",
        taskQueue: `${queue}-sandbox-lifecycle-v1`,
      },
      {
        type: "sandboxIdleCheckpointSweepWorkflow",
        workflowId: "opengeni-sandbox-idle-checkpoints-v1",
        taskQueue: `${queue}-sandbox-lifecycle-v1`,
      },
      {
        type: "browserDeadlineCheckpointSweepWorkflow",
        workflowId: "opengeni-browser-deadline-checkpoints-v1",
        taskQueue: browserDeadlineCheckpointTaskQueue(queue),
      },
    ]);
  });

  test("the idle checkpoint sweep has no work while ownership or snapshots are off", async () => {
    for (const off of [{ sandboxOwnershipEnabled: false }, { sandboxSnapshotIntervalMs: 0 }]) {
      const [idle] = await internalMaintenanceCadences({
        settings: { ...settings, sandboxOwnershipEnabled: true, ...off },
        observability: observability(),
        // Never read: the inventory it previews is empty by configuration.
        db: fakeDb,
        jobs: ["sandbox-idle-checkpoint"],
        workflow: {} as never,
      });
      expect(await idle!.hasWork()).toBe(false);
    }
  });

  test("knowledge indexing has no work and reads nothing without an embedding credential", async () => {
    const embedder = (available: boolean | undefined) => ({
      model: "index-test-model",
      dimensions: 3,
      ...(available === undefined ? {} : { available }),
      embedMany: async () => [],
      embedQuery: async () => [],
    });
    const warnings: Array<{ message: string; fields: unknown }> = [];
    const obs = Object.assign(observability(), {
      warn: (message: string, fields?: unknown) => {
        warnings.push({ message, fields });
      },
    });
    const [blocked] = await internalMaintenanceCadences({
      settings,
      observability: obs,
      // Never read: queued jobs cannot be embedded by this process.
      db: fakeDb,
      jobs: ["knowledge-indexing"],
      documentServices: { embedder: embedder(false) } as never,
      workflow: {} as never,
    });
    for (let tick = 0; tick < 3; tick += 1) expect(await blocked!.hasWork()).toBe(false);
    expect(warnings).toEqual([
      {
        message: "Knowledge indexing is idle: no document embedding credential is configured",
        fields: { job: "knowledge-indexing", model: "index-test-model" },
      },
    ]);

    // An available embedder (explicitly, or by omission) keeps the queue check.
    for (const available of [true, undefined]) {
      const reads: unknown[] = [];
      const [ready] = await internalMaintenanceCadences({
        settings,
        observability: observability(),
        db: {
          execute: async (query: unknown) => {
            reads.push(query);
            return [{ due: true }];
          },
        } as never,
        jobs: ["knowledge-indexing"],
        documentServices: { embedder: embedder(available) } as never,
        workflow: {} as never,
      });
      expect(await ready!.hasWork()).toBe(true);
      expect(reads).toHaveLength(1);
    }
  });

  test("the Modal orphan sweep has work only while the provider app runs a box", async () => {
    const unused = async () => {
      throw new Error("Modal must not be called");
    };
    expect(
      await modalOrphanSweepMayHaveWork({
        settings: { ...settings, sandboxBackend: "docker", modalTokenId: "", modalTokenSecret: "" },
        observability: observability(),
        hasRunningSandboxes: unused,
      }),
    ).toBe(false);
    const modal = { ...settings, sandboxBackend: "modal" as const };
    expect(
      await modalOrphanSweepMayHaveWork({
        settings: modal,
        observability: observability(),
        hasRunningSandboxes: async () => true,
      }),
    ).toBe(true);
    // An empty app is the sweep's complete, empty inventory, projected as such.
    const projected = observability();
    expect(
      await modalOrphanSweepMayHaveWork({
        settings: modal,
        observability: projected,
        hasRunningSandboxes: async () => false,
      }),
    ).toBe(false);
    const metrics = await projected.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_modal_sandbox_inventory\{state="running",[^}]*\} 0\n/);
    expect(metrics).toMatch(
      /opengeni_sandbox_inventory_refresh_timestamp_seconds\{domain="modal_provider",/,
    );
    await expect(
      modalOrphanSweepMayHaveWork({
        settings: modal,
        observability: observability(),
        hasRunningSandboxes: async () => {
          throw new Error("Modal unavailable");
        },
      }),
    ).rejects.toThrow("Modal unavailable");
  });

  test("the wake dispatcher is signal-with-started on one fixed execution", async () => {
    const calls: unknown[] = [];
    const [wake] = await internalMaintenanceCadences({
      settings,
      observability: observability(),
      db: fakeDb,
      jobs: ["session-workflow-wake-dispatcher"],
      workflow: {
        start: async () => {
          throw new Error("unexpected start");
        },
        signalWithStart: async (type: string, options: unknown) => {
          calls.push({ type, options });
        },
      } as never,
    });
    expect(await wake!.start()).toBe("started");
    expect(calls).toEqual([
      {
        type: "sessionWorkflowWakeDispatcherWorkflow",
        options: {
          taskQueue: settings.temporalTaskQueue,
          workflowId: "opengeni-session-workflow-wake-dispatcher",
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [],
          signal: "dispatchRequested",
        },
      },
    ]);
  });

  test("the workflow's signal is the contract signal name", () => {
    expect(sessionWorkflowWakeDispatchRequestedSignal.name).toBe(
      SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL,
    );
  });

  test("starting a job that is already running is not an error", async () => {
    const started: unknown[] = [];
    const workflow = {
      start: async (type: string, options: unknown) => {
        started.push({ type, options });
      },
    } as never;
    expect(
      await startMaintenanceWorkflowOnce(workflow, {
        workflowType: "knowledgeIndexingWorkflow",
        workflowId: "opengeni-knowledge-indexing",
        taskQueue: "q",
      }),
    ).toBe("started");
    expect(started).toEqual([
      {
        type: "knowledgeIndexingWorkflow",
        options: {
          taskQueue: "q",
          workflowId: "opengeni-knowledge-indexing",
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [],
        },
      },
    ]);
    const running = {
      start: async () => {
        throw new WorkflowExecutionAlreadyStartedError(
          "already started",
          "opengeni-knowledge-indexing",
          "knowledgeIndexingWorkflow",
        );
      },
    } as never;
    expect(
      await startMaintenanceWorkflowOnce(running, {
        workflowType: "knowledgeIndexingWorkflow",
        workflowId: "opengeni-knowledge-indexing",
        taskQueue: "q",
      }),
    ).toBe("already_running");
    const broken = {
      start: async () => {
        throw new Error("unavailable");
      },
    } as never;
    await expect(
      startMaintenanceWorkflowOnce(broken, {
        workflowType: "knowledgeIndexingWorkflow",
        workflowId: "opengeni-knowledge-indexing",
        taskQueue: "q",
      }),
    ).rejects.toThrow("unavailable");
  });

  test("legacy per-tick Schedules are deleted, and absent ones are fine", async () => {
    const deleted: string[] = [];
    await deleteLegacyMaintenanceSchedules(
      {
        getHandle: (id: string) => ({
          delete: async () => {
            if (id === "opengeni-knowledge-indexing") {
              throw new ScheduleNotFoundError("not found", id);
            }
            deleted.push(id);
          },
        }),
      },
      INTERNAL_MAINTENANCE_JOBS,
      observability(),
    );
    expect(deleted).toEqual([
      "opengeni-session-workflow-wake-dispatcher",
      "opengeni-site-auth-maintenance",
      "opengeni-sandbox-lease-reaper",
    ]);
    await expect(
      deleteLegacyMaintenanceSchedules(
        {
          getHandle: () => ({
            delete: async () => {
              throw new Error("permission denied");
            },
          }),
        },
        ["site-auth-maintenance"],
        observability(),
      ),
    ).rejects.toThrow("permission denied");
  });
});
