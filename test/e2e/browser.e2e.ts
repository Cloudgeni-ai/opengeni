import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { migrate } from "@opengeni/db/migrate";
import {
  freePort,
  startE2eWorkerTopology,
  startProcess,
  startTestServices,
  type StartedE2eWorkerTopology,
  type StartedProcess,
  type TestServices,
  waitFor,
} from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("browser e2e", () => {
  let services: TestServices;
  let api: StartedProcess;
  let worker: StartedE2eWorkerTopology;
  let web: StartedProcess;
  let browser: Browser;
  let apiPort: number;
  let webPort: number;

  beforeAll(async () => {
    try {
      browser = await chromium.launch();
      // The attachment journey must exercise the actual direct-to-object-store
      // path, not a mocked SDK upload. Keep the browser and API on their normal
      // separate origins so CORS/signed-PUT behavior stays representative.
      services = await startBrowserTestServices();
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
      worker = await startE2eWorkerTopology({
        cwd: repoRoot,
        env,
      });
      await waitFor(() => worker.ready(), {
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
  }, 120_000);

  test("streams markdown updates to multiple clients and replays after refresh", async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(`http://127.0.0.1:${webPort}`);
    await pageA.getByRole("button", { name: "Model and effort" }).click();
    await pageA.getByRole("menuitem", { name: /^High$/ }).waitFor({ timeout: 10_000 });
    await pageA.keyboard.press("Escape");
    await pageA
      .getByPlaceholder("Describe a task for the agent…")
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

  test("uploads an image from the composer, persists its resource, and survives refresh", async () => {
    const page = await browser.newPage({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
    });
    await installThemeAndWindowOpenCapture(page, "light");
    const providerMethods: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname === "127.0.0.1" && Number(url.port) === services.minioPort) {
        providerMethods.push(request.method());
      }
    });
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2GQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.goto(`http://127.0.0.1:${webPort}`);

    // Coarse-touch picker + remove first: the hidden input is driven by the
    // actual button, and removing a completed draft attachment never makes the
    // compact composer overflow or leaves a dead chip.
    const attach = page.getByRole("button", { name: "Attach files" });
    await attach.waitFor();
    await expectCoarseTarget(attach);
    const chooserPromise = page.waitForEvent("filechooser");
    await attach.tap();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "e2e screenshot.png",
      mimeType: "image/png",
      buffer: image,
    });
    await page.getByText("e2e screenshot.png", { exact: true }).waitFor({ timeout: 15_000 });
    await waitFor(async () => (await page.locator('img[src^="blob:"]').count()) === 1, {
      timeoutMs: 15_000,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const remove = page.getByRole("button", { name: "Remove e2e screenshot.png" });
    await expectCoarseTarget(remove);
    await remove.focus();
    expect(await remove.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await expectCount(page.getByText("e2e screenshot.png", { exact: true }), 0);

    // Reattach the same bytes for the durable journey, then prove the controls
    // are keyboard reachable and visibly focused before sending.
    await page.locator('input[type="file"]').setInputFiles({
      name: "e2e screenshot.png",
      mimeType: "image/png",
      buffer: image,
    });
    await page.getByText("e2e screenshot.png", { exact: true }).waitFor({ timeout: 15_000 });
    await waitFor(() => providerMethods.includes("PUT"), {
      timeoutMs: 10_000,
      describe: () => `observed provider methods: ${providerMethods.join(", ") || "none"}`,
    });
    await attach.focus();
    expect(await attach.evaluate((element) => element === document.activeElement)).toBe(true);

    await page.getByPlaceholder("Describe a task for the agent…").fill("inspect the screenshot");
    await page.getByRole("button", { name: "Send message" }).click();
    await waitFor(() => /\/workspaces\/[^/]+\/sessions\/[^/]+$/.test(page.url()), {
      timeoutMs: 15_000,
    });
    await page
      .getByTestId("session-timeline")
      .getByText("inspect the screenshot", { exact: true })
      .waitFor({ timeout: 15_000 });

    // Composer `blob:` URLs are transient. The sent timeline preview must be a
    // fully loaded signed object URL, and opening it via keyboard must enter the
    // focus-trapped lightbox and restore focus after Escape.
    const preview = page
      .getByTestId("timeline-user")
      .getByRole("img", { name: "e2e screenshot.png" });
    await waitForImage(preview);
    const signedPreviewUrl = await preview.getAttribute("src");
    expect(signedPreviewUrl?.startsWith("blob:")).toBe(false);
    expect(signedPreviewUrl).toContain(`127.0.0.1:${services.minioPort}`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const open = page.getByRole("button", { name: "Open e2e screenshot.png" });
    await open.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Screenshot" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Screenshot" }).waitFor({ state: "hidden" });
    expect(await open.evaluate((element) => element === document.activeElement)).toBe(true);

    // Download mints a fresh signed URL on demand. Capture window.open rather
    // than navigating away from the E2E page, then validate it is provider-backed.
    const download = page.getByRole("button", { name: "Download e2e screenshot.png" });
    await expectCoarseTarget(download);
    await download.tap();
    await waitFor(
      async () =>
        (await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls))
          .length === 1,
      { timeoutMs: 10_000 },
    );
    const [downloadUrl] = await page.evaluate(
      () => (window as unknown as { __openedUrls: string[] }).__openedUrls,
    );
    expect(downloadUrl?.startsWith("blob:")).toBe(false);
    expect(downloadUrl).toContain(`127.0.0.1:${services.minioPort}`);
    const downloadResult = await page.evaluate(async (url) => {
      const response = await fetch(url!);
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        size: (await response.arrayBuffer()).byteLength,
      };
    }, downloadUrl);
    expect(downloadResult).toEqual({
      status: 200,
      contentType: "image/png",
      size: image.byteLength,
    });

    // The session API is the agent's durable resource source. Verify it has
    // exactly one ready file reference before and after reconnect/replay.
    const [workspaceId, sessionId] = page
      .url()
      .match(/workspaces\/([^/]+)\/sessions\/([^/]+)$/)!
      .slice(1);
    const resourceCount = async () =>
      await page.evaluate(
        async ({
          apiPort: browserApiPort,
          workspaceId: targetWorkspaceId,
          sessionId: targetSessionId,
        }) => {
          const response = await fetch(
            `http://127.0.0.1:${browserApiPort}/v1/workspaces/${targetWorkspaceId}/sessions/${targetSessionId}`,
          );
          const session = (await response.json()) as { resources?: Array<{ kind?: string }> };
          return session.resources?.filter((resource) => resource.kind === "file").length ?? 0;
        },
        { apiPort, workspaceId, sessionId },
      );
    expect(await resourceCount()).toBe(1);

    await page.reload();
    await page
      .getByTestId("session-timeline")
      .getByText("inspect the screenshot", { exact: true })
      .waitFor({ timeout: 15_000 });
    const reloadedPreview = page
      .getByTestId("timeline-user")
      .getByRole("img", { name: "e2e screenshot.png" });
    await waitForImage(reloadedPreview);
    expect((await reloadedPreview.getAttribute("src"))?.startsWith("blob:")).toBe(false);
    expect(await resourceCount()).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureEvidence(page, "ope19-mobile-light.png");

    // Three independent clients complete the required 2×2 matrix. Each one
    // reloads metadata + a fresh signed GET from the real backend; no blob URL
    // or React state is borrowed from the upload client.
    for (const variant of [
      { name: "mobile-dark", width: 375, height: 740, theme: "dark" as const, mobile: true },
      { name: "desktop-light", width: 1440, height: 900, theme: "light" as const, mobile: false },
      { name: "desktop-dark", width: 1440, height: 900, theme: "dark" as const, mobile: false },
    ]) {
      const client = await browser.newPage({
        viewport: { width: variant.width, height: variant.height },
        ...(variant.mobile ? { hasTouch: true, isMobile: true } : {}),
      });
      await installThemeAndWindowOpenCapture(client, variant.theme);
      await client.goto(page.url());
      expect(
        await client.evaluate(() => document.documentElement.getAttribute("data-og-theme")),
      ).toBe(variant.theme);
      const clientPreview = client
        .getByTestId("timeline-user")
        .getByRole("img", { name: "e2e screenshot.png" });
      await waitForImage(clientPreview);
      expect((await clientPreview.getAttribute("src"))?.startsWith("blob:")).toBe(false);
      expect(
        await client.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (variant.mobile) {
        await expectCoarseTarget(
          client.getByRole("button", { name: "Download e2e screenshot.png" }),
        );
      }
      if (variant.name === "desktop-dark") {
        await client.getByRole("button", { name: "Open e2e screenshot.png" }).click();
        const dialog = client.getByRole("dialog", { name: "Screenshot" });
        await dialog.waitFor();
        await client.getByRole("button", { name: "Close" }).click();
        await dialog.waitFor({ state: "hidden" });
      }
      await captureEvidence(client, `ope19-${variant.name}.png`);
      await client.close();
    }
    await page.close();
  }, 180_000);
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
    OPENGENI_OBJECT_STORAGE_ENDPOINT: services.objectStorageEndpoint!,
    OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT: services.objectStorageSandboxEndpoint!,
    OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
    OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    OPENGENI_TEST_SCENARIO: scenario,
  };
}

async function startBrowserTestServices(): Promise<TestServices> {
  const databaseUrl = process.env.OPENGENI_TEST_E2E_DATABASE_URL;
  const natsUrl = process.env.OPENGENI_TEST_E2E_NATS_URL;
  const temporalHost = process.env.OPENGENI_TEST_E2E_TEMPORAL_HOST;
  const objectStorageEndpoint = process.env.OPENGENI_TEST_E2E_OBJECT_STORAGE_ENDPOINT;
  const supplied = [databaseUrl, natsUrl, temporalHost, objectStorageEndpoint].filter(Boolean);
  if (supplied.length === 0) {
    return await startTestServices({ temporal: true, objectStorage: true });
  }
  if (supplied.length !== 4) {
    throw new Error(
      "OPENGENI_TEST_E2E_DATABASE_URL, OPENGENI_TEST_E2E_NATS_URL, OPENGENI_TEST_E2E_TEMPORAL_HOST, and OPENGENI_TEST_E2E_OBJECT_STORAGE_ENDPOINT must be set together",
    );
  }
  const postgresPort = endpointPort(databaseUrl!, "postgres:");
  const natsPort = endpointPort(natsUrl!, "nats:");
  const temporalPort = endpointPort(temporalHost!, "grpc:");
  const minioPort = endpointPort(objectStorageEndpoint!, "http:");
  return {
    projectName: "opengeni-external-browser-e2e",
    cwd: "",
    composeFile: "",
    postgresPort,
    natsPort,
    natsMonitorPort: 0,
    temporalPort,
    minioPort,
    minioConsolePort: 0,
    databaseUrl: databaseUrl!,
    natsUrl: natsUrl!,
    temporalHost: temporalHost!,
    dockerNetwork: "external",
    objectStorageEndpoint: objectStorageEndpoint!,
    objectStorageSandboxEndpoint: objectStorageEndpoint!,
    migrate: async () => await migrate(databaseUrl!),
    down: async () => {},
  };
}

function endpointPort(value: string, fallbackProtocol: string): number {
  const url = new URL(value.includes("://") ? value : `${fallbackProtocol}//${value}`);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`test service endpoint must include an explicit port: ${url.origin}`);
  }
  return port;
}

async function installThemeAndWindowOpenCapture(
  page: import("playwright").Page,
  theme: "light" | "dark",
): Promise<void> {
  await page.addInitScript((selectedTheme) => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      if (url) {
        (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
      }
      return null;
    }) as typeof window.open;
    const applyTheme = () => {
      document.documentElement?.setAttribute("data-og-theme", selectedTheme);
    };
    applyTheme();
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
    }
  }, theme);
}

async function waitForImage(locator: import("playwright").Locator): Promise<void> {
  await locator.waitFor({ timeout: 15_000 });
  await waitFor(
    async () =>
      await locator.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ),
    { timeoutMs: 15_000 },
  );
}

async function expectCount(locator: import("playwright").Locator, count: number): Promise<void> {
  await waitFor(async () => (await locator.count()) === count, { timeoutMs: 10_000 });
}

async function expectCoarseTarget(locator: import("playwright").Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(40);
  expect(box!.height).toBeGreaterThanOrEqual(40);
}

async function captureEvidence(page: import("playwright").Page, filename: string): Promise<void> {
  const directory = process.env.OPENGENI_E2E_EVIDENCE_DIR;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${filename}`, fullPage: true });
}
