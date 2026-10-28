import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { startTestServices, freePort } from "@opengeni/testing/compose";
import {
  startProcess,
  startE2eWorkerTopology,
  waitFor,
  type StartedProcess,
  type StartedE2eWorkerTopology,
} from "@opengeni/testing/process";

type EventProjection = {
  type: string;
  sequence: number;
  occurredAt: string;
  payload: Record<string, unknown>;
};
const root = new URL("../..", import.meta.url).pathname;

/**
 * One real API with control and turn workers, the in-process local sandbox and
 * a scripted model. Times how soon a session parked in `wait_for_input` starts
 * its next turn after its background command's result is settled (the sandbox
 * reaper observes the exit), and after a deadline.
 */
async function withWaitStack(
  run: (stack: {
    base: string;
    topology: StartedE2eWorkerTopology;
    databaseUrl: string;
  }) => Promise<void>,
): Promise<void> {
  const services = await startTestServices({ temporal: true });
  const receiptDir = await mkdtemp(join(tmpdir(), "opengeni-background-wake-"));
  let api: StartedProcess | undefined;
  let workers: StartedE2eWorkerTopology | undefined;
  try {
    await services.migrate();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      OPENGENI_ENVIRONMENT: "test",
      OPENGENI_DATABASE_URL: services.runtimeDatabaseUrl,
      OPENGENI_NATS_URL: services.natsUrl,
      OPENGENI_TEMPORAL_HOST: services.temporalHost,
      OPENGENI_TEMPORAL_NAMESPACE: "default",
      OPENGENI_TEMPORAL_TASK_QUEUE: `background-command-wake-${crypto.randomUUID()}`,
      OPENGENI_API_HOST: "127.0.0.1",
      OPENGENI_API_PORT: String(port),
      OPENGENI_PRODUCT_ACCESS_MODE: "local",
      OPENGENI_OPENAI_API_KEY: "test",
      OPENGENI_OPENAI_MODEL: "scripted-model",
      OPENGENI_SANDBOX_BACKEND: "local",
      OPENGENI_SANDBOX_OWNERSHIP_ENABLED: "true",
      // The local sandbox installs the Codemode client with the host's Node.
      OPENGENI_SANDBOX_ENV_ALLOWLIST: "PATH",
      OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
      OPENGENI_TEST_SCENARIO: "background-command-wait",
      // The sandbox reaper settles a command that outlives its turn.
      OPENGENI_TEST_SANDBOX_REAPER: "1",
      OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS: "2000",
    };
    api = await startProcess(["bun", "apps/api/src/index.ts"], {
      cwd: root,
      env,
      ready: async () => (await fetch(`${origin}/healthz`).catch(() => null))?.ok === true,
      timeoutMs: 60000,
    });
    const access = (await (await fetch(`${origin}/v1/access/me`)).json()) as {
      defaultWorkspaceId: string;
    };
    const base = `${origin}/v1/workspaces/${access.defaultWorkspaceId}`;
    const topology = await startE2eWorkerTopology({ cwd: root, env });
    workers = topology;
    await waitFor(() => topology.ready(), { timeoutMs: 90000, describe: () => topology.logs() });
    await run({ base, topology, databaseUrl: services.databaseUrl });
  } finally {
    if (workers) {
      await Bun.write(`${receiptDir}/workers.log`, workers.logs());
      await workers.stop();
    }
    if (api) {
      await Bun.write(`${receiptDir}/api.log`, api.logs());
      await api.stop();
    }
    await services.down();
  }
}

async function startSession(base: string, initialMessage: string): Promise<string> {
  const create = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initialMessage, tools: [{ id: "opengeni", kind: "mcp" }] }),
  });
  expect(create.status).toBe(202);
  return ((await create.json()) as { id: string }).id;
}

async function sessionEvents(base: string, id: string): Promise<EventProjection[]> {
  const response = await fetch(
    `${base}/sessions/${id}/events?mode=forensic&payloadMode=full&limit=1000`,
  );
  return (await response.json()) as EventProjection[];
}

const at = (event: EventProjection | undefined) =>
  event ? Date.parse(event.occurredAt) : Number.NaN;

/** Milliseconds from what should wake the wait to the turn it starts. */
async function wakeLatency(
  stack: { base: string; topology: StartedE2eWorkerTopology; databaseUrl: string },
  id: string,
  expected: "input" | "timeout",
): Promise<{ wakeMs: number; cause: "command" | "deadline" }> {
  const { base, topology } = stack;
  let events: EventProjection[] = [];
  try {
    await waitFor(
      async () => {
        events = await sessionEvents(base, id);
        return events.some(
          (event) =>
            event.type === "agent.message.completed" &&
            JSON.stringify(event.payload).includes(`BGWAIT DONE ${expected}`),
        );
      },
      { timeoutMs: 120000, intervalMs: 250, describe: () => topology.logs() },
    );
  } catch (error) {
    throw new Error(
      `session ${id} did not finish:\n${trace(events)}\n${await commandRows(stack.databaseUrl, id)}`,
      { cause: error },
    );
  }
  const waitStarted = events.find((event) => event.type === "session.wait.started");
  const woke = waitStarted
    ? events.find((event) => event.type === "turn.started" && event.sequence > waitStarted.sequence)
    : undefined;
  const finished = events.find((event) => event.type === "session.command.finished");
  if (!waitStarted || !woke || (expected === "input" && !finished))
    throw new Error(`session ${id} did not wait and wake:\n${trace(events)}`);
  if (expected === "input") {
    expect(at(finished)).toBeGreaterThan(at(waitStarted));
    return { wakeMs: at(woke) - at(finished), cause: "command" };
  }
  const deadlineAt = Date.parse(String(waitStarted.payload.deadlineAt));
  return { wakeMs: at(woke) - deadlineAt, cause: "deadline" };
}

/** The durable command and process rows, for a wake that never came. */
async function commandRows(databaseUrl: string, sessionId: string): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const commands =
      await sql`select * from session_background_commands where session_id = ${sessionId}`;
    const processes =
      await sql`select * from sandbox_retained_processes where session_id = ${sessionId}`;
    return JSON.stringify({ commands, processes }, null, 1);
  } catch (error) {
    return `command rows unavailable: ${String(error)}`;
  } finally {
    await sql.end();
  }
}

function trace(events: EventProjection[]): string {
  return events
    .map(
      (event) => `${event.occurredAt} ${event.type} ${JSON.stringify(event.payload).slice(0, 300)}`,
    )
    .join("\n");
}

test("wait_for_input resumes promptly when its background command exits and at its deadline", async () => {
  await withWaitStack(async (stack) => {
    const { base } = stack;
    const single = await startSession(base, "BGWAIT mode=command sleep=8 timeout=60");
    const command = await wakeLatency(stack, single, "input");
    const deadline = await startSession(base, "BGWAIT mode=deadline timeout=30");
    const timeout = await wakeLatency(stack, deadline, "timeout");
    // Several sessions waiting at once, each on its own command.
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        startSession(base, `BGWAIT mode=command sleep=${8 + index} timeout=60`),
      ),
    );
    const concurrentWakes = await Promise.all(
      concurrent.map((id) => wakeLatency(stack, id, "input")),
    );
    console.log(
      "background-command-wake receipt",
      JSON.stringify({
        commandWakeMs: command.wakeMs,
        deadlineWakeMs: timeout.wakeMs,
        concurrentCommandWakeMs: concurrentWakes.map((wake) => wake.wakeMs),
      }),
    );
    expect(command.wakeMs).toBeLessThan(4_000);
    // The wake outbox owns the deadline; its dispatcher runs every 10 s.
    expect(timeout.wakeMs).toBeGreaterThanOrEqual(-1_000);
    expect(timeout.wakeMs).toBeLessThan(15_000);
    for (const wake of concurrentWakes) expect(wake.wakeMs).toBeLessThan(4_000);
  });
}, 600_000);
