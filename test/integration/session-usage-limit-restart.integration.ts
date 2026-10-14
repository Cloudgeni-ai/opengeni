import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  freePort,
  startE2eWorkerTopology,
  startProcess,
  startTestServices,
  waitFor,
  type StartedE2eWorkerTopology,
  type StartedProcess,
} from "@opengeni/testing";

// Task usage limits across a real crash and repeated wakes: a real API process,
// real control and turn worker processes, PostgreSQL in the restricted runtime
// posture, NATS and Temporal. The first worker generation is SIGKILLed while
// the main model response streams (so it never reports usage); Temporal's
// heartbeat timeout hands the same turn to a second generation, whose priced
// response overshoots the limit. The test then proves the stop is a calm
// non-failure that pauses the goal, that wakes after exhaustion (a refused
// Send, another worker crash with the wake dispatcher restarting, a raise)
// never dispatch the model or loop, and that a person's Send after raising
// the limit runs normally. Offline scripted model only; no provider calls.
//
// Native services: set OPENGENI_TEST_PG_URL, OPENGENI_TEST_NATS_URL and
// OPENGENI_TEST_TEMPORAL_HOST together. Otherwise Docker test services start.

type EventProjection = {
  type: string;
  sequence: number;
  turnId: string | null;
  payload: Record<string, unknown>;
};
type UsageLimitRead = {
  limitMicros: number | null;
  usedMicros: number;
  status: string;
  version: number;
  pricedCalls: number;
  unpricedCalls: number;
};

const root = new URL("../..", import.meta.url).pathname;
const LIMIT_MICROS = 150;

type Stack = {
  databaseUrl: string;
  /** Dedicated data schema (native restricted posture); empty for Docker. */
  schema: string;
  natsUrl: string;
  temporalHost: string;
  admin: postgres.Sql;
  down: () => Promise<void>;
};

async function services(): Promise<Stack> {
  const natsUrl = process.env.OPENGENI_TEST_NATS_URL?.trim();
  const temporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
  if (Boolean(natsUrl) !== Boolean(temporalHost)) {
    throw new Error("Set OPENGENI_TEST_NATS_URL and OPENGENI_TEST_TEMPORAL_HOST together");
  }
  if (natsUrl && temporalHost) {
    const db = await acquireRestrictedRuntimeTestDatabase("usage-limit-restart");
    if (!db) throw new Error("Native services need OPENGENI_TEST_PG_URL as well");
    return {
      databaseUrl: db.appUrl,
      schema: db.schema,
      natsUrl,
      temporalHost,
      admin: db.admin,
      down: db.release,
    };
  }
  const started = await startTestServices({ temporal: true });
  await started.migrate();
  const admin = postgres(started.databaseUrl, { max: 2 });
  return {
    databaseUrl: started.runtimeDatabaseUrl,
    schema: "",
    natsUrl: started.natsUrl,
    temporalHost: started.temporalHost,
    admin,
    down: async () => {
      await admin.end().catch(() => undefined);
      await started.down();
    },
  };
}

/** Hard crash: SIGKILL the whole worker process group, then reap it. */
async function crash(topology: StartedE2eWorkerTopology) {
  for (const owned of [topology.control, topology.turns]) {
    if (owned.proc.pid !== undefined) {
      try {
        process.kill(-owned.proc.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  await topology.stop();
}

test("a worker crash and repeated wakes at the task usage limit never replay or loop; a raise resumes nothing by itself", async () => {
  const stack = await services();
  const receiptDir = await mkdtemp(join(tmpdir(), "opengeni-usage-limit-restart-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_DATABASE_URL: stack.databaseUrl,
    ...(stack.schema ? { OPENGENI_DB_SCHEMA: stack.schema } : {}),
    OPENGENI_NATS_URL: stack.natsUrl,
    OPENGENI_TEMPORAL_HOST: stack.temporalHost,
    OPENGENI_TEMPORAL_NAMESPACE: "default",
    OPENGENI_TEMPORAL_TASK_QUEUE: `usage-limit-restart-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(port),
    OPENGENI_PRODUCT_ACCESS_MODE: "local",
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_OPENAI_MODEL: "scripted-model",
    OPENGENI_SANDBOX_BACKEND: "none",
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
    OPENGENI_TEST_SCENARIO: "session-usage-limit-restart",
    OPENGENI_SESSION_USAGE_LIMITS_ENABLED: "true",
    // $1 per million input tokens: the 200-token answer costs 200 micros.
    OPENGENI_MODEL_PRICING_JSON: JSON.stringify({
      "scripted-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 },
    }),
  };
  let api: StartedProcess | undefined;
  const generations: StartedE2eWorkerTopology[] = [];
  const startWorkers = async (phase: "hold" | "answer") => {
    const topology = await startE2eWorkerTopology({
      cwd: root,
      env: { ...env, OPENGENI_TEST_USAGE_LIMIT_PHASE: phase },
    });
    generations.push(topology);
    await waitFor(() => topology.ready(), { timeoutMs: 90_000, describe: () => topology.logs() });
    return topology;
  };
  const logs = () => generations.map((g, i) => `[generation ${i}]\n${g.logs()}`).join("\n");
  try {
    api = await startProcess(["bun", "apps/api/src/index.ts"], {
      cwd: root,
      env,
      ready: async () => (await fetch(`${origin}/healthz`).catch(() => null))?.ok === true,
      timeoutMs: 90_000,
    });
    const access = (await (await fetch(`${origin}/v1/access/me`)).json()) as {
      defaultWorkspaceId: string;
    };
    const base = `${origin}/v1/workspaces/${access.defaultWorkspaceId}`;
    const describe = () => `receipts=${receiptDir}\n${logs()}\n[api]\n${api?.logs() ?? ""}`;

    const first = await startWorkers("hold");
    const create = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "USAGE_LIMIT_RESTART_FIXTURE finish the fixture",
        goal: { text: "Finish the usage limit fixture" },
        sandboxBackend: "none",
        usageLimitMicros: LIMIT_MICROS,
        startMode: "standard",
      }),
    });
    const created = (await create.json()) as {
      id: string;
      usageLimit?: { limitMicros: number | null };
    };
    expect(create.status, JSON.stringify(created)).toBe(202);
    // Capability echo: this server enforces the limit it accepted.
    expect(created.usageLimit?.limitMicros).toBe(LIMIT_MICROS);
    const sessionId = created.id;

    const events = async () =>
      (await (
        await fetch(
          `${base}/sessions/${sessionId}/events?mode=forensic&payloadMode=full&limit=1000`,
        )
      ).json()) as EventProjection[];
    const usage = async () =>
      (await (await fetch(`${base}/sessions/${sessionId}/usage-limit`)).json()) as UsageLimitRead;
    const session = async () =>
      (await (await fetch(`${base}/sessions/${sessionId}`)).json()) as {
        status: string;
        activeTurnId: string | null;
      };
    const goal = async () =>
      (await (await fetch(`${base}/sessions/${sessionId}/goal`)).json()) as {
        status: string;
        pausedReason?: string | null;
      };
    const receipts = async () =>
      await stack.admin<Array<{ amount_micros: string | null; source_id: string }>>`
        select amount_micros, source_id from opengeni_private.session_usage_limit_receipts
        where source_session_id = ${sessionId} order by recorded_at, source_id`;
    const count = (all: EventProjection[], type: string) =>
      all.filter((event) => event.type === type).length;

    // Crash 1: the main response is streaming; SIGKILL before it reports usage.
    await waitFor(async () => (await events()).some((e) => e.type === "agent.message.delta"), {
      timeoutMs: 90_000,
      describe,
    });
    expect((await receipts()).filter((r) => r.amount_micros === "200")).toHaveLength(0);
    await crash(first);

    // Temporal's heartbeat timeout hands the same turn to the next generation.
    await startWorkers("answer");
    await waitFor(
      async () => {
        const current = await goal();
        return current.status === "paused" && (await session()).status === "idle";
      },
      { timeoutMs: 300_000, intervalMs: 1_000, describe },
    );
    const stopped = await events();
    await Bun.write(`${receiptDir}/stopped.json`, JSON.stringify(stopped, null, 2));
    expect(await goal()).toMatchObject({ status: "paused", pausedReason: "session_usage_limit" });
    const reached = await usage();
    expect(reached).toMatchObject({ limitMicros: LIMIT_MICROS, status: "reached" });
    expect(reached.usedMicros).toBeGreaterThanOrEqual(200);
    // The killed stream never reported usage, so exactly one main response is
    // counted, and nothing failed.
    const afterStop = await receipts();
    expect(afterStop.filter((r) => r.amount_micros === "200")).toHaveLength(1);
    expect(count(stopped, "turn.failed")).toBe(0);
    expect(count(stopped, "usage.exhausted")).toBe(0);
    expect(JSON.stringify(stopped)).not.toContain("budget_exhausted");
    expect(count(stopped, "goal.paused")).toBe(1);
    const turnsStarted = count(stopped, "turn.started");

    // Wake 1: a person's Send at the limit is refused before anything queues.
    const refused = await fetch(`${base}/sessions/${sessionId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "user.message", payload: { text: "keep going" } }),
    });
    const refusedBody = await refused.text();
    expect(refused.status, refusedBody).toBe(402);
    expect(refusedBody).toContain("session_usage_limit_reached");

    // Wake 2: crash the answering generation and start another. Its wake
    // dispatcher and maintenance run, but nothing at the limit is dispatched.
    await crash(generations.at(-1)!);
    await startWorkers("answer");
    await Bun.sleep(15_000);
    const quiet = await events();
    expect(count(quiet, "turn.started")).toBe(turnsStarted);
    expect(count(quiet, "goal.paused")).toBe(1);
    expect(await receipts()).toHaveLength(afterStop.length);
    expect((await session()).status).toBe("idle");

    // Wake 3: raising the limit changes nothing until a person acts.
    const raise = await fetch(`${base}/sessions/${sessionId}/usage-limit`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limitMicros: 1_000_000,
        expectedVersion: reached.version,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(raise.status, await raise.clone().text()).toBe(200);
    await Bun.sleep(10_000);
    const raised = await events();
    expect(count(raised, "turn.started")).toBe(turnsStarted);
    expect(await goal()).toMatchObject({ status: "paused", pausedReason: "session_usage_limit" });
    expect(await receipts()).toHaveLength(afterStop.length);

    // After the raise a person's Send runs normally.
    const send = await fetch(`${base}/sessions/${sessionId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "user.message", payload: { text: "continue now" } }),
    });
    expect(send.status, await send.clone().text()).toBe(202);
    await waitFor(
      async () => (await receipts()).filter((r) => r.amount_micros === "200").length === 2,
      { timeoutMs: 90_000, describe },
    );
    await waitFor(async () => (await session()).status === "idle", {
      timeoutMs: 60_000,
      describe,
    });
    const final = await events();
    await Bun.write(`${receiptDir}/final.json`, JSON.stringify(final, null, 2));
    expect(count(final, "turn.started")).toBe(turnsStarted + 1);
    expect(count(final, "turn.failed")).toBe(0);
    expect((await usage()).status).toBe("within");
  } finally {
    for (const topology of generations) {
      await Bun.write(
        `${receiptDir}/workers-${generations.indexOf(topology)}.log`,
        topology.logs(),
      );
      await topology.stop();
    }
    if (api) {
      await Bun.write(`${receiptDir}/api.log`, api.logs());
      await api.stop();
    }
    await stack.down();
  }
}, 600_000);
