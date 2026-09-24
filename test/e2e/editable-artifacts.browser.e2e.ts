import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import postgres from "postgres";

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
  let evidenceSql: postgres.Sql | undefined;

  beforeAll(async () => {
    try {
      runtimeRoot = join(repoRoot, ".opengeni", `artifact-runtime-e2e-${crypto.randomUUID()}`);
      const runtime = await prepareDevelopmentArtifactRuntime({
        repositoryRoot: repoRoot,
        outputRoot: runtimeRoot,
      });
      services = await startTestServices({ temporal: true, objectStorage: true });
      await services.migrate();
      evidenceSql = postgres(services.databaseUrl, { max: 1, prepare: false });

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
      await Promise.allSettled([
        browser?.close(),
        demo?.stop(),
        api?.stop(),
        evidenceSql?.end({ timeout: 5 }),
        services?.down(),
      ]);
      if (runtimeRoot) await removeTempDir(runtimeRoot).catch(() => undefined);
      throw error;
    }
  }, 420_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([
      browser?.close(),
      demo?.stop(),
      api?.stop(),
      evidenceSql?.end({ timeout: 5 }),
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
    let spreadsheetArtifactId: string | null = null;
    try {
      await page.goto(
        `${demoBaseUrl}/editable-artifacts.html?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const documentArtifact = await createArtifact(page, "Document", "E2E product brief");
      const emptyDocumentSequence = await artifactSequence(documentArtifact);
      await page.getByRole("button", { name: "Start writing" }).click();
      const paragraph = page.getByRole("textbox", { name: "Paragraph" });
      await paragraph.waitFor();
      const paragraphSequence = await waitForArtifactAdvance(
        documentArtifact,
        emptyDocumentSequence,
      );
      await paragraph.fill("Durable document text from the real browser session.");
      await waitForArtifactAdvance(documentArtifact, paragraphSequence);
      await assertReloadedText(page, "Durable document text from the real browser session.");
      await assertServerAdvanced(documentArtifact);
      await capture(page, "editable-artifact-document-dark.png");

      await openArtifactStart(page);
      const spreadsheetArtifact = await createArtifact(page, "Spreadsheet", "E2E operating model");
      spreadsheetArtifactId = spreadsheetArtifact.id;
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
      await recordSpreadsheetCausality(page, spreadsheetArtifact.id, "before-first-reload");
      await page.reload();
      await recordSpreadsheetCausality(page, spreadsheetArtifact.id, "after-first-reload");
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
      await recordSpreadsheetCausality(page, spreadsheetArtifact.id, "before-second-reload");
      await page.reload();
      await recordSpreadsheetCausality(page, spreadsheetArtifact.id, "after-second-reload");
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
      const selectedObjectStatus = page.locator('[role="status"][id$="-presentation-selection"]');
      await selectedObjectStatus.waitFor({ state: "attached" });
      expect(await selectedObjectStatus.textContent()).toContain(". Position ");
      await slideEditor.focus();
      expect(await slideEditor.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      await slideEditor.press("Enter");
      const textBox = page.getByRole("textbox", { name: "Edit Text box" });
      await textBox.waitFor();
      await textBox.fill("A real Worker/WASM slide");
      await textBox.press("Control+Enter");
      await waitForEditorIdle(page, "presentation");
      await page.reload();
      await page.getByRole("option", { name: /^Slide 1/u }).waitFor({ timeout: 30_000 });
      const reloadedSlideEditor = page.getByRole("application", { name: "Slide 1 editor" });
      await reloadedSlideEditor.focus();
      expect(
        await reloadedSlideEditor.evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await reloadedSlideEditor.press("]");
      await selectedObjectStatus.waitFor({ state: "attached" });
      expect(await selectedObjectStatus.textContent()).toContain(". Position ");
      await reloadedSlideEditor.press("Enter");
      expect(await page.getByRole("textbox", { name: "Edit Text box" }).inputValue()).toBe(
        "A real Worker/WASM slide",
      );
      await page.keyboard.press("Escape");
      await capture(page, "editable-artifact-presentation-dark.png");

      for (let index = 0; index < 2; index += 1) {
        await page.getByRole("button", { name: "Add slide" }).click();
        await waitForEditorIdle(page, "presentation");
      }
      const desktopViewport = page.viewportSize()!;
      const rail = page.locator("[data-og-slide-rail]");
      await rail.focus();
      await page.keyboard.press("Home");
      await page.locator('[data-og-slide-index="0"][aria-selected="true"]').waitFor();
      await page.keyboard.press("End");
      await page.locator('[data-og-slide-index="2"][aria-selected="true"]').waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      expect(await rail.isVisible()).toBe(false);
      const slideChooser = page.getByRole("button", { name: "Choose slide", exact: true });
      await slideChooser.click();
      const mobileSlides = page.locator("[data-og-mobile-slide-list]");
      const mobileBounds = await mobileSlides.boundingBox();
      expect(mobileBounds).not.toBeNull();
      expect(mobileBounds!.width).toBeGreaterThan(160);
      expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
      expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390);
      expect(await mobileSlides.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      await page.locator('[data-og-mobile-slide-index="0"]').click();
      await mobileSlides.waitFor({ state: "detached" });
      expect(await slideChooser.textContent()).toContain("1 / 3");
      expect(await slideChooser.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      await slideChooser.click();
      await page.keyboard.press("Escape");
      await mobileSlides.waitFor({ state: "detached" });
      expect(await slideChooser.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      await page.setViewportSize(desktopViewport);
      expect(await rail.isVisible()).toBe(true);
      expect(await slideChooser.isVisible()).toBe(false);

      expect(observed.workerStarts.length).toBeGreaterThanOrEqual(3);
      expect(observed.wasmUrls.size).toBeGreaterThanOrEqual(3);
      expect([...observed.wasmUrls].some((url) => url.includes("spreadsheet"))).toBe(true);
      expect([...observed.wasmUrls].some((url) => url.includes("document"))).toBe(true);
      expect([...observed.wasmUrls].some((url) => url.includes("presentation"))).toBe(true);
      expect(observed.webSocketUrls.length).toBeGreaterThanOrEqual(3);
      expect(observed.diagnostics).toEqual([]);
    } catch (error) {
      if (
        spreadsheetArtifactId !== null &&
        new URL(page.url()).searchParams.get("artifactId") === spreadsheetArtifactId
      ) {
        await recordSpreadsheetCausality(page, spreadsheetArtifactId, "failure");
      }
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
      const emptyDocumentSequence = await artifactSequence(artifact);
      await firstPage.getByRole("button", { name: "Start writing" }).click();
      const firstParagraph = firstPage.getByRole("textbox", { name: "Paragraph" });
      await firstParagraph.waitFor();
      const paragraphSequence = await waitForArtifactAdvance(artifact, emptyDocumentSequence);
      await firstParagraph.fill("Replica one");
      const replicaOneSequence = await waitForArtifactAdvance(artifact, paragraphSequence);

      secondPage = await first.newPage();
      secondObserved = observeBrowser(secondPage);
      await secondPage.goto(artifact.url);
      const secondParagraph = secondPage.getByRole("textbox", { name: "Paragraph" });
      await secondParagraph.waitFor({ timeout: 30_000 });
      await waitFor(async () => (await secondParagraph.textContent()) === "Replica one", {
        timeoutMs: 30_000,
        describe: () => secondObserved!.diagnostics.join("\n"),
      });

      // The document editor deliberately leaves the focused contentEditable
      // under browser/IME ownership. Surrender that local editing lease before
      // asserting that a remote projection replaces its DOM.
      await firstParagraph.blur();
      await secondParagraph.fill("Replica two, converged live");
      await waitForArtifactAdvance(artifact, replicaOneSequence);
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

  async function artifactSequence(artifact: Readonly<{ id: string }>): Promise<number> {
    const resource = await client.getEditableArtifact(workspaceId, artifact.id, {
      replicaId: createEditableArtifactReplicaId(),
    });
    return resource.headSequence;
  }

  async function waitForArtifactAdvance(
    artifact: Readonly<{ id: string }>,
    afterSequence: number,
  ): Promise<number> {
    const replicaId = createEditableArtifactReplicaId();
    let observedSequence = afterSequence;
    await waitFor(
      async () => {
        const resource = await client.getEditableArtifact(workspaceId, artifact.id, { replicaId });
        observedSequence = resource.headSequence;
        return observedSequence > afterSequence;
      },
      {
        timeoutMs: 30_000,
        describe: () =>
          `artifact ${artifact.id} did not advance beyond ${afterSequence}; observed ${observedSequence}`,
      },
    );
    return observedSequence;
  }

  async function recordSpreadsheetCausality(
    page: Page,
    artifactId: string,
    stage: string,
  ): Promise<void> {
    // Metadata only, from this test's disposable Postgres and browser storage.
    // Diagnostic failures must never change the browser acceptance result.
    const [authority, retained] = await Promise.allSettled([
      (async () => {
        if (!evidenceSql) throw new Error("diagnostic database unavailable");
        const rows = await evidenceSql<
          { headSequence: string | number; causalFrontier: unknown; stateHash: string }[]
        >`
          select head_sequence as "headSequence", causal_frontier as "causalFrontier",
            state_hash as "stateHash"
          from editable_artifacts
          where workspace_id = ${workspaceId}::uuid and id = ${artifactId}
        `;
        const head = rows[0];
        return head
          ? {
              sequence: Number(head.headSequence),
              frontier: head.causalFrontier,
              stateHash: head.stateHash,
            }
          : null;
      })(),
      readRetainedSpreadsheetCausality(page, artifactId),
    ]);
    console.info(
      `[editable-artifact-causality] ${JSON.stringify({
        stage,
        sampledAt: new Date().toISOString(),
        authority: authority.status === "fulfilled" ? authority.value : { unavailable: true },
        retained: retained.status === "fulfilled" ? retained.value : { unavailable: true },
      })}`,
    );
  }
});

async function readRetainedSpreadsheetCausality(page: Page, artifactId: string) {
  return await page.evaluate(async (id) => {
    const name = "opengeni-editable-artifacts";
    if (!(await indexedDB.databases()).some((database) => database.name === name)) {
      return { status: "no-browser-database" };
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = ["replicas", "snapshots", "committedTransactions", "pendingTransactions"];
      if (stores.some((store) => !database.objectStoreNames.contains(store))) {
        return { status: "browser-stores-unavailable" };
      }
      const transaction = database.transaction(stores, "readonly");
      type Stored = {
        artifactId: string;
        cursor?: number;
        sequence?: number;
        startSequence?: number;
        endSequence?: number;
        stateHash?: string;
        causalFrontier?: unknown;
        replicaId?: string;
        replicaCounter?: number;
        previousLocalTransactionId?: string | null;
        clientTransactionId?: string;
        requestHash?: string;
        observedHeadSequence?: number;
        causalBase?: unknown;
        intentBytes?: Uint8Array;
      };
      const read = (store: string) =>
        new Promise<Stored[]>((resolve, reject) => {
          const request = transaction.objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as Stored[]);
          request.onerror = () => reject(request.error);
        });
      const [heads, snapshots, commits, pending] = await Promise.all(stores.map(read));
      const matches = (value: Stored) => value.artifactId === id;
      return {
        head: heads.filter(matches).map(({ cursor, stateHash }) => ({ cursor, stateHash })),
        snapshots: snapshots.filter(matches).map(({ sequence, causalFrontier, stateHash }) => ({
          sequence,
          causalFrontier,
          stateHash,
        })),
        committed: commits
          .filter(matches)
          .map(({ startSequence, endSequence, causalFrontier, stateHash, requestHash }) => ({
            startSequence,
            endSequence,
            causalFrontier,
            stateHash,
            requestHash,
          })),
        pending: pending
          .filter(matches)
          .map(
            ({
              replicaId,
              replicaCounter,
              previousLocalTransactionId,
              clientTransactionId,
              requestHash,
              observedHeadSequence,
              causalBase,
              intentBytes,
            }) => ({
              replicaId,
              replicaCounter,
              previousLocalTransactionId,
              clientTransactionId,
              requestHash,
              observedHeadSequence,
              causalBase,
              intentByteLength: intentBytes?.byteLength,
            }),
          ),
      };
    } finally {
      database.close();
    }
  }, artifactId);
}

function artifactApiEnvironment(
  services: TestServices,
  apiPort: number,
  runtime: Awaited<ReturnType<typeof prepareDevelopmentArtifactRuntime>>,
): Record<string, string | undefined> {
  return {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_PRODUCT_ACCESS_MODE: "local",
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
    OPENGENI_OBJECT_STORAGE_S3_PROVIDER: services.objectStorageS3Provider,
    OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: services.objectStorageAccessKeyId,
    OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: services.objectStorageSecretAccessKey,
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
