import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@infra-agents/contracts";
import { buildSandboxImage, freePort, runCommand, startProcess, startTestServices, type StartedProcess, type TestServices, waitFor } from "@infra-agents/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
let apiPort = 0;

describe("real Docker sandbox e2e", () => {
  let services: TestServices;
  let api: StartedProcess;
  let worker: StartedProcess;

  beforeAll(async () => {
    await buildSandboxImage("infra-agents-sandbox:local", repoRoot);
    services = await startTestServices({ temporal: true });
    await services.migrate();
    apiPort = await freePort();
    const env = stackEnv(services, apiPort);
    api = await startProcess(["bun", "apps/api/src/index.ts"], {
      cwd: repoRoot,
      env,
      ready: async () => (await fetch(`http://127.0.0.1:${apiPort}/healthz`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    });
    worker = await startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
      cwd: repoRoot,
      env,
    });
    await waitFor(() => worker.logs().includes("test worker listening"), { timeoutMs: 90_000, describe: () => worker.logs() });
  }, 360_000);

  afterAll(async () => {
    await worker?.stop();
    await api?.stop();
    await services?.down();
  }, 60_000);

  test("runs SDK shell tool calls inside the real Docker sandbox", async () => {
    const create = await fetch(`http://127.0.0.1:${apiPort}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "verify sandbox cli tools",
        sandboxBackend: "docker",
      }),
    });
    expect(create.status).toBe(202);
    const session = await create.json() as { id: string };

    await waitFor(async () => {
      const events = await sessionEvents(session.id);
      return events.some((event) => event.type === "session.status.changed" && (event.payload as { status?: string }).status === "idle");
    }, { timeoutMs: 180_000 });

    const events = await sessionEvents(session.id);
    const toolOutput = events.find((event) => event.type === "agent.toolCall.output");
    expect(JSON.stringify(toolOutput?.payload ?? {})).toContain("sandbox-ok");
    expect(events.some((event) => event.type === "agent.message.completed")).toBe(true);
  }, 240_000);

  test("sandbox image has required CLIs and no custom Azure login helper", async () => {
    const result = await runCommand([
      "docker",
      "run",
      "--rm",
      "infra-agents-sandbox:local",
      "bash",
      "-lc",
      [
        "terraform version >/dev/null",
        "checkov --version >/dev/null",
        "az version --output none",
        "gh --version >/dev/null",
        "git --version >/dev/null",
        "jq --version >/dev/null",
        "curl --version >/dev/null",
        "test -x /usr/local/bin/infra-agent-git-askpass",
        "test ! -e /usr/local/bin/infra-agent-azure-login",
      ].join(" && "),
    ], { timeoutMs: 120_000 });
    expect(result.exitCode).toBe(0);
  }, 180_000);
});

async function sessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/sessions/${sessionId}/events?limit=200`);
  expect(response.ok).toBe(true);
  return await response.json() as SessionEvent[];
}

function stackEnv(services: TestServices, apiPort: number): Record<string, string> {
  return {
    INFRA_AGENT_ENVIRONMENT: "test",
    INFRA_AGENT_DATABASE_URL: services.databaseUrl,
    INFRA_AGENT_NATS_URL: services.natsUrl,
    INFRA_AGENT_TEMPORAL_HOST: services.temporalHost,
    INFRA_AGENT_TEMPORAL_NAMESPACE: "default",
    INFRA_AGENT_TEMPORAL_TASK_QUEUE: `sandbox-e2e-${crypto.randomUUID()}`,
    INFRA_AGENT_API_HOST: "127.0.0.1",
    INFRA_AGENT_API_PORT: String(apiPort),
    INFRA_AGENT_OPENAI_API_KEY: "test",
    INFRA_AGENT_OPENAI_MODEL: "scripted-model",
    INFRA_AGENT_SANDBOX_BACKEND: "docker",
    INFRA_AGENT_DOCKER_IMAGE: "infra-agents-sandbox:local",
    INFRA_AGENT_SANDBOX_ENV_PROFILES: "none",
    INFRA_AGENT_TEST_SCENARIO: "sandbox",
  };
}
