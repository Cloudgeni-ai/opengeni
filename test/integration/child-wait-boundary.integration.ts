import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTestServices,
  startProcess,
  startE2eWorkerTopology,
  freePort,
  waitFor,
  type StartedProcess,
  type StartedE2eWorkerTopology,
} from "@opengeni/testing";
type SessionProjection = { id: string; parentSessionId: string | null };
type EventProjection = { type: string; occurredAt: string; payload: Record<string, unknown> };
const root = new URL("../..", import.meta.url).pathname;
test("public API child wait does not report completed work before deadline", async () => {
  const services = await startTestServices({ temporal: true });
  const receiptDir = await mkdtemp(join(tmpdir(), "opengeni-child-wait-"));
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
      OPENGENI_TEMPORAL_TASK_QUEUE: `child-wait-${crypto.randomUUID()}`,
      OPENGENI_API_HOST: "127.0.0.1",
      OPENGENI_API_PORT: String(port),
      OPENGENI_PRODUCT_ACCESS_MODE: "local",
      OPENGENI_OPENAI_API_KEY: "test",
      OPENGENI_OPENAI_MODEL: "scripted-model",
      OPENGENI_SANDBOX_BACKEND: "none",
      OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
      OPENGENI_TEST_SCENARIO: "child-wait-boundary",
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
    const create = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "CHILD_WAIT_PARENT_FIXTURE",
        sandboxBackend: "none",
        tools: [{ id: "opengeni", kind: "mcp" }],
      }),
    });
    expect(create.status).toBe(202);
    const parent = (await create.json()) as SessionProjection;
    const events = async (id: string) =>
      (await (
        await fetch(`${base}/sessions/${id}/events?mode=forensic&payloadMode=full&limit=1000`)
      ).json()) as EventProjection[];
    let child: SessionProjection | undefined;
    await waitFor(
      async () => {
        const list = (await (await fetch(`${base}/sessions`)).json()) as SessionProjection[];
        child = list.find((session) => session.parentSessionId === parent.id);
        return !!child;
      },
      { timeoutMs: 60000, describe: () => topology.logs() },
    );
    if (!child) throw new Error("child was not created through the public runtime tool");
    const childId = child.id;
    await waitFor(
      async () => (await events(childId)).some((e) => e.type === "session.wait.started"),
      { timeoutMs: 60000, describe: () => topology.logs() },
    );
    await waitFor(async () => (await events(childId)).some((e) => e.type === "goal.completed"), {
      timeoutMs: 90000,
      describe: () => topology.logs(),
    });
    await waitFor(
      async () =>
        (await events(parent.id)).some(
          (e) => e.type === "system.update.pending" && e.payload.kind === "child_terminal_result",
        ),
      { timeoutMs: 30000, describe: () => topology.logs() },
    );
    const parentEvents = await events(parent.id),
      childEvents = await events(childId);
    const goal = (await (await fetch(`${base}/sessions/${childId}/goal`)).json()) as {
      status: string;
    };
    await Bun.write(
      `${receiptDir}/receipt.json`,
      JSON.stringify({ parentId: parent.id, childId, parentEvents, childEvents, goal }, null, 2),
    );
    const notices = parentEvents.filter(
      (e) => e.type === "system.update.pending" && e.payload.kind === "child_terminal_result",
    );
    const completion = childEvents.find((e) => e.type === "goal.completed");
    expect(notices).toHaveLength(1);
    expect(Date.parse(notices[0]!.occurredAt)).toBeGreaterThanOrEqual(
      Date.parse(completion!.occurredAt),
    );
    expect(notices[0]!.payload.summary).toContain("COMPLETED its goal");
    expect(goal.status).toBe("completed");
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
}, 300000);
