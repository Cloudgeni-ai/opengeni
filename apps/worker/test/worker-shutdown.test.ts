import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { createOpenGeniWorker } from "../src";
import {
  createWorkerServiceLifecycle,
  createWorkerCleanupContainment,
  WorkerForceStoppedError,
} from "../src/worker-service-lifecycle";
import {
  CONTROL_WORKER_SHUTDOWN_FORCE_MS,
  CONTROL_WORKER_SHUTDOWN_GRACE_MS,
  WORKER_PROCESS_EXIT_MARGIN_MS,
  WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS,
  armWorkerProcessExitDeadline,
  closeWithinBudget,
  resolveWorkerShutdownTiming,
  runWorkerProcessEntrypoint,
} from "../src/worker-shutdown";

// Kubernetes termination grace rendered by the Helm chart for turn workers and
// enforced by the managed deploy profile. The worker must finish inside it.
const CHART_TURN_POD_GRACE_MS = 120_000;

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("worker shutdown sequencing", () => {
  test("turn workers drain naturally for 90s, force at 105s and exit inside the pod grace", () => {
    const timing = resolveWorkerShutdownTiming("turn", testSettings());
    expect(timing).toEqual({ graceMs: 90_000, forceMs: 105_000, processExitDeadlineMs: 115_000 });
    expect(timing.forceMs - timing.graceMs).toBeGreaterThanOrEqual(
      WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS,
    );
    expect(timing.processExitDeadlineMs).toBe(timing.forceMs + WORKER_PROCESS_EXIT_MARGIN_MS);
    expect(timing.processExitDeadlineMs).toBeLessThan(CHART_TURN_POD_GRACE_MS);
  });

  test("control workers keep the original 5s natural window and 100s force time", () => {
    const timing = resolveWorkerShutdownTiming(
      "control",
      testSettings({ turnWorkerShutdownGraceMs: 1_000, turnWorkerShutdownForceMs: 20_000 }),
    );
    expect(timing).toEqual({
      graceMs: CONTROL_WORKER_SHUTDOWN_GRACE_MS,
      forceMs: CONTROL_WORKER_SHUTDOWN_FORCE_MS,
      processExitDeadlineMs: CONTROL_WORKER_SHUTDOWN_FORCE_MS + WORKER_PROCESS_EXIT_MARGIN_MS,
    });
    expect(timing.graceMs).toBe(5_000);
    expect(timing.forceMs).toBe(100_000);
    expect(timing.processExitDeadlineMs).toBeLessThan(CHART_TURN_POD_GRACE_MS);
  });

  test("configured turn timings are honoured, including an immediate checkpoint", () => {
    expect(
      resolveWorkerShutdownTiming(
        "turn",
        testSettings({ turnWorkerShutdownGraceMs: 0, turnWorkerShutdownForceMs: 40_000 }),
      ),
    ).toEqual({ graceMs: 0, forceMs: 40_000, processExitDeadlineMs: 50_000 });
    expect(
      resolveWorkerShutdownTiming(
        "turn",
        testSettings({ turnWorkerShutdownGraceMs: 240_000, turnWorkerShutdownForceMs: 280_000 }),
      ),
    ).toEqual({ graceMs: 240_000, forceMs: 280_000, processExitDeadlineMs: 290_000 });
  });

  test("a grace that would eat the checkpoint window is shortened, keeping the force time", () => {
    for (const graceMs of [100_000, 105_000, 600_000]) {
      const timing = resolveWorkerShutdownTiming(
        "turn",
        testSettings({ turnWorkerShutdownGraceMs: graceMs, turnWorkerShutdownForceMs: 105_000 }),
      );
      expect(timing).toEqual({
        graceMs: 95_000,
        forceMs: 105_000,
        processExitDeadlineMs: 115_000,
        configuredGraceMs: graceMs,
      });
    }
  });

  test("hosts whose settings predate the turn shutdown fields get the defaults", () => {
    expect(resolveWorkerShutdownTiming("turn", {})).toEqual({
      graceMs: 90_000,
      forceMs: 105_000,
      processExitDeadlineMs: 115_000,
    });
    expect(
      resolveWorkerShutdownTiming("turn", {
        turnWorkerShutdownGraceMs: Number.NaN,
        turnWorkerShutdownForceMs: -1,
      }),
    ).toEqual({ graceMs: 90_000, forceMs: 105_000, processExitDeadlineMs: 115_000 });
  });
});

describe("Temporal worker construction", () => {
  function captureWorkerCreate() {
    const created: Array<Record<string, unknown>> = [];
    const connect = spyOn(NativeConnection, "connect").mockImplementation(
      async () => ({ close: async () => undefined }) as never,
    );
    const create = spyOn(Worker, "create").mockImplementation(async (options) => {
      created.push(options as Record<string, unknown>);
      return {
        options: { namespace: options.namespace, taskQueue: options.taskQueue },
        run: async () => undefined,
        shutdown: () => undefined,
      } as never;
    });
    restores.push(
      () => connect.mockRestore(),
      () => create.mockRestore(),
    );
    return created;
  }

  test("turn pollers use the configured natural drain grace and force time", async () => {
    const created = captureWorkerCreate();
    const settings = testSettings({
      turnWorkerShutdownGraceMs: 60_000,
      turnWorkerShutdownForceMs: 80_000,
    });
    const result = await createOpenGeniWorker({
      role: "turn",
      settings,
      activities: {} as never,
      activityDependencies: {
        observability: createObservability(settings, { component: "worker-test" }),
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ shutdownGraceTime: 60_000, shutdownForceTime: 80_000 });
    expect(result.shutdownTiming).toEqual({
      graceMs: 60_000,
      forceMs: 80_000,
      processExitDeadlineMs: 90_000,
    });
  });

  test("turn pollers default to the long natural drain", async () => {
    const created = captureWorkerCreate();
    const settings = testSettings();
    await createOpenGeniWorker({
      role: "turn",
      settings,
      activities: {} as never,
      activityDependencies: {
        observability: createObservability(settings, { component: "worker-test" }),
      },
    });

    expect(created[0]).toMatchObject({ shutdownGraceTime: 90_000, shutdownForceTime: 105_000 });
  });

  test("every control poller keeps the short control sequence", async () => {
    const created = captureWorkerCreate();
    const settings = testSettings({
      turnWorkerShutdownGraceMs: 60_000,
      turnWorkerShutdownForceMs: 80_000,
    });
    const result = await createOpenGeniWorker({
      role: "control",
      settings,
      activities: {} as never,
      activityDependencies: {
        observability: createObservability(settings, { component: "worker-test" }),
      },
    });

    expect(created.length).toBeGreaterThan(1);
    for (const options of created) {
      expect(options).toMatchObject({ shutdownGraceTime: 5_000, shutdownForceTime: 100_000 });
    }
    expect(result.shutdownTiming.graceMs).toBe(5_000);
  });
});

describe("shutdown phase telemetry", () => {
  function captureLogs() {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    restores.push(() => {
      console.log = originalLog;
      console.warn = originalWarn;
    });
    return () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }

  const structuredObservability = () =>
    createObservability(
      { ...testSettings(), observabilityStructuredLogs: true, observabilityMetricsEnabled: false },
      { component: "worker-test" },
    );

  test("public logs time the end of polling and of resource teardown from the drain", async () => {
    const read = captureLogs();
    let clock = 1_000;
    let finishRun!: () => void;
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability: structuredObservability(),
      now: () => clock,
      worker: {
        run: () =>
          new Promise<void>((resolve) => {
            finishRun = resolve;
          }),
        shutdown: () => undefined,
      },
      closeOwnedResources: async () => {
        clock += 250;
      },
    });

    const run = lifecycle.run();
    clock = 2_000;
    lifecycle.drain("SIGTERM");
    clock = 47_000;
    finishRun();
    await run;

    const phases = read().filter((entry) => entry.surface === "worker_shutdown");
    expect(
      phases.map(({ message, outcome, durationMs }) => ({ message, outcome, durationMs })),
    ).toEqual([
      {
        message: "Opengeni worker stopped polling; in-flight activities settled",
        outcome: "stopped",
        durationMs: 45_000,
      },
      { message: "Opengeni worker resources closed", outcome: "closed", durationMs: 45_250 },
    ]);
  });

  test("an SDK force stop is reported distinctly from an ordinary failure", async () => {
    const read = captureLogs();
    const forced = Object.assign(new Error("Timed out while waiting for worker to shutdown"), {
      name: "GracefulShutdownPeriodExpiredError",
    });
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability: structuredObservability(),
      worker: { run: async () => Promise.reject(forced), shutdown: () => undefined },
      closeOwnedResources: async () => undefined,
    });

    const error = await lifecycle.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerForceStoppedError);
    expect((error as Error).cause).toBe(forced);
    const phase = read().find((entry) => entry.surface === "worker_shutdown");
    expect(phase?.outcome).toBe("force_stopped");
    expect(JSON.stringify(read())).not.toContain("Timed out while waiting");
  });

  test.each([true, false])(
    "SDK finally masks force timeout: containment=%s keeps host intent and original cause",
    async (contained) => {
      const read = captureLogs();
      const masked = Object.assign(
        new Error("Worker still in use: Expected 1 reference, but got 2"),
        {
          name: "IllegalStateError",
        },
      );
      let reject!: (error: Error) => void;
      const running = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const obs = structuredObservability();
      const containment = createWorkerCleanupContainment({
        drain: () => lifecycle.drain(),
        observability: obs,
      });
      const lifecycle = createWorkerServiceLifecycle({
        role: "turn",
        observability: obs,
        cleanupContainmentRequested: containment.requested,
        worker: { run: () => running, shutdown() {} },
        closeOwnedResources: async () => {},
      });
      const run = lifecycle.run().catch((error: unknown) => error);
      if (contained) containment.request();
      reject(masked);
      const error = await run;
      if (contained) {
        expect(error).toBeInstanceOf(WorkerForceStoppedError);
        expect((error as Error).cause).toBe(masked);
        const logs: unknown[][] = [];
        const stderr = spyOn(console, "error").mockImplementation((...args) => {
          logs.push(args);
        });
        try {
          let code: number | undefined;
          await runWorkerProcessEntrypoint(
            async () => {
              throw error;
            },
            (value) => {
              code = value;
            },
          );
          expect(code).toBe(1);
          expect(logs[0]?.[0]).toBe("[worker] force stop");
        } finally {
          stderr.mockRestore();
        }
      } else expect(error).toBe(masked);
      expect(read().find((entry) => entry.surface === "worker_shutdown")?.outcome).toBe(
        contained ? "force_stopped" : "failed",
      );
      expect(lifecycle.state()).toBe("failed");
    },
  );
});

describe("standalone process exit", () => {
  test("an internal drain arms the host deadline once even when service close stalls", async () => {
    let expired = 0;
    let armed = 0;
    let finish!: () => void;
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability: createObservability(testSettings(), { component: "worker-test" }),
      worker: {
        run: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        shutdown: () => finish(),
      },
      onDrainStarted: () => {
        armed++;
        armWorkerProcessExitDeadline({
          deadlineMs: 10,
          onExpired: () => {
            expired++;
          },
        });
      },
      closeOwnedResources: () => new Promise(() => undefined),
    });
    void lifecycle.run();
    lifecycle.drain("memory pressure guard");
    lifecycle.drain("SIGTERM");
    await Bun.sleep(40);
    expect(armed).toBe(1);
    expect(expired).toBe(1);
  });
  test("resource closes are bounded and never reject", async () => {
    expect(await closeWithinBudget(async () => undefined, 1_000)).toBe("closed");
    expect(
      await closeWithinBudget(async () => {
        throw new Error("close failed");
      }, 1_000),
    ).toBe("failed");
    expect(await closeWithinBudget(() => new Promise(() => undefined), 20)).toBe("timed_out");
  });

  test("the exit deadline fires once armed and not after disarm", async () => {
    let expired = 0;
    armWorkerProcessExitDeadline({ deadlineMs: 10, onExpired: () => void expired++ });
    const disarm = armWorkerProcessExitDeadline({
      deadlineMs: 10,
      onExpired: () => void expired++,
    });
    disarm();
    await Bun.sleep(40);
    expect(expired).toBe(1);
  });

  async function runEntrypoint(script: string) {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const exitCode = await child.exited;
    clearTimeout(killer);
    return { exitCode, signal: child.signalCode, stderr: await new Response(child.stderr).text() };
  }

  test("the entry point exits after shutdown even with a leftover referenced handle", async () => {
    // Without the explicit exit this child never ends: the interval below is
    // the stand-in for a provider socket or timer a finished turn left behind.
    const result = await runEntrypoint(`
      const { runWorkerProcessEntrypoint } = await import("./src/worker-shutdown.ts");
      await runWorkerProcessEntrypoint(async () => {
        setInterval(() => {}, 60_000);
      });
    `);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  test("a failed worker run exits non-zero", async () => {
    const result = await runEntrypoint(`
      const { runWorkerProcessEntrypoint } = await import("./src/worker-shutdown.ts");
      await runWorkerProcessEntrypoint(async () => {
        setInterval(() => {}, 60_000);
        throw new Error("worker startup failed");
      });
    `);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worker startup failed");
  });
});
