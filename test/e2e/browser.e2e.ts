import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import postgres from "postgres";
import { migrate } from "@opengeni/db/migrate";
import { SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID } from "@opengeni/core";
import { Client as TemporalClient, Connection as TemporalConnection } from "@temporalio/client";
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
      const env = stackEnv(services, apiPort, "browser-command-control");
      api = await startProcess(["bun", "apps/api/src/index.ts"], {
        cwd: repoRoot,
        env,
        ready: async () => {
          const request = new Request(`http://127.0.0.1:${apiPort}/healthz`, {
            signal: AbortSignal.timeout(1_000),
          });
          return (await fetch(request).catch(() => null))?.ok === true;
        },
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
          ready: async () => {
            const request = new Request(`http://127.0.0.1:${webPort}`, {
              signal: AbortSignal.timeout(1_000),
            });
            return (await fetch(request).catch(() => null))?.ok === true;
          },
          timeoutMs: 45_000,
        },
      );
    } catch (error) {
      await Promise.allSettled([browser?.close(), web?.stop(), worker?.stop(), api?.stop()]);
      await services?.down().catch(() => undefined);
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    const processResults = await Promise.allSettled([
      browser?.close(),
      web?.stop(),
      worker?.stop(),
      api?.stop(),
    ]);
    const serviceResults = await Promise.allSettled([services?.down()]);
    const failures = [...processResults, ...serviceResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "browser E2E teardown failed");
    }
  }, 120_000);

  test("streams markdown updates to multiple clients and replays after refresh", async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    const browserObservation = observePageFailures(pageA);
    const response = await pageA.goto(`http://127.0.0.1:${webPort}`);
    expect(response?.ok()).toBe(true);
    try {
      await pageA.getByRole("button", { name: "Model and effort" }).click();
    } catch (error) {
      browserObservation.stop();
      throw new Error(
        `OpenGeni home did not become interactive: ${String(error)}\n${await pageDiagnostics(pageA, browserObservation.diagnostics)}\n[web]\n${web.logs()}\n[api]\n${api.logs()}\n[workers]\n${worker.logs()}`,
        { cause: error },
      );
    }
    browserObservation.stop();
    await pageA.getByTestId("model-picker-content").waitFor({ timeout: 10_000 });
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

  test("runs Send, queue mutations, Steer, Pause, Resume, lost responses, reload, and two-tab reconciliation through the real worker", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const secondPage = await context.newPage();
    const diagnostics = observePageFailures(page);
    let coordinates: BrowserSessionCoordinates | null = null;
    let turnWorkerSuspended = false;
    try {
      if (process.platform !== "win32") {
        turnWorkerSuspended = worker.turns.proc.kill("SIGSTOP");
        expect(turnWorkerSuspended).toBe(true);
      }
      const response = await page.goto(`http://127.0.0.1:${webPort}`);
      expect(response?.ok()).toBe(true);
      await page.evaluate(() => {
        const browserWindow = window as typeof window & {
          __opengeniFirstSendTrace?: {
            failures: string[];
            main: Element | null;
            observer: MutationObserver;
          };
        };
        const failures: string[] = [];
        const main = document.querySelector("main");
        const sample = () => {
          if (!/\/sessions\/[^/]+$/.test(window.location.pathname)) return;
          const text = document.body.innerText;
          if (text.includes("Opening session")) failures.push("Opening session");
          if (text.includes("Loading conversation")) failures.push("Loading conversation");
          if (text.includes("Queued to start")) failures.push("Queued to start");
          const scroller = document.querySelector("[data-og-timeline-scroller]");
          if (scroller && getComputedStyle(scroller).visibility === "hidden") {
            failures.push("hidden timeline");
          }
          if (document.querySelector("main") !== main) failures.push("replaced app canvas");
        };
        const observer = new MutationObserver(sample);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class", "style"],
        });
        browserWindow.__opengeniFirstSendTrace = { failures, main, observer };
      });
      await page
        .getByPlaceholder("Describe a task for the agent…")
        .fill("E2E HOLD INITIAL DIRECTION");
      await page.getByRole("button", { name: "Send" }).click();
      await waitFor(() => /\/workspaces\/[^/]+\/sessions\/[^/]+$/.test(page.url()), {
        timeoutMs: 15_000,
      });
      coordinates = sessionCoordinates(page.url());
      const sessionUrl = page.url();
      const timeline = page.getByTestId("session-timeline");
      const composer = page.getByRole("textbox", { name: "Message the agent" });
      const queueChip = page.getByTestId("session-chrome-queue");

      await timeline.getByText("E2E HOLD INITIAL DIRECTION", { exact: true }).waitFor();
      if (turnWorkerSuspended) {
        expect((await browserQueueSnapshot(page, apiPort, coordinates)).items).toEqual([]);
        expect(await queueChip.getByText(/queued prompt/).count()).toBe(0);
        expect(
          await timeline.getByText("E2E HOLD INITIAL DIRECTION", { exact: true }).count(),
        ).toBe(1);
        expect(worker.turns.proc.kill("SIGCONT")).toBe(true);
        turnWorkerSuspended = false;
      }
      const firstSendFailures = await page.evaluate(() => {
        const browserWindow = window as typeof window & {
          __opengeniFirstSendTrace?: {
            failures: string[];
            observer: MutationObserver;
          };
        };
        browserWindow.__opengeniFirstSendTrace?.observer.disconnect();
        return browserWindow.__opengeniFirstSendTrace?.failures ?? ["trace missing"];
      });
      expect(firstSendFailures).toEqual([]);
      await timeline.getByText("E2E HOLD ACTIVE", { exact: false }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Pause this workstream" }).waitFor();

      // Click at the first actionable frame of the optimistic→authoritative
      // queue-row handoff. The button must not lose the pointer gesture while
      // React replaces the optimistic row with durable queue truth.
      await submitSessionPrompt(page, composer, "E2E HOLD EARLIEST STEER", {
        waitForResponse: false,
      });
      await queueChip.getByText("1 queued prompt", { exact: true }).waitFor();
      await queueChip.click();
      const earliestSteerResponse = page.waitForResponse(
        (candidateResponse) =>
          candidateResponse.request().method() === "POST" &&
          /\/queue\/[^/]+\/steer$/.test(new URL(candidateResponse.url()).pathname),
        { timeout: 20_000 },
      );
      await page.getByRole("button", { name: "Steer queued prompt 1" }).click();
      expect((await earliestSteerResponse).status()).toBe(200);
      await timeline.getByText("E2E HOLD EARLIEST STEER", { exact: true }).waitFor();
      await waitFor(
        async () => (await browserQueueSnapshot(page, apiPort, coordinates)).items.length === 0,
        { timeoutMs: 15_000 },
      );

      await submitSessionPrompt(page, composer, "E2E QUEUED FIRST");
      await queueChip.getByText("1 queued prompt", { exact: true }).waitFor();
      expect(await timeline.getByText("E2E QUEUED FIRST", { exact: true }).count()).toBe(0);
      await submitSessionPrompt(page, composer, "E2E HOLD QUEUED SECOND");
      await queueChip.getByText("2 queued prompts", { exact: true }).waitFor();
      if ((await queueChip.getAttribute("aria-expanded")) !== "true") await queueChip.click();
      const queue = page.getByRole("list", { name: "Queued prompts" });
      const rows = queue.getByRole("listitem");
      await waitFor(async () => (await rows.count()) === 2, { timeoutMs: 10_000 });
      expect(await rows.nth(0).innerText()).toContain("E2E QUEUED FIRST");
      expect(await rows.nth(1).innerText()).toContain("E2E HOLD QUEUED SECOND");

      await page.getByRole("button", { name: "Move queued prompt 2 up" }).click();
      await waitFor(async () => (await rows.nth(0).innerText()).includes("E2E HOLD QUEUED SECOND"));
      await page.getByRole("button", { name: "Move queued prompt 1 down" }).click();
      await waitFor(async () => (await rows.nth(1).innerText()).includes("E2E HOLD QUEUED SECOND"));

      await page.getByRole("button", { name: "Edit queued prompt 2" }).click();
      await waitFor(async () => (await composer.inputValue()) === "E2E HOLD QUEUED SECOND");
      await queueChip.getByText("1 queued prompt", { exact: true }).waitFor();
      await submitSessionPrompt(page, composer, "E2E HOLD QUEUED SECOND EDITED");
      await queueChip.getByText("2 queued prompts", { exact: true }).waitFor();
      await waitForQueuePrompts(page, apiPort, coordinates, [
        "E2E QUEUED FIRST",
        "E2E HOLD QUEUED SECOND EDITED",
      ]);

      await page.reload();
      await page.getByRole("textbox", { name: "Message the agent" }).waitFor();
      expect(await page.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe("");
      await page
        .getByTestId("session-chrome-queue")
        .getByText("2 queued prompts", { exact: true })
        .waitFor();
      await waitForQueuePrompts(page, apiPort, coordinates, [
        "E2E QUEUED FIRST",
        "E2E HOLD QUEUED SECOND EDITED",
      ]);
      const reloadedQueueChip = page.getByTestId("session-chrome-queue");
      if ((await reloadedQueueChip.getAttribute("aria-expanded")) !== "true") {
        await reloadedQueueChip.click();
      }
      await page.getByRole("button", { name: "Remove queued prompt 1" }).click();
      await reloadedQueueChip.getByText("1 queued prompt", { exact: true }).waitFor();
      await waitForQueuePrompts(page, apiPort, coordinates, ["E2E HOLD QUEUED SECOND EDITED"]);
      expect(await page.getByTestId("session-timeline").getByText("E2E QUEUED FIRST").count()).toBe(
        0,
      );

      const beforeSteer = await browserQueueSnapshot(page, apiPort, coordinates);
      const steeredTurnId = beforeSteer.items[0]?.id;
      if (!steeredTurnId) throw new Error("expected one durable queued turn before Steer");
      const steerPath = `/v1/workspaces/${coordinates.workspaceId}/sessions/${coordinates.sessionId}/queue/${steeredTurnId}/steer`;
      let steerCommitStatus: number | null = null;
      await page.route(`**${steerPath}`, async (route) => {
        if (steerCommitStatus !== null) return await route.continue();
        const committed = await route.fetch();
        steerCommitStatus = committed.status();
        await route.abort("connectionfailed");
      });
      await page.getByRole("button", { name: "Steer queued prompt 1" }).click();
      await page
        .getByTestId("session-timeline")
        .getByText("E2E HOLD QUEUED SECOND EDITED", { exact: true })
        .waitFor({ timeout: 20_000 });
      await waitFor(() => steerCommitStatus !== null, {
        timeoutMs: 20_000,
        describe: () => "the committed queue Steer response did not settle",
      });
      expect(steerCommitStatus).toBe(200);
      expect(await page.getByText("Changing direction…", { exact: true }).count()).toBe(0);
      await waitFor(
        async () => (await browserQueueSnapshot(page, apiPort, coordinates)).items.length === 0,
        { timeoutMs: 15_000 },
      );
      await page.unroute(`**${steerPath}`);

      // Reload while the replacement is really executing. The accepted Steer
      // remains a single chat message and never falls back into the queue.
      await page.reload();
      const steeredMessage = page
        .getByTestId("session-timeline")
        .getByText("E2E HOLD QUEUED SECOND EDITED", { exact: true });
      await steeredMessage.waitFor();
      expect(await steeredMessage.count()).toBe(1);
      expect((await browserQueueSnapshot(page, apiPort, coordinates)).items).toEqual([]);

      const reloadedComposer = page.getByRole("textbox", { name: "Message the agent" });
      await reloadedComposer.fill("E2E FAST DIRECT STEER");
      await waitFor(
        async () =>
          !(await page
            .getByRole("button", { name: /Send message|Add message to queue/ })
            .isDisabled()),
        {
          timeoutMs: 30_000,
          describe: () => "the composer did not become ready for direct Steer after reload",
        },
      );
      await reloadedComposer.press("ControlOrMeta+Enter");
      await page
        .getByTestId("session-timeline")
        .getByText("E2E FAST DIRECT STEER", { exact: true })
        .waitFor();
      await page
        .getByTestId("session-timeline")
        .getByText("E2E FAST COMPLETE", { exact: true })
        .last()
        .waitFor({ timeout: 30_000 });
      await waitForSessionStatus(page, apiPort, coordinates, "idle");

      // A committed Pause whose HTTP response is lost must still reconcile as
      // Paused, without leaving the button spinning or surfacing a false error.
      const controlPath = `/v1/workspaces/${coordinates.workspaceId}/sessions/${coordinates.sessionId}/control`;
      let pauseCommitStatus: number | null = null;
      await page.route(`**${controlPath}`, async (route) => {
        if (route.request().method() !== "POST" || pauseCommitStatus !== null) {
          return await route.continue();
        }
        const committed = await route.fetch();
        pauseCommitStatus = committed.status();
        await route.abort("connectionfailed");
      });
      await page.getByRole("button", { name: "Pause this workstream" }).click();
      await page.getByRole("button", { name: "Resume this workstream" }).waitFor({
        timeout: 20_000,
      });
      await waitFor(() => pauseCommitStatus !== null, {
        timeoutMs: 20_000,
        describe: () => "the committed Pause response did not settle",
      });
      expect(pauseCommitStatus).toBe(200);
      expect(await page.getByText("Pause requested", { exact: true }).count()).toBe(0);
      await page.unroute(`**${controlPath}`);

      // A queued Send whose committed response is lost must appear once in the
      // durable queue, remain outside chat, and keep the durable draft empty.
      const submitPath = `/v1/workspaces/${coordinates.workspaceId}/sessions/${coordinates.sessionId}/composer-draft/submit`;
      let submitCommitStatus: number | null = null;
      await page.route(`**${submitPath}`, async (route) => {
        if (submitCommitStatus !== null) return await route.continue();
        const committed = await route.fetch();
        submitCommitStatus = committed.status();
        await route.abort("connectionfailed");
      });
      const pausedComposer = page.getByRole("textbox", { name: "Message the agent" });
      await submitSessionPrompt(page, pausedComposer, "E2E FAST PAUSED LOST RESPONSE", {
        waitForResponse: false,
      });
      await page
        .getByTestId("session-chrome-queue")
        .getByText("1 queued prompt", { exact: true })
        .waitFor({ timeout: 20_000 });
      await waitFor(() => submitCommitStatus !== null, {
        timeoutMs: 20_000,
        describe: () => "the committed queued Send response did not settle",
      });
      expect(submitCommitStatus).toBe(202);
      expect(
        await page
          .getByTestId("session-timeline")
          .getByText("E2E FAST PAUSED LOST RESPONSE", { exact: true })
          .count(),
      ).toBe(0);
      await page.unroute(`**${submitPath}`);

      await page.reload();
      await page.getByRole("button", { name: "Resume this workstream" }).waitFor();
      expect(await page.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe("");
      const persistedQueue = await browserQueueSnapshot(page, apiPort, coordinates);
      expect(persistedQueue.items.map((item) => item.prompt)).toEqual([
        "E2E FAST PAUSED LOST RESPONSE",
      ]);
      expect((await browserComposerDraft(page, apiPort, coordinates)).text).toBe("");

      await secondPage.goto(sessionUrl);
      await secondPage.getByRole("button", { name: "Resume this workstream" }).waitFor();
      await secondPage
        .getByTestId("session-chrome-queue")
        .getByText("1 queued prompt", { exact: true })
        .waitFor();
      const completedBeforeResume = await page
        .getByTestId("session-timeline")
        .getByText("E2E FAST COMPLETE", { exact: true })
        .count();
      await page.getByRole("button", { name: "Resume this workstream" }).click();
      await page.getByRole("button", { name: "Pause this workstream" }).waitFor();
      await secondPage.getByRole("button", { name: "Pause this workstream" }).waitFor({
        timeout: 15_000,
      });
      for (const client of [page, secondPage]) {
        await waitFor(
          async () =>
            (await client
              .getByTestId("session-timeline")
              .getByText("E2E FAST COMPLETE", { exact: true })
              .count()) > completedBeforeResume,
          {
            timeoutMs: 30_000,
            describe: () => "the resumed queued prompt did not produce a new completion",
          },
        );
      }
      await waitForSessionStatus(page, apiPort, coordinates, "idle");
      expect((await browserQueueSnapshot(page, apiPort, coordinates)).items).toEqual([]);
      expect((await browserComposerDraft(page, apiPort, coordinates)).text).toBe("");

      // Prove the durable owner independently of every immediate optimization:
      // manufacture one committed, due wake revision and do not trigger it.
      // The production 10-second Schedule must claim and acknowledge it.
      const repairRevision = await registerWorkflowWakeRepairProbe(
        services.databaseUrl,
        coordinates,
      );
      await waitFor(
        async () =>
          await workflowWakeRepairProbeDelivered(services.databaseUrl, coordinates, repairRevision),
        {
          timeoutMs: 30_000,
          describe: () => `scheduled repair did not deliver wake revision ${repairRevision}`,
        },
      );
      // Reloads intentionally abort optional reads, and the three lost-response
      // cases intentionally surface request failures. Core command outcomes are
      // asserted above through both the rendered UI and authoritative API.
      expect(diagnostics.diagnostics.filter((entry) => entry.startsWith("page error:"))).toEqual(
        [],
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n[wake schedule]\n${await sessionWorkflowWakeScheduleDiagnostics(services.temporalHost)}\n${await pageDiagnostics(page, diagnostics.diagnostics)}\n[command state]\n${await sessionCommandDiagnostics(services.databaseUrl, coordinates)}\n[api]\n${api.logs()}\n[workers]\n${worker.logs()}`,
        { cause: error },
      );
    } finally {
      if (turnWorkerSuspended) worker.turns.proc.kill("SIGCONT");
      diagnostics.stop();
      await context.close();
    }
  }, 240_000);

  test("uploads an image from the composer, persists its resource, and survives refresh", async () => {
    const page = await browser.newPage({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
    });
    await installThemeAndWindowOpenCapture(page, "light");
    const providerMethods: string[] = [];
    const uploadResponses: Array<{ method: string; path: string; status: number; body: string }> =
      [];
    const observeProviderRequest = (request: import("playwright").Request) => {
      const url = new URL(request.url());
      if (url.hostname === "127.0.0.1" && Number(url.port) === services.minioPort) {
        providerMethods.push(request.method());
      }
    };
    page.on("request", observeProviderRequest);
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (!url.pathname.includes("/files/uploads")) return;
      uploadResponses.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        body:
          response.status() >= 400
            ? await response.text().catch(() => "<unreadable>")
            : "<success body omitted>",
      });
    });
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2GQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.goto(`http://127.0.0.1:${webPort}`);

    // Coarse-touch picker + remove first: mobile attachment entry lives under
    // the compact overflow, drives the same hidden input, and removing a
    // completed draft attachment never overflows the composer or leaves a dead chip.
    const more = page.getByRole("button", { name: "More composer actions" });
    await more.waitFor();
    await expectCoarseTarget(more);
    await more.tap();
    const attach = page.getByRole("menuitem", { name: "Add photos & files" });
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
    providerMethods.length = 0;
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
    await page.getByText("Uploading", { exact: true }).waitFor({
      state: "hidden",
      timeout: 15_000,
    });
    const retryUpload = page.getByRole("button", { name: "Retry e2e screenshot.png" });
    if ((await retryUpload.count()) > 0) {
      throw new Error(
        `reattached upload failed: ${await retryUpload.evaluate(
          (element) => element.parentElement?.parentElement?.innerText ?? "unknown error",
        )}\n[upload responses]\n${JSON.stringify(uploadResponses, null, 2)}\n[api]\n${api.logs()}`,
      );
    }
    await more.focus();
    expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);

    await page.getByPlaceholder("Describe a task for the agent…").fill("inspect the screenshot");
    const send = page.getByRole("button", { name: "Send message" });
    await waitFor(async () => !(await send.isDisabled()), {
      timeoutMs: 10_000,
      describe: () => "file-backed composer did not become ready after upload finalization",
    });
    await send.click();
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
    if (services.minioPort === undefined) {
      throw new Error("browser E2E object storage port is unavailable");
    }
    const downloadResult = await page.evaluate(
      async ({ url, expectedPort }) => {
        if (!url) {
          throw new Error("download did not produce a URL");
        }
        const parsed = new URL(url);
        if (parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== expectedPort) {
          throw new Error(`download URL points outside the owned test object store: ${url}`);
        }
        const response = await fetch(parsed, { signal: AbortSignal.timeout(10_000) });
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          size: (await response.arrayBuffer()).byteLength,
        };
      },
      { url: downloadUrl, expectedPort: services.minioPort },
    );
    expect(downloadResult).toEqual({
      status: 200,
      contentType: "image/png",
      size: image.byteLength,
    });

    // The session API is the agent's durable resource source. Verify it has
    // exactly one ready file reference before and after reconnect/replay.
    const sessionMatch = page.url().match(/workspaces\/([^/]+)\/sessions\/([^/]+)$/);
    if (!sessionMatch) {
      throw new Error(`session URL did not contain workspace and session ids: ${page.url()}`);
    }
    const [, workspaceId, sessionId] = sessionMatch;
    const resourceCount = async () =>
      await page.evaluate(
        async ({
          apiPort: browserApiPort,
          workspaceId: targetWorkspaceId,
          sessionId: targetSessionId,
        }) => {
          const request = new Request(
            `http://127.0.0.1:${browserApiPort}/v1/workspaces/${targetWorkspaceId}/sessions/${targetSessionId}`,
            { signal: AbortSignal.timeout(10_000) },
          );
          const response = await fetch(request);
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
    await captureEvidence(page, "fileupload-mobile-light.png");

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
      await captureEvidence(client, `fileupload-${variant.name}.png`);
      await client.close();
    }
    page.off("request", observeProviderRequest);
    await page.close();
  }, 180_000);
});

function stackEnv(
  services: TestServices,
  apiPort: number,
  scenario: string,
): Record<string, string> {
  // ubs:ignore -- fixed credentials for an isolated disposable object-storage fixture, never a deploy secret.
  return {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_DATABASE_URL: services.runtimeDatabaseUrl,
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
    // The API runs on the host in this E2E topology. Override any repo-level
    // Docker-only `garage:3900` default so authenticated HEAD/read/write calls
    // exercise the same owned fixture through its reachable host port.
    OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT: services.objectStorageEndpoint!,
    OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT: services.objectStorageSandboxEndpoint!,
    OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: services.objectStorageAccessKeyId!,
    OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: services.objectStorageSecretAccessKey!,
    OPENGENI_TEST_SCENARIO: scenario,
  };
}

function observePageFailures(page: import("playwright").Page): {
  diagnostics: string[];
  stop: () => void;
} {
  const diagnostics: string[] = [];
  const observeConsole = (message: import("playwright").ConsoleMessage) => {
    if (["error", "warning"].includes(message.type())) {
      diagnostics.push(`console ${message.type()}: ${message.text()}`);
    }
  };
  const observePageError = (error: Error) => diagnostics.push(`page error: ${String(error)}`);
  const observeFailedRequest = (request: import("playwright").Request) =>
    diagnostics.push(
      `request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    );
  page.on("console", observeConsole);
  page.on("pageerror", observePageError);
  page.on("requestfailed", observeFailedRequest);
  return {
    diagnostics,
    stop: () => {
      page.off("console", observeConsole);
      page.off("pageerror", observePageError);
      page.off("requestfailed", observeFailedRequest);
    },
  };
}

async function pageDiagnostics(
  page: import("playwright").Page,
  diagnostics: string[],
): Promise<string> {
  const body = await page
    .locator("body")
    .innerText()
    .catch((error) => `unavailable: ${String(error)}`);
  return [
    `url: ${page.url()}`,
    `title: ${await page.title().catch((error) => `unavailable: ${String(error)}`)}`,
    `body: ${body.slice(0, 4_000)}`,
    ...diagnostics,
  ].join("\n");
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

type BrowserSessionCoordinates = {
  workspaceId: string;
  sessionId: string;
};

async function registerWorkflowWakeRepairProbe(
  databaseUrl: string,
  coordinates: BrowserSessionCoordinates,
): Promise<number> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql`
      update session_workflow_wake_outbox
      set wake_revision = wake_revision + 1,
        reason = 'e2e_schedule_repair_probe',
        attempts = 0,
        next_attempt_at = now(),
        last_error = null,
        updated_at = now()
      where workspace_id = ${coordinates.workspaceId}::uuid
        and session_id = ${coordinates.sessionId}::uuid
      returning wake_revision
    `;
    const revision = Number(rows[0]?.wake_revision);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error("workflow wake repair probe had no valid outbox revision");
    }
    return revision;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function workflowWakeRepairProbeDelivered(
  databaseUrl: string,
  coordinates: BrowserSessionCoordinates,
  wakeRevision: number,
): Promise<boolean> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql`
      select delivered_revision
      from session_workflow_wake_outbox
      where workspace_id = ${coordinates.workspaceId}::uuid
        and session_id = ${coordinates.sessionId}::uuid
    `;
    return Number(rows[0]?.delivered_revision ?? 0) >= wakeRevision;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function sessionWorkflowWakeScheduleDiagnostics(temporalHost: string): Promise<string> {
  const connection = await TemporalConnection.connect({ address: temporalHost });
  try {
    const temporal = new TemporalClient({ connection, namespace: "default" });
    const description = await temporal.schedule
      .getHandle(SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID)
      .describe();
    return JSON.stringify(
      {
        state: description.state,
        spec: description.spec,
        action: description.action,
        info: description.info,
      },
      null,
      2,
    );
  } catch (error) {
    return `schedule diagnostic failed: ${String(error)}`;
  } finally {
    await connection.close();
  }
}

async function sessionCommandDiagnostics(
  databaseUrl: string,
  coordinates: BrowserSessionCoordinates | null,
): Promise<string> {
  if (!coordinates) return "session coordinates unavailable";
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const sessions = await sql`
      select id, status, active_turn_id, temporal_workflow_id, queue_version,
        direct_control_state, direct_pause_revision, subtree_run_override_revision,
        control_version, updated_at
      from sessions
      where workspace_id = ${coordinates.workspaceId}::uuid
        and id = ${coordinates.sessionId}::uuid
    `;
    const turns = await sql`
      select id, status, source, position, prompt, version, execution_generation,
        active_attempt_id, created_at, updated_at
      from session_turns
      where workspace_id = ${coordinates.workspaceId}::uuid
        and session_id = ${coordinates.sessionId}::uuid
      order by position
    `;
    const attempts = await sql`
      select id, turn_id, execution_generation, state, outcome,
        verified_control_revision, started_at, updated_at, closed_at, quiesced_at
      from session_turn_attempts
      where workspace_id = ${coordinates.workspaceId}::uuid
        and session_id = ${coordinates.sessionId}::uuid
      order by started_at desc
      limit 5
    `;
    const interruptions = await sql`
      select id, operation_id, attempt_id, kind, control_revision, state,
        requested_at, delivered_at, acknowledged_at, settled_at
      from session_attempt_interruptions
      where workspace_id = ${coordinates.workspaceId}::uuid
        and session_id = ${coordinates.sessionId}::uuid
      order by requested_at desc
      limit 5
    `;
    const wakes = await sql`
      select session_id, temporal_workflow_id, wake_revision, delivered_revision,
        control_revision, reason, attempts, next_attempt_at, last_error, updated_at
      from session_workflow_wake_outbox
      where workspace_id = ${coordinates.workspaceId}::uuid
        and session_id = ${coordinates.sessionId}::uuid
    `;
    const receipts = await sql`
      select action, operation_key, applied_control_revision, applied_queue_version,
        result, created_at, updated_at
      from session_command_receipts
      where workspace_id = ${coordinates.workspaceId}::uuid
        and target_session_id = ${coordinates.sessionId}::uuid
        and action in ('session.pause', 'session.resume', 'composer.submit')
      order by created_at desc
      limit 5
    `;
    const continuable = await sql`
      select *
      from opengeni_private.list_continuable_sessions(
        ${coordinates.workspaceId}::uuid,
        ${coordinates.sessionId}::uuid
      )
    `;
    return JSON.stringify(
      { sessions, wakes, continuable, receipts, turns, attempts, interruptions },
      null,
      2,
    );
  } catch (error) {
    return `diagnostic query failed: ${String(error)}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function sessionCoordinates(url: string): BrowserSessionCoordinates {
  const match = url.match(/\/workspaces\/([^/]+)\/sessions\/([^/]+)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`session URL did not contain workspace and session ids: ${url}`);
  }
  return { workspaceId: match[1], sessionId: match[2] };
}

async function submitSessionPrompt(
  page: import("playwright").Page,
  composer: import("playwright").Locator,
  text: string,
  options: { waitForResponse?: boolean } = {},
): Promise<void> {
  await composer.fill(text);
  const submit = page.getByRole("button", {
    name: /Send message|Add message to queue/,
  });
  await waitFor(async () => !(await submit.isDisabled()), {
    timeoutMs: 10_000,
    describe: () => `composer did not become submittable for ${JSON.stringify(text)}`,
  });
  const submitted =
    options.waitForResponse === false
      ? null
      : page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes("/composer-draft/submit"),
          { timeout: 20_000 },
        );
  await submit.click();
  const response = await submitted;
  if (response && !response.ok()) {
    throw new Error(`composer submit failed: ${response.status()} ${await response.text()}`);
  }
}

async function browserQueueSnapshot(
  page: import("playwright").Page,
  browserApiPort: number,
  coordinates: BrowserSessionCoordinates,
): Promise<{ items: Array<{ id: string; prompt: string }> }> {
  return await page.evaluate(
    async ({ port, workspaceId, sessionId }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`queue read failed with ${response.status}`);
      return (await response.json()) as { items: Array<{ id: string; prompt: string }> };
    },
    {
      port: browserApiPort,
      workspaceId: coordinates.workspaceId,
      sessionId: coordinates.sessionId,
    },
  );
}

async function browserComposerDraft(
  page: import("playwright").Page,
  browserApiPort: number,
  coordinates: BrowserSessionCoordinates,
): Promise<{ text: string }> {
  return await page.evaluate(
    async ({ port, workspaceId, sessionId }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/workspaces/${workspaceId}/sessions/${sessionId}/composer-draft`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`composer draft read failed with ${response.status}`);
      return (await response.json()) as { text: string };
    },
    {
      port: browserApiPort,
      workspaceId: coordinates.workspaceId,
      sessionId: coordinates.sessionId,
    },
  );
}

async function waitForQueuePrompts(
  page: import("playwright").Page,
  browserApiPort: number,
  coordinates: BrowserSessionCoordinates,
  expectedPrompts: string[],
): Promise<void> {
  let latest: string[] = [];
  await waitFor(
    async () => {
      latest = (await browserQueueSnapshot(page, browserApiPort, coordinates)).items.map(
        (item) => item.prompt,
      );
      return JSON.stringify(latest) === JSON.stringify(expectedPrompts);
    },
    {
      timeoutMs: 15_000,
      describe: () =>
        `queue did not reconcile to ${JSON.stringify(expectedPrompts)}; latest=${JSON.stringify(latest)}`,
    },
  );
}

async function waitForSessionStatus(
  page: import("playwright").Page,
  browserApiPort: number,
  coordinates: BrowserSessionCoordinates,
  expectedStatus: string,
): Promise<void> {
  await waitFor(
    async () =>
      await page.evaluate(
        async ({ port, workspaceId, sessionId, status }) => {
          const response = await fetch(
            `http://127.0.0.1:${port}/v1/workspaces/${workspaceId}/sessions/${sessionId}`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!response.ok) return false;
          return ((await response.json()) as { status?: string }).status === status;
        },
        {
          port: browserApiPort,
          workspaceId: coordinates.workspaceId,
          sessionId: coordinates.sessionId,
          status: expectedStatus,
        },
      ),
    {
      timeoutMs: 30_000,
      describe: () => `session did not settle to ${expectedStatus}`,
    },
  );
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
      const applyThemeOnce = () => {
        document.removeEventListener("DOMContentLoaded", applyThemeOnce);
        applyTheme();
      };
      document.addEventListener("DOMContentLoaded", applyThemeOnce, { once: true });
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
  if (!box) {
    throw new Error("coarse target has no rendered bounding box");
  }
  expect(box.width).toBeGreaterThanOrEqual(40);
  expect(box.height).toBeGreaterThanOrEqual(40);
}

async function captureEvidence(page: import("playwright").Page, filename: string): Promise<void> {
  const directory = process.env.OPENGENI_E2E_EVIDENCE_DIR;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${filename}`, fullPage: true });
}
