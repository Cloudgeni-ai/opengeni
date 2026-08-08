import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import {
  createOpenGeniWorker,
  resolveOpenGeniWorkflowDefinition,
  workerOwnsInternalSchedules,
} from "../src";
import {
  createWorkerHttpHandler,
  dbReadyCheck,
  type ReadinessChecks,
  type WorkerLifecycleState,
} from "../src/http";
import {
  combineWorkerRunTargets,
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
  test("a multi-queue worker starts and drains every Temporal poller as one service", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstRun = new Promise<void>((complete) => {
      finishFirst = complete;
    });
    const secondRun = new Promise<void>((complete) => {
      finishSecond = complete;
    });
    const started: string[] = [];
    const stopped: string[] = [];
    const worker = combineWorkerRunTargets([
      {
        run: () => {
          started.push("base");
          return firstRun;
        },
        shutdown: () => stopped.push("base"),
      },
      {
        run: () => {
          started.push("sandbox-lifecycle");
          return secondRun;
        },
        shutdown: () => stopped.push("sandbox-lifecycle"),
      },
    ]);

    const run = worker.run();
    expect(worker.run()).toBe(run);
    expect(started).toEqual(["base", "sandbox-lifecycle"]);
    worker.shutdown();
    expect(stopped).toEqual(["base", "sandbox-lifecycle"]);
    finishFirst();
    finishSecond();
    await run;
  });

  test("a failed poller drains every sibling and preserves its failure", async () => {
    let siblingShutdowns = 0;
    let finishSibling!: () => void;
    const siblingRun = new Promise<void>((complete) => {
      finishSibling = complete;
    });
    const worker = combineWorkerRunTargets([
      {
        run: async () => {
          throw new Error("poller failed");
        },
        shutdown: () => undefined,
      },
      {
        run: () => siblingRun,
        shutdown: () => {
          siblingShutdowns += 1;
          finishSibling();
        },
      },
    ]);

    await expect(worker.run()).rejects.toThrow("poller failed");
    expect(siblingShutdowns).toBe(1);
  });

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

  test("worker lifecycle public logs omit arbitrary shutdown reasons and errors", async () => {
    const sentinel = "WORKER_LIFECYCLE_PUBLIC_SENTINEL_3a91c7";
    const settings = {
      ...testSettings(),
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: false,
    };
    const warnings: unknown[][] = [];
    const logs: unknown[][] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    let shutdownAttempts = 0;
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.log = (...args: unknown[]) => logs.push(args);
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability: createObservability(settings, { component: "worker-test" }),
      worker: {
        run: async () => undefined,
        shutdown: () => {
          shutdownAttempts += 1;
          if (shutdownAttempts === 1) {
            throw Object.assign(new Error(sentinel), { name: sentinel, code: sentinel });
          }
        },
      },
      closeOwnedResources: async () => undefined,
    });

    try {
      expect(lifecycle.drain(sentinel)).toBe(false);
      expect(lifecycle.state()).toBe("starting");
      expect(lifecycle.drain(sentinel)).toBe(true);
      await lifecycle.close();
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }

    const rendered = JSON.stringify([...warnings, ...logs]);
    expect(rendered).toContain("worker_draining");
    expect(rendered).toContain("worker_shutdown_request_failed");
    expect(rendered).not.toContain(sentinel);
    expect(shutdownAttempts).toBe(2);
  });

  test("workspace source uses source workflows while installed dist requires its bundle", async () => {
    const source = resolveOpenGeniWorkflowDefinition();
    expect(source).toEqual({
      workflowsPath: resolvePath(import.meta.dir, "../src/workflows.ts"),
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

  test("worker database readiness enforces supplied posture and retains the embedded probe", async () => {
    let directExecutions = 0;
    let catalogQueries = 0;
    const catalogResults: unknown[] = [
      [
        {
          current_user: "opengeni_app",
          session_user: "opengeni_app",
          database_owner: "opengeni_migrator",
          can_connect_database: true,
          can_create_in_database: false,
          row_security: "on",
          rolcanlogin: true,
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ],
      [],
      [
        { name: "opengeni_private", owner: "opengeni_migrator", usage: true, create: false },
        { name: "public", owner: "opengeni_migrator", usage: true, create: false },
      ],
      [],
      [],
      [],
      [
        {
          name: "workspace_rls_visible(uuid, uuid)",
          owner: "opengeni_migrator",
          can_execute: true,
        },
      ],
    ];
    const db = {
      execute: async () => {
        directExecutions += 1;
        return [];
      },
      transaction: async (
        callback: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>,
      ) =>
        callback({
          execute: async () => {
            const result = catalogResults[catalogQueries];
            catalogQueries += 1;
            return result;
          },
        }),
    } as unknown as Database;

    await dbReadyCheck(db, {
      rlsStrategy: "force",
      expectedRole: "opengeni_app",
      targetSchema: "public",
      protectedTables: [],
      tablePrivileges: {},
      protectedNoDirectDmlTables: [],
    })();
    expect(catalogQueries).toBe(catalogResults.length);
    expect(directExecutions).toBe(0);

    await dbReadyCheck(db)();
    expect(directExecutions).toBe(1);
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
          throw Object.assign(new Error("WORKER_READYZ_PUBLIC_SENTINEL_786d18"), {
            name: "WORKER_READYZ_PUBLIC_SENTINEL_786d18",
            code: "WORKER_READYZ_PUBLIC_SENTINEL_786d18",
          });
        },
        temporal: () => undefined,
      },
      lifecycle: { role: "turn", state: () => "ready" },
    });

    const response = await fetch(new Request("http://worker.test/readyz"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      state: "ready",
      checks: { nats: { ok: false, error: "dependency_unavailable" } },
    });
    expect(JSON.stringify(body)).not.toContain("WORKER_READYZ_PUBLIC_SENTINEL_786d18");
  });
});
