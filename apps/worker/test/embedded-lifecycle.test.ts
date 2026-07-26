import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  createOpenGeniWorker,
  resolveOpenGeniWorkflowDefinition,
  workerOwnsInternalSchedules,
} from "../src";
import {
  createWorkerHttpHandler,
  type ReadinessChecks,
  type WorkerLifecycleState,
} from "../src/http";
import {
  constructWithOwnedConnection,
  createWorkerServiceLifecycle,
} from "../src/worker-service-lifecycle";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("embedded worker lifecycle contract", () => {
  test("only the designated control role owns engine maintenance schedules", () => {
    expect(workerOwnsInternalSchedules("control")).toBe(true);
    expect(workerOwnsInternalSchedules("control", "none")).toBe(false);
    expect(workerOwnsInternalSchedules("turn")).toBe(false);
    expect(workerOwnsInternalSchedules("turn", "none")).toBe(false);
  });

  test("turn workers reject the control-only workflow artifact override", async () => {
    await expect(
      createOpenGeniWorker({
        role: "turn",
        settings: testSettings(),
        workflowBundle: { code: "" },
      }),
    ).rejects.toThrow("workflowBundle is valid only for the control worker role");
  });

  test("construction failure closes the acquired connection and preserves the cause", async () => {
    let closes = 0;
    await expect(
      constructWithOwnedConnection(
        async () => ({ id: "connection" }),
        async () => {
          throw new Error("worker construction failed");
        },
        async () => {
          closes += 1;
        },
      ),
    ).rejects.toThrow("worker construction failed");
    expect(closes).toBe(1);
  });

  test("successful construction leaves the connection owned by the result lifecycle", async () => {
    let closes = 0;
    const result = await constructWithOwnedConnection(
      async () => ({ id: "connection" }),
      async (connection) => ({ connection, worker: "worker" }),
      async () => {
        closes += 1;
      },
    );

    expect(result).toEqual({ connection: { id: "connection" }, worker: "worker" });
    expect(closes).toBe(0);
  });

  test("run and drain are single-owner, idempotent lifecycle transitions", async () => {
    const settings = testSettings();
    const observability = createObservability(settings, { component: "worker-test" });
    let finishRun!: () => void;
    const running = new Promise<void>((settle) => {
      finishRun = settle;
    });
    let shutdowns = 0;
    let closes = 0;
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability,
      worker: {
        run: () => running,
        shutdown: () => {
          shutdowns += 1;
        },
      },
      closeOwnedResources: async () => {
        closes += 1;
      },
    });

    expect(lifecycle.state()).toBe("starting");
    const run = lifecycle.run();
    expect(lifecycle.run()).toBe(run);
    expect(lifecycle.state()).toBe("ready");
    lifecycle.drain("SIGTERM");
    lifecycle.drain("duplicate signal");
    expect(lifecycle.state()).toBe("draining");
    expect(shutdowns).toBe(1);

    finishRun();
    await run;
    expect(lifecycle.state()).toBe("stopped");
    expect(closes).toBe(1);
    await lifecycle.close();
    expect(shutdowns).toBe(1);
    expect(closes).toBe(1);
  });

  test("run failure is visible and still closes package-owned resources once", async () => {
    const settings = testSettings();
    let closes = 0;
    const lifecycle = createWorkerServiceLifecycle({
      role: "control",
      observability: createObservability(settings, { component: "worker-test" }),
      worker: {
        run: async () => {
          throw new Error("worker failed");
        },
        shutdown: () => undefined,
      },
      closeOwnedResources: async () => {
        closes += 1;
      },
    });

    await expect(lifecycle.run()).rejects.toThrow("worker failed");
    expect(lifecycle.state()).toBe("failed");
    expect(closes).toBe(1);
    await lifecycle.close();
    expect(closes).toBe(1);
  });

  test("a drain before run never starts polling and closes cleanly", async () => {
    const settings = testSettings();
    let runs = 0;
    let shutdowns = 0;
    let closes = 0;
    const lifecycle = createWorkerServiceLifecycle({
      role: "control",
      observability: createObservability(settings, { component: "worker-test" }),
      worker: {
        run: async () => {
          runs += 1;
        },
        shutdown: () => {
          shutdowns += 1;
        },
      },
      closeOwnedResources: async () => {
        closes += 1;
      },
    });

    lifecycle.drain("SIGTERM during startup");
    expect(lifecycle.state()).toBe("draining");
    await lifecycle.run();
    expect(lifecycle.state()).toBe("stopped");
    expect(runs).toBe(0);
    expect(shutdowns).toBe(1);
    expect(closes).toBe(1);
  });

  test("close without run drains and releases resources exactly once", async () => {
    const settings = testSettings();
    let shutdowns = 0;
    let closes = 0;
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability: createObservability(settings, { component: "worker-test" }),
      worker: {
        run: async () => undefined,
        shutdown: () => {
          shutdowns += 1;
        },
      },
      closeOwnedResources: async () => {
        closes += 1;
      },
    });

    await lifecycle.close();
    await lifecycle.close();
    expect(lifecycle.state()).toBe("stopped");
    expect(shutdowns).toBe(1);
    expect(closes).toBe(1);
    await expect(lifecycle.run()).rejects.toThrow("cannot run a worker service that is stopped");
  });

  test("workspace source uses source workflows while installed dist requires its bundle", async () => {
    const source = resolveOpenGeniWorkflowDefinition();
    expect(source).toEqual({
      workflowsPath: resolve(import.meta.dir, "../src/workflows.ts"),
    });

    const root = await mkdtemp(join(tmpdir(), "opengeni-worker-bundle-"));
    temporaryRoots.push(root);
    const dist = join(root, "dist");
    await mkdir(dist);
    await Bun.write(join(dist, "workflow-bundle.js"), "globalThis.__TEMPORAL__ = true;");
    expect(resolveOpenGeniWorkflowDefinition(pathToFileURL(join(dist, "index.js")).href)).toEqual({
      workflowBundle: { codePath: join(dist, "workflow-bundle.js") },
    });

    await rm(join(dist, "workflow-bundle.js"));
    expect(() =>
      resolveOpenGeniWorkflowDefinition(pathToFileURL(join(dist, "index.js")).href),
    ).toThrow("OpenGeni workflow bundle is missing");
  });

  test("readiness follows role lifecycle while health stays live during drain", async () => {
    const settings = testSettings();
    const observability = createObservability(settings, { component: "worker-test" });
    let state: WorkerLifecycleState = "starting";
    let checkCalls = 0;
    const check = () => {
      checkCalls += 1;
    };
    const checks: ReadinessChecks = { db: check, nats: check, temporal: check };
    const fetch = createWorkerHttpHandler({
      settings,
      observability,
      checks,
      lifecycle: { role: "control", state: () => state },
    });

    const startingHealth = await fetch(new Request("http://worker.test/healthz"));
    expect(startingHealth.status).toBe(200);
    expect(await startingHealth.json()).toMatchObject({
      ok: true,
      role: "control",
      state: "starting",
    });
    const startingReady = await fetch(new Request("http://worker.test/readyz"));
    expect(startingReady.status).toBe(503);
    expect(checkCalls).toBe(0);

    state = "ready";
    const ready = await fetch(new Request("http://worker.test/readyz"));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, state: "ready" });
    expect(checkCalls).toBe(3);

    state = "draining";
    expect((await fetch(new Request("http://worker.test/readyz"))).status).toBe(503);
    const drainingHealth = await fetch(new Request("http://worker.test/healthz"));
    expect(drainingHealth.status).toBe(200);
    expect(await drainingHealth.json()).toMatchObject({ ok: true, state: "draining" });

    state = "stopped";
    expect((await fetch(new Request("http://worker.test/healthz"))).status).toBe(503);
    const metrics = await fetch(new Request("http://worker.test/metrics"));
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
  });

  test("a failed dependency keeps a ready-state worker out of service", async () => {
    const settings = testSettings();
    const fetch = createWorkerHttpHandler({
      settings,
      observability: createObservability(settings, { component: "worker-test" }),
      checks: {
        db: () => undefined,
        nats: () => {
          throw new Error("broker disconnected");
        },
        temporal: () => undefined,
      },
      lifecycle: { role: "turn", state: () => "ready" },
    });

    const response = await fetch(new Request("http://worker.test/readyz"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      state: "ready",
      checks: { nats: { ok: false, error: "broker disconnected" } },
    });
  });
});
