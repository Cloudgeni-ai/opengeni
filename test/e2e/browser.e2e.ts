import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import {
  freePort,
  startProcess,
  startTestServices,
  type StartedProcess,
  type TestServices,
  waitFor,
} from "@opengeni/testing";

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
    try {
      browser = await chromium.launch();
      services = await startTestServices({ temporal: true });
      await services.migrate();
      apiPort = await freePort();
      webPort = await freePort();
      const env = stackEnv(services, apiPort, "slow");
      api = await startProcess(["bun", "apps/api/src/index.ts"], {
        cwd: repoRoot,
        env,
        ready: async () =>
          (await fetch(`http://127.0.0.1:${apiPort}/healthz`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      });
      worker = await startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
        cwd: repoRoot,
        env,
      });
      await waitFor(() => workerReady(worker), {
        timeoutMs: 90_000,
        describe: () => worker.logs(),
      });
      web = await startProcess(
        [
          "bun",
          "run",
          "vite",
          "dev",
          "--port",
          String(webPort),
          "--strictPort",
          "--host",
          "127.0.0.1",
        ],
        {
          cwd: `${repoRoot}/apps/web`,
          env: { VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` },
          ready: async () =>
            (await fetch(`http://127.0.0.1:${webPort}`).catch(() => null))?.ok === true,
          timeoutMs: 45_000,
        },
      );
    } catch (error) {
      await browser?.close().catch(() => undefined);
      await web?.stop().catch(() => undefined);
      await worker?.stop().catch(() => undefined);
      await api?.stop().catch(() => undefined);
      await services?.down().catch(() => undefined);
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await web?.stop();
    await worker?.stop();
    await api?.stop();
    await services?.down();
  }, 60_000);

  test("streams markdown updates to multiple clients and replays after refresh", async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(`http://127.0.0.1:${webPort}`);
    await pageA.getByRole("button", { name: "Model and effort" }).click();
    await pageA.getByRole("menuitem", { name: /^High$/ }).waitFor({ timeout: 10_000 });
    await pageA.keyboard.press("Escape");
    await pageA
      .getByPlaceholder("Describe a task for the agent...")
      .fill("run a slow browser e2e session");
    await pageA.getByRole("button", { name: "Send" }).click();
    await waitFor(() => /\/workspaces\/[^/]+\/sessions\/[^/]+$/.test(pageA.url()), {
      timeoutMs: 15_000,
    });

    await pageB.goto(pageA.url());
    await pageA
      .getByTestId("session-timeline")
      .getByText("slow stream", { exact: false })
      .waitFor({ timeout: 20_000 });
    await pageB
      .getByTestId("session-timeline")
      .getByText("slow stream", { exact: false })
      .waitFor({ timeout: 20_000 });
    await waitFor(
      async () => (await pageA.getByTestId("assistant-markdown").locator("table").count()) > 0,
      { timeoutMs: 20_000 },
    );
    await waitFor(
      async () => (await pageA.getByTestId("assistant-markdown").locator("pre code").count()) > 0,
      { timeoutMs: 20_000 },
    );
    await waitFor(
      async () => (await pageA.getByTestId("assistant-markdown").locator("code").count()) > 1,
      { timeoutMs: 20_000 },
    );
    const assistantClassName = await pageA
      .getByTestId("assistant-markdown")
      .first()
      .getAttribute("class");
    expect(assistantClassName ?? "").not.toContain("rounded");
    expect(assistantClassName ?? "").not.toContain("border");

    await pageA.reload();
    await pageA
      .getByTestId("session-timeline")
      .getByText("slow stream", { exact: false })
      .waitFor({ timeout: 15_000 });
  }, 120_000);
});

function stackEnv(
  services: TestServices,
  apiPort: number,
  scenario: string,
): Record<string, string> {
  return {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_DATABASE_URL: services.databaseUrl,
    OPENGENI_NATS_URL: services.natsUrl,
    OPENGENI_TEMPORAL_HOST: services.temporalHost,
    OPENGENI_TEMPORAL_NAMESPACE: "default",
    OPENGENI_TEMPORAL_TASK_QUEUE: `e2e-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(apiPort),
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_OPENAI_MODEL: "scripted-model",
    OPENGENI_SANDBOX_BACKEND: "none",
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
    OPENGENI_TEST_SCENARIO: scenario,
  };
}

async function workerReady(process: StartedProcess | undefined): Promise<boolean> {
  if (!process) {
    return false;
  }
  return process.logs().includes("test worker listening");
}
