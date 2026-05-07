import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { freePort, startProcess, startTestServices, type StartedProcess, type TestServices, waitFor } from "@infra-agents/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("browser e2e", () => {
  let services: TestServices;
  let api: StartedProcess;
  let worker: StartedProcess;
  let web: StartedProcess;
  let browser: Browser;
  let apiPort: number;
  let webPort: number;

  beforeAll(async () => {
    services = await startTestServices({ temporal: true });
    await services.migrate();
    apiPort = await freePort();
    webPort = await freePort();
    const env = stackEnv(services, apiPort, "slow");
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
    await waitFor(() => workerReady(worker), { timeoutMs: 90_000, describe: () => worker.logs() });
    web = await startProcess(["bun", "run", "vite", "dev", "--port", String(webPort), "--host", "127.0.0.1"], {
      cwd: `${repoRoot}/apps/web`,
      env: { VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` },
      ready: async () => (await fetch(`http://127.0.0.1:${webPort}`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    });
    browser = await chromium.launch();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await web?.stop();
    await worker?.stop();
    await api?.stop();
    await services?.down();
  }, 60_000);

  test("streams live updates to multiple clients and replays after refresh", async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(`http://127.0.0.1:${webPort}`);
    await pageA.getByRole("button", { name: "Model and intelligence" }).click();
    await pageA.getByRole("menuitem", { name: /^High$/ }).waitFor({ timeout: 10_000 });
    await pageA.keyboard.press("Escape");
    await pageA.getByPlaceholder("Describe a task for the agent...").fill("run a slow browser e2e session");
    await pageA.getByRole("button", { name: "Send" }).click();
    await waitFor(() => pageA.url().includes("/sessions/"), { timeoutMs: 15_000 });

    await pageB.goto(pageA.url());
    await pageA.getByTestId("session-timeline").getByText("slow stream", { exact: false }).waitFor({ timeout: 20_000 });
    await pageB.getByTestId("session-timeline").getByText("slow stream", { exact: false }).waitFor({ timeout: 20_000 });

    await pageA.getByRole("button", { name: "Interrupt" }).click();
    await pageA.getByText("status: cancelled").waitFor({ timeout: 30_000 });
    await pageA.reload();
    await pageA.getByText("status: cancelled").waitFor({ timeout: 15_000 });
  });
});

function stackEnv(services: TestServices, apiPort: number, scenario: string): Record<string, string> {
  return {
    INFRA_AGENT_ENVIRONMENT: "test",
    INFRA_AGENT_DATABASE_URL: services.databaseUrl,
    INFRA_AGENT_NATS_URL: services.natsUrl,
    INFRA_AGENT_TEMPORAL_HOST: services.temporalHost,
    INFRA_AGENT_TEMPORAL_NAMESPACE: "default",
    INFRA_AGENT_TEMPORAL_TASK_QUEUE: `e2e-${crypto.randomUUID()}`,
    INFRA_AGENT_API_HOST: "127.0.0.1",
    INFRA_AGENT_API_PORT: String(apiPort),
    INFRA_AGENT_OPENAI_API_KEY: "test",
    INFRA_AGENT_OPENAI_MODEL: "scripted-model",
    INFRA_AGENT_SANDBOX_BACKEND: "none",
    INFRA_AGENT_SANDBOX_ENV_PROFILES: "none",
    INFRA_AGENT_TEST_SCENARIO: scenario,
  };
}

async function workerReady(process: StartedProcess | undefined): Promise<boolean> {
  if (!process) {
    return false;
  }
  return process.logs().includes("test worker listening");
}
