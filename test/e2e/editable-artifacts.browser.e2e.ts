import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

import { OpenGeniClient } from "@opengeni/sdk/artifacts";
import { createEditableArtifactReplicaId } from "@opengeni/sdk/editable-artifacts";
import {
  freePort,
  removeTempDir,
  startProcess,
  startTestServices,
  waitFor,
  type StartedProcess,
  type TestServices,
} from "@opengeni/testing";

import { prepareDevelopmentArtifactRuntime } from "../../scripts/prepare-development-artifact-runtime";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const evidenceRoot = process.env.OPENGENI_EDITABLE_ARTIFACT_EVIDENCE_DIR?.trim() || "/tmp";

type BrowserObservation = Readonly<{
  diagnostics: string[];
  lifecycleCancellations: string[];
  workerStarts: string[];
  workerUrls: Set<string>;
  wasmUrls: Set<string>;
  webSocketUrls: string[];
  stop(): void;
}>;

describe("public editable-artifact browser composition", () => {
  let services: TestServices;
  let api: StartedProcess;
  let demo: StartedProcess;
  let browser: Browser;
  let runtimeRoot: string;
  let apiBaseUrl: string;
  let demoBaseUrl: string;
  let workspaceId: string;
  let client: OpenGeniClient;

  beforeAll(async () => {
    try {
      runtimeRoot = join(repoRoot, ".opengeni", `artifact-runtime-e2e-${crypto.randomUUID()}`);
      const runtime = await prepareDevelopmentArtifactRuntime({
        repositoryRoot: repoRoot,
        outputRoot: runtimeRoot,
      });
      services = await startTestServices({ temporal: true, objectStorage: true });
      await services.migrate();

      const apiPort = await freePort();
      const demoPort = await freePort();
      apiBaseUrl = `http://127.0.0.1:${apiPort}`;
      demoBaseUrl = `http://127.0.0.1:${demoPort}`;
      api = await startProcess(["bun", "apps/api/src/index.ts"], {
        cwd: repoRoot,
        env: artifactApiEnvironment(services, apiPort, runtime),
        ready: async () =>
          (
            await fetch(`${apiBaseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) }).catch(
              () => null,
            )
          )?.ok === true,
        timeoutMs: 90_000,
      });
      demo = await startProcess(
        [
          "bun",
          "run",
          "vite",
          "dev",
          "demo",
          "--host",
          "127.0.0.1",
          "--port",
          String(demoPort),
          "--strictPort",
          "--logLevel",
          "warn",
        ],
        {
          cwd: join(repoRoot, "packages/react"),
          env: { OPENGENI_REACT_DEMO_API_TARGET: apiBaseUrl },
          ready: async () =>
            (
              await fetch(`${demoBaseUrl}/editable-artifacts.html`, {
                signal: AbortSignal.timeout(1_000),
              }).catch(() => null)
            )?.ok === true,
          timeoutMs: 60_000,
        },
      );
      browser = await chromium.launch({ headless: true });
      client = new OpenGeniClient({ baseUrl: apiBaseUrl });
      const workspaces = await client.listWorkspaces();
      const workspace = workspaces[0];
      if (!workspace) throw new Error("Editable-artifact E2E has no seeded workspace");
      workspaceId = workspace.id;
    } catch (error) {
      await Promise.allSettled([browser?.close(), demo?.stop(), api?.stop(), services?.down()]);
      if (runtimeRoot) await removeTempDir(runtimeRoot).catch(() => undefined);
      throw error;
    }
  }, 420_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([
      browser?.close(),
      demo?.stop(),
      api?.stop(),
      services?.down(),
      runtimeRoot ? removeTempDir(runtimeRoot) : Promise.resolve(),
    ]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Editable-artifact E2E teardown failed");
    }
  }, 120_000);

  test("edits all modalities through the public SDK Worker/WASM path and survives reload", async () => {
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 900 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const observed = observeBrowser(page);
    try {
      await page.goto(
        `${demoBaseUrl}/editable-artifacts.html?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const documentArtifact = await createArtifact(page, "Document", "E2E product brief");
      await page.getByRole("button", { name: "Start writing" }).click();
      const paragraph = page.getByRole("textbox", { name: "Paragraph" });
      await paragraph.waitFor();
      await waitForEditorIdle(page, "document");
      await paragraph.fill("Durable document text from the real browser session.");
      await waitForEditorIdle(page, "document");
      await assertReloadedText(page, "Durable document text from the real browser session.");
      await assertServerAdvanced(documentArtifact);
      await capture(page, "editable-artifact-document-dark.png");

      await openArtifactStart(page);
      await createArtifact(page, "Spreadsheet", "E2E operating model");
      const addWorksheet = page
        .getByRole("button", { name: "Add worksheet", exact: true })
        .filter({ hasText: "Add worksheet" });
      await addWorksheet.click();
      const grid = page.getByRole("grid", { name: /spreadsheet$/u });
      await grid.waitFor();
      await waitForEditorIdle(page, "spreadsheet");
      const formula = page.getByLabel("Formula or value");
      await formula.fill("=1+1");
      await formula.press("Enter");
      await waitForEditorIdle(page, "spreadsheet");
      await waitFor(
        async () =>
          (await page.locator('[data-og-cell="A1"]').getAttribute("aria-label")) === "A1, 2",
        {
          timeoutMs: 20_000,
          describe: () => observed.diagnostics.join("\n"),
        },
      );
      await page.reload();
      await page.getByRole("grid", { name: /spreadsheet$/u }).waitFor({ timeout: 30_000 });
      await waitFor(
        async () =>
          (await page.locator('[data-og-cell="A1"]').getAttribute("aria-label")) === "A1, 2",
        {
          timeoutMs: 20_000,
          describe: () => observed.diagnostics.join("\n"),
        },
      );
      await formula.fill("after reopen");
      await formula.press("Enter");
      await waitForEditorIdle(page, "spreadsheet");
      await waitFor(
        async () =>
          (await page.locator('[data-og-cell="A1"]').getAttribute("aria-label")) ===
          "A1, after reopen",
        {
          timeoutMs: 20_000,
          describe: () => observed.diagnostics.join("\n"),
        },
      );
      await page.reload();
      await waitFor(
        async () =>
          (await page.locator('[data-og-cell="A1"]').getAttribute("aria-label")) ===
          "A1, after reopen",
        {
          timeoutMs: 30_000,
          describe: () => observed.diagnostics.join("\n"),
        },
      );
      await capture(page, "editable-artifact-spreadsheet-dark.png");

      await openArtifactStart(page);
      await createArtifact(page, "Presentation", "E2E launch story");
      await page.getByRole("button", { name: "Add slide" }).click();
      await page.getByRole("option", { name: /^Slide 1/u }).waitFor();
      await waitForEditorIdle(page, "presentation");
      await page.getByRole("button", { name: "Add text box" }).click();
      await waitForEditorIdle(page, "presentation");
      const slideEditor = page.getByRole("application", { name: "Slide 1 editor" });
      await slideEditor.press("Enter");
      const textBox = page.getByRole("textbox", { name: "Edit Text box" });
      await textBox.fill("A real Worker/WASM slide");
      await textBox.press("Control+Enter");
      await waitForEditorIdle(page, "presentation");
      await page.reload();
      await page.getByRole("option", { name: /^Slide 1/u }).waitFor({ timeout: 30_000 });
      const reloadedSlideEditor = page.getByRole("application", { name: "Slide 1 editor" });
      await reloadedSlideEditor.press("]");
      await reloadedSlideEditor.press("Enter");
      expect(await page.getByRole("textbox", { name: "Edit Text box" }).inputValue()).toBe(
        "A real Worker/WASM slide",
      );
      await page.keyboard.press("Escape");
      await capture(page, "editable-artifact-presentation-dark.png");

      expect(observed.workerStarts.length).toBeGreaterThanOrEqual(3);
      expect(observed.wasmUrls.size).toBeGreaterThanOrEqual(3);
      expect([...observed.wasmUrls].some((url) => url.includes("spreadsheet"))).toBe(true);
      expect([...observed.wasmUrls].some((url) => url.includes("document"))).toBe(true);
      expect([...observed.wasmUrls].some((url) => url.includes("presentation"))).toBe(true);
      expect(observed.webSocketUrls.length).toBeGreaterThanOrEqual(3);
      expect(observed.diagnostics).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}\n${await browserDiagnostics(page, observed, api.logs())}`, {
        cause: error,
      });
    } finally {
      observed.stop();
      await Promise.allSettled([page.close(), context.close()]);
    }
  }, 240_000);

  test("two independent browser replicas converge live without remounting the editor", async () => {
    const first = await browser.newContext({ viewport: { width: 1_280, height: 800 } });
    const firstPage = await first.newPage();
    const firstObserved = observeBrowser(firstPage);
    let secondPage: Page | undefined;
    let secondObserved: BrowserObservation | undefined;
    try {
      await firstPage.goto(
        `${demoBaseUrl}/editable-artifacts.html?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const artifact = await createArtifact(firstPage, "Document", "Live replica proof");
      await firstPage.getByRole("button", { name: "Start writing" }).click();
      await firstPage.getByRole("textbox", { name: "Paragraph" }).fill("Replica one");
      await waitForEditorIdle(firstPage, "document");

      secondPage = await first.newPage();
      secondObserved = observeBrowser(secondPage);
      await secondPage.goto(artifact.url);
      const secondParagraph = secondPage.getByRole("textbox", { name: "Paragraph" });
      await secondParagraph.waitFor({ timeout: 30_000 });
      await waitFor(async () => (await secondParagraph.textContent()) === "Replica one", {
        timeoutMs: 30_000,
        describe: () => secondObserved!.diagnostics.join("\n"),
      });

      await secondParagraph.fill("Replica two, converged live");
      await waitForEditorIdle(secondPage, "document");
      const firstParagraph = firstPage.getByRole("textbox", { name: "Paragraph" });
      await waitFor(
        async () => (await firstParagraph.textContent()) === "Replica two, converged live",
        {
          timeoutMs: 30_000,
          describe: () => firstObserved.diagnostics.join("\n"),
        },
      );
      expect(firstObserved.diagnostics).toEqual([]);
      expect(secondObserved.diagnostics).toEqual([]);
    } catch (error) {
      throw new Error(
        `${String(error)}\n[first]\n${await browserDiagnostics(firstPage, firstObserved, api.logs())}${
          secondPage && secondObserved
            ? `\n[second]\n${await browserDiagnostics(secondPage, secondObserved, api.logs())}`
            : ""
        }`,
        { cause: error },
      );
    } finally {
      firstObserved.stop();
      secondObserved?.stop();
      await Promise.allSettled([secondPage?.close(), firstPage.close(), first.close()]);
    }
  }, 120_000);

  async function assertServerAdvanced(
    artifact: Readonly<{ id: string; url: string }>,
  ): Promise<void> {
    const resource = await client.getEditableArtifact(workspaceId, artifact.id, {
      replicaId: createEditableArtifactReplicaId(),
    });
    expect(resource.headSequence).toBeGreaterThan(0);
    expect(resource.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  }
});

function artifactApiEnvironment(
  services: TestServices,
  apiPort: number,
  runtime: Awaited<ReturnType<typeof prepareDevelopmentArtifactRuntime>>,
): Record<string, string | undefined> {
  return {
    OPENGENI_ENVIRONMENT: "test",
    NODE_ENV: "test",
    OPENGENI_DATABASE_URL: services.runtimeDatabaseUrl,
    OPENGENI_NATS_URL: services.natsUrl,
    OPENGENI_TEMPORAL_HOST: services.temporalHost,
    OPENGENI_TEMPORAL_NAMESPACE: "default",
    OPENGENI_TEMPORAL_TASK_QUEUE: `editable-artifact-e2e-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(apiPort),
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_SANDBOX_BACKEND: "none",
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
    OPENGENI_OBJECT_STORAGE_ENDPOINT: services.objectStorageEndpoint,
    // The API process is host-side. Set this explicitly because Bun reloads
    // repository .env files after an omitted child-process variable, which
    // must never restore a workstation/container-only internal endpoint here.
    OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT: services.objectStorageEndpoint,
    OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT: services.objectStorageSandboxEndpoint,
    // ubs:ignore -- disposable MinIO fixture credentials only.
    OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
    // ubs:ignore -- disposable MinIO fixture credentials only.
    OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    OPENGENI_ARTIFACT_RUNTIME_MANIFEST: undefined,
    OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST: runtime.manifestPath,
    OPENGENI_ARTIFACT_TOOL_ENTRY: runtime.skillFacadeEntrypoint,
  };
}

async function openArtifactStart(page: Page): Promise<void> {
  await page.goto(
    `${new URL("editable-artifacts.html", page.url() || "http://127.0.0.1").origin}/editable-artifacts.html?workspaceId=${encodeURIComponent(readWorkspaceId(page.url()))}`,
  );
  await page.getByRole("heading", { name: "Create something worth keeping." }).waitFor({
    timeout: 30_000,
  });
}

async function createArtifact(
  page: Page,
  modality: "Document" | "Spreadsheet" | "Presentation",
  title: string,
): Promise<Readonly<{ id: string; url: string }>> {
  if (!page.url().includes("workspaceId=")) {
    const root = new URL(page.url() || "http://127.0.0.1");
    await page.goto(
      `${root.origin}/editable-artifacts.html?workspaceId=${encodeURIComponent(readWorkspaceId(page.url()))}`,
    );
  }
  await page.getByRole("heading", { name: "Create something worth keeping." }).waitFor({
    timeout: 30_000,
  });
  await page.getByRole("radio", { name: new RegExp(`^${modality}`, "u") }).click();
  await page.getByLabel("Artifact title").fill(title);
  await page.getByRole("button", { name: `Create ${modality.toLowerCase()}` }).click();
  await waitFor(
    () => /^[0-9a-f]{32}$/u.test(new URL(page.url()).searchParams.get("artifactId") ?? ""),
    {
      timeoutMs: 30_000,
    },
  );
  const id = new URL(page.url()).searchParams.get("artifactId")!;
  await page.getByLabel(`${modality}: ${title}`).waitFor({ timeout: 30_000 });
  return Object.freeze({ id, url: page.url() });
}

function readWorkspaceId(url: string): string {
  const workspaceId = new URL(url || "http://127.0.0.1").searchParams.get("workspaceId");
  if (!workspaceId) {
    throw new Error(
      "Editable-artifact E2E requires its workspace ID in the reference-consumer URL",
    );
  }
  return workspaceId;
}

async function waitForEditorIdle(
  page: Page,
  modality: "document" | "spreadsheet" | "presentation",
): Promise<void> {
  const root =
    modality === "document"
      ? page.locator("[data-og-document-editor]")
      : modality === "presentation"
        ? page.locator("[data-og-presentation-editor]")
        : page.locator('[aria-label^="Spreadsheet:"] [data-og-command-state]');
  await waitFor(async () => (await root.getAttribute("data-og-command-state")) === "idle", {
    timeoutMs: 30_000,
  });
}

async function assertReloadedText(page: Page, expected: string): Promise<void> {
  await page.reload();
  const paragraph = page.getByRole("textbox", { name: "Paragraph" });
  await paragraph.waitFor({ timeout: 30_000 });
  expect(await paragraph.textContent()).toBe(expected);
}

function observeBrowser(page: Page): BrowserObservation {
  const diagnosticMessages: string[] = [];
  const lifecycleCancellations: string[] = [];
  const workerStarts: string[] = [];
  const workerUrls = new Set<string>();
  const wasmUrls = new Set<string>();
  const webSocketUrls: string[] = [];
  const onConsole = (message: import("playwright").ConsoleMessage) => {
    if (["error", "warning"].includes(message.type())) {
      diagnosticMessages.push(`console ${message.type()}: ${message.text()}`);
    }
  };
  const onPageError = (error: Error) => diagnosticMessages.push(`page error: ${String(error)}`);
  const onRequest = (request: import("playwright").Request) => {
    const url = request.url();
    if (request.resourceType() === "worker" || url.includes("editable-artifacts-worker")) {
      workerUrls.add(url);
    }
    if (url.endsWith(".wasm") || url.includes("_bg.wasm")) wasmUrls.add(url);
  };
  const onRequestFailed = (request: import("playwright").Request) => {
    const failure = `request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`;
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      pathname.endsWith("/live-ticket") &&
      request.failure()?.errorText === "net::ERR_ABORTED"
    ) {
      lifecycleCancellations.push(failure);
      return;
    }
    diagnosticMessages.push(failure);
  };
  const onWorker = (worker: import("playwright").Worker) => workerStarts.push(worker.url());
  const onWebSocket = (socket: import("playwright").WebSocket) => webSocketUrls.push(socket.url());
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("worker", onWorker);
  page.on("websocket", onWebSocket);
  return Object.freeze({
    diagnostics: diagnosticMessages,
    lifecycleCancellations,
    workerStarts,
    workerUrls,
    wasmUrls,
    webSocketUrls,
    stop() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("worker", onWorker);
      page.off("websocket", onWebSocket);
    },
  });
}

async function browserDiagnostics(
  page: Page,
  observed: BrowserObservation,
  apiLogs: string,
): Promise<string> {
  const body = await page
    .locator("body")
    .innerText()
    .catch((error) => String(error));
  return [
    `url: ${page.url()}`,
    `body: ${body.slice(0, 4_000)}`,
    `workers: ${[...observed.workerUrls].join(", ")}`,
    `wasm: ${[...observed.wasmUrls].join(", ")}`,
    `websockets: ${[...observed.webSocketUrls].join(", ")}`,
    `worker starts: ${observed.workerStarts.join(", ")}`,
    `lifecycle cancellations: ${observed.lifecycleCancellations.join(", ")}`,
    `api logs: ${apiLogs.slice(-8_000)}`,
    ...observed.diagnostics,
  ].join("\n");
}

async function capture(page: Page, filename: string): Promise<void> {
  await page.screenshot({ path: join(evidenceRoot, filename), fullPage: true });
}
