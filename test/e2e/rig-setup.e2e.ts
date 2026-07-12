import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import { createDb, createRig, type DbClient } from "@opengeni/db";
import {
  buildSandboxImage,
  freePort,
  startProcess,
  startTestServices,
  type StartedProcess,
  type TestServices,
  waitFor,
} from "@opengeni/testing";

// M3 rig-setup hook, driven end-to-end through the REAL turn path (API ->
// Temporal worker -> lease -> real Docker box establishment -> rig-setup
// beforeAgentStart hook -> scripted "default" turn). Proves the hook's shell
// semantics against a REAL box (marker idempotence, non-zero-exit fail-closed,
// and a tiny-timeout failure) that the fake-session unit tests cannot.
//
// The worker runs the SCRIPTED model (OPENGENI_TEST_SCENARIO unset -> "default"
// => "hello from e2e"), so no LLM creds are needed; the rig setup runs during
// box establishment regardless of what the agent then says. The rig setup
// TIMEOUT is pinned to 2s (OPENGENI_RIG_SETUP_TIMEOUT_MS) so the sleep-5 rig
// fails on the timeout branch while the trivial echo rigs finish instantly.

const repoRoot = new URL("../..", import.meta.url).pathname;
let apiPort = 0;
let workspaceId = "";
let accountId = "";
let db: DbClient;

describe("real Docker rig-setup e2e", () => {
  let services: TestServices;
  let api: StartedProcess;
  let worker: StartedProcess;

  beforeAll(async () => {
    await buildSandboxImage("opengeni-sandbox:local", repoRoot);
    services = await startTestServices({ temporal: true, objectStorage: true });
    await services.migrate();
    apiPort = await freePort();
    const env = stackEnv(services, apiPort);
    api = await startProcess(["bun", "apps/api/src/index.ts"], {
      cwd: repoRoot,
      env,
      ready: async () =>
        (await fetch(`http://127.0.0.1:${apiPort}/healthz`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    });
    workspaceId = await discoverWorkspaceId();
    accountId = await discoverAccountId();
    db = createDb(services.databaseUrl);
    worker = await startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
      cwd: repoRoot,
      env,
    });
    await waitFor(() => worker.logs().includes("test worker listening"), {
      timeoutMs: 90_000,
      describe: () => worker.logs(),
    });
  }, 360_000);

  afterAll(async () => {
    await worker?.stop();
    await api?.stop();
    await db?.close();
    await services?.down();
  }, 60_000);

  // Seed a rig (createRig makes v1 active with the given setup script).
  async function seedRig(name: string, setupScript: string): Promise<string> {
    const rig = await createRig(db.db, {
      accountId,
      workspaceId,
      name,
      createdBy: "user:e2e",
      initialVersion: { setupScript, changelog: "v1" },
    });
    return rig.id;
  }

  async function createRigSession(rigId: string, message: string): Promise<string> {
    const create = await fetch(apiPath("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialMessage: message, sandboxBackend: "docker", rigId }),
    });
    expect(create.status).toBe(202);
    return ((await create.json()) as { id: string }).id;
  }

  async function waitForTerminal(sessionId: string, timeoutMs = 180_000): Promise<SessionEvent[]> {
    await waitFor(
      async () => {
        const events = await sessionEvents(sessionId);
        return events.some(
          (e) =>
            e.type === "session.status.changed" &&
            ["idle", "failed"].includes((e.payload as { status?: string }).status ?? ""),
        );
      },
      { timeoutMs },
    );
    return await sessionEvents(sessionId);
  }

  // The rig-setup hook has a dedicated lifecycle event family. Keep this E2E
  // on that public contract rather than the legacy generic sandbox operation.
  function rigSetupEvents(events: SessionEvent[]): Array<{ type: string; payload: any }> {
    return events
      .filter((e) => e.type.startsWith("rig.setup."))
      .map((e) => ({ type: e.type, payload: e.payload as any }));
  }

  test("first turn runs the setup (started+completed), second warm turn SKIPS via the marker", async () => {
    const rigId = await seedRig("proof-rig", "echo ok > /tmp/opengeni-rig-proof && touch /tmp/x");
    const sessionId = await createRigSession(rigId, "hello");
    const firstEvents = await waitForTerminal(sessionId);

    const firstRig = rigSetupEvents(firstEvents);
    expect(firstRig.some((e) => e.type === "rig.setup.started")).toBe(true);
    // completed{skipped:false} is the proof the script ran to exit 0 (which wrote the file).
    const ran = firstRig.find((e) => e.type === "rig.setup.completed");
    expect(ran?.payload.skipped).toBe(false);

    // Second turn on the SAME session reuses the warm box → the marker skips setup.
    const followUp = await fetch(apiPath(`/sessions/${sessionId}/events`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "user.message", payload: { text: "again" } }),
    });
    expect(followUp.ok).toBe(true);
    await waitFor(
      async () => {
        const skips = rigSetupEvents(await sessionEvents(sessionId)).filter(
          (e) => e.type === "rig.setup.skipped",
        );
        return skips.length >= 1;
      },
      { timeoutMs: 180_000 },
    );
    const skipped = rigSetupEvents(await sessionEvents(sessionId)).find(
      (e) => e.type === "rig.setup.skipped",
    );
    expect(skipped?.type).toBe("rig.setup.skipped");
  }, 300_000);

  test("a failing setup script (exit 7) fails the turn closed with a rig.setup failure", async () => {
    const rigId = await seedRig("failing-rig", "echo starting; exit 7");
    const sessionId = await createRigSession(rigId, "hello");
    const events = await waitForTerminal(sessionId);

    const failed = rigSetupEvents(events).find((e) => e.type === "rig.setup.failed");
    expect(failed).toBeDefined();
    expect(failed?.payload.error).toContain("exited with code 7");
    // The session surfaces the failure (turn.failed / status failed).
    expect(
      events.some(
        (e) =>
          e.type === "turn.failed" ||
          (e.type === "session.status.changed" &&
            (e.payload as { status?: string }).status === "failed"),
      ),
    ).toBe(true);
  }, 300_000);

  test("a setup exceeding the 2s configured timeout fails on the timeout branch", async () => {
    const rigId = await seedRig("slow-rig", "sleep 5");
    const sessionId = await createRigSession(rigId, "hello");
    const events = await waitForTerminal(sessionId);

    const failed = rigSetupEvents(events).find((e) => e.type === "rig.setup.failed");
    expect(failed).toBeDefined();
    expect(failed?.payload.error).toContain("rig setup timeout");
  }, 300_000);
});

async function sessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const response = await fetch(apiPath(`/sessions/${sessionId}/events?limit=200`));
  expect(response.ok).toBe(true);
  return (await response.json()) as SessionEvent[];
}

async function discoverWorkspaceId(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/access/me`);
  expect(response.ok).toBe(true);
  const context = (await response.json()) as { defaultWorkspaceId?: string };
  expect(typeof context.defaultWorkspaceId).toBe("string");
  return context.defaultWorkspaceId!;
}

async function discoverAccountId(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/workspaces`);
  expect(response.ok).toBe(true);
  const workspaces = (await response.json()) as Array<{ id: string; accountId: string }>;
  const workspace = workspaces.find((w) => w.id === workspaceId);
  expect(workspace).toBeDefined();
  return workspace!.accountId;
}

function apiPath(path: string): string {
  return `http://127.0.0.1:${apiPort}/v1/workspaces/${workspaceId}${path}`;
}

function stackEnv(services: TestServices, localApiPort: number): Record<string, string> {
  return {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_DATABASE_URL: services.databaseUrl,
    OPENGENI_NATS_URL: services.natsUrl,
    OPENGENI_TEMPORAL_HOST: services.temporalHost,
    OPENGENI_TEMPORAL_NAMESPACE: "default",
    OPENGENI_TEMPORAL_TASK_QUEUE: `rig-setup-e2e-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(localApiPort),
    OPENGENI_PRODUCT_ACCESS_MODE: "local",
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_OPENAI_MODEL: "scripted-model",
    OPENGENI_SANDBOX_BACKEND: "docker",
    OPENGENI_DOCKER_IMAGE: "opengeni-sandbox:local",
    OPENGENI_DOCKER_NETWORK: services.dockerNetwork,
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
    // Pin the rig setup budget tiny so the sleep-5 rig hits the timeout branch;
    // the echo/touch rigs finish well within it.
    OPENGENI_RIG_SETUP_TIMEOUT_MS: "2000",
    OPENGENI_OBJECT_STORAGE_ENDPOINT: services.objectStorageEndpoint!,
    OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT: services.objectStorageSandboxEndpoint!,
    OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
    OPENGENI_OBJECT_STORAGE_REGION: "us-east-1",
    OPENGENI_OBJECT_STORAGE_S3_PROVIDER: "Minio",
    OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
    OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
  };
}
