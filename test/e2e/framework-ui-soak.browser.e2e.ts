import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import type { FrameworkUiSoakChunkReport } from "../../scripts/framework-ui-soak-browser";

const repoRoot = new URL("../..", import.meta.url).pathname;
const durationMilliseconds = Number(process.env.OPENGENI_FRAMEWORK_UI_SOAK_MS ?? 1_800_000);
const evidenceRoot =
  process.env.OPENGENI_FRAMEWORK_UI_SOAK_EVIDENCE_DIR ??
  join(repoRoot, ".agent/evidence/framework-ui/development/soak");

describe("framework UI deterministic browser soak", () => {
  let browser: Browser;
  let soakServer: ReturnType<typeof Bun.serve>;
  let reactDemo: StartedProcess;
  let svelteDemo: StartedProcess;
  let soakPage: Page;
  let reactPage: Page;
  let sveltePage: Page;

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    const build = await Bun.build({
      entrypoints: [`${repoRoot}/scripts/framework-ui-soak-browser.ts`],
      target: "browser",
      format: "esm",
      minify: true,
      write: false,
    });
    if (!build.success || !build.outputs[0]) {
      throw new Error(`Framework UI soak bundle failed: ${build.logs.join("\n")}`);
    }
    const moduleSource = await build.outputs[0].text();
    soakServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/soak.js"
          ? new Response(moduleSource, { headers: { "content-type": "text/javascript" } })
          : new Response(
              '<!doctype html><html><body><script type="module" src="/soak.js"></script></body></html>',
              { headers: { "content-type": "text/html; charset=utf-8" } },
            );
      },
    });
    const [reactPort, sveltePort] = await Promise.all([freePort(), freePort()]);
    [reactDemo, svelteDemo] = await Promise.all([
      startDemo("react", reactPort),
      startDemo("svelte", sveltePort),
    ]);
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      process.env.OPENGENI_BROWSER_BIN ??
      (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--js-flags=--expose-gc"],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    [soakPage, reactPage, sveltePage] = await Promise.all([
      context.newPage(),
      context.newPage(),
      context.newPage(),
    ]);
    await Promise.all([
      reactPage.setViewportSize({ width: 390, height: 844 }),
      sveltePage.setViewportSize({ width: 390, height: 844 }),
    ]);
    await Promise.all([
      soakPage.goto(`http://127.0.0.1:${soakServer.port}`, { waitUntil: "networkidle" }),
      reactPage.goto(`http://127.0.0.1:${reactPort}`, { waitUntil: "networkidle" }),
      sveltePage.goto(`http://127.0.0.1:${sveltePort}`, { waitUntil: "networkidle" }),
    ]);
    await soakPage.waitForFunction(
      () => typeof window.__OPENGENI_RUN_FRAMEWORK_UI_SOAK_CHUNK__ === "function",
    );
  }, 120_000);

  afterAll(async () => {
    soakServer?.stop(true);
    await Promise.allSettled([reactDemo?.stop(), svelteDemo?.stop(), browser?.close()]);
  }, 45_000);

  test(
    "stabilizes controllers, streams, history, drafts, attachments, framework mounts, and heap",
    async () => {
      const failures: string[] = [];
      for (const page of [soakPage, reactPage, sveltePage]) captureFailures(page, failures);
      const cdp = await soakPage.context().newCDPSession(soakPage);
      await cdp.send("HeapProfiler.enable");
      const startedAt = Date.now();
      const deadline = startedAt + durationMilliseconds;
      const aggregate = emptyAggregate();
      const heapSamples: Array<{ elapsedMs: number; usedBytes: number }> = [];
      const uiLatencies: number[] = [];
      let chunk = 0;
      let uiCycles = 0;
      let nextHeapSampleAt = startedAt;
      let nextProgressAt = startedAt;

      while (Date.now() < deadline) {
        const result = await soakPage.evaluate(async () => {
          return await window.__OPENGENI_RUN_FRAMEWORK_UI_SOAK_CHUNK__!(5);
        });
        mergeReport(aggregate, result);
        chunk += 1;

        if (chunk % 4 === 0) {
          const cycleStartedAt = performance.now();
          await exerciseReact(reactPage, uiCycles);
          await exerciseSvelte(sveltePage, uiCycles);
          uiLatencies.push(performance.now() - cycleStartedAt);
          uiCycles += 1;
          if (uiCycles % 5 === 0) {
            await Promise.all([
              reactPage.reload({ waitUntil: "networkidle" }),
              sveltePage.reload({ waitUntil: "networkidle" }),
            ]);
          }
        }

        if (Date.now() >= nextHeapSampleAt) {
          await cdp.send("HeapProfiler.collectGarbage");
          const usage = await cdp.send("Runtime.getHeapUsage");
          heapSamples.push({ elapsedMs: Date.now() - startedAt, usedBytes: usage.usedSize });
          nextHeapSampleAt = Date.now() + 60_000;
        }
        if (Date.now() >= nextProgressAt) {
          console.log(
            `[framework-ui-soak] elapsed=${Date.now() - startedAt}ms iterations=${aggregate.iterations} uiCycles=${uiCycles}`,
          );
          nextProgressAt = Date.now() + 60_000;
        }
      }

      await cdp.send("HeapProfiler.collectGarbage");
      const finalUsage = await cdp.send("Runtime.getHeapUsage");
      heapSamples.push({ elapsedMs: Date.now() - startedAt, usedBytes: finalUsage.usedSize });
      const report = {
        generatedAt: new Date().toISOString(),
        requestedDurationMilliseconds: durationMilliseconds,
        actualDurationMilliseconds: Date.now() - startedAt,
        aggregate,
        uiCycles,
        uiLatencyMilliseconds: {
          max: Math.max(0, ...uiLatencies),
          average:
            uiLatencies.length === 0
              ? 0
              : uiLatencies.reduce((sum, value) => sum + value, 0) / uiLatencies.length,
        },
        heapSamples,
        failures,
      };
      await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

      expect(aggregate.resourceViolations).toEqual([]);
      expect(aggregate.finalSharedControllers).toEqual({ activeControllers: 0, owners: 0 });
      expect(failures).toEqual([]);
      expect(aggregate.eventBatches).toBeGreaterThan(0);
      expect(aggregate.draftSaves).toBeGreaterThanOrEqual(aggregate.iterations);
      expect(aggregate.sends).toBe(aggregate.iterations);
      expect(aggregate.attachmentCycles).toBe(aggregate.iterations);
      expect(uiCycles).toBeGreaterThan(0);
      expect(aggregate.maxComposerInputMilliseconds).toBeLessThan(50);
      expect(aggregate.maxTimelineMilliseconds).toBeLessThan(1_000);
      const warmHeap = heapSamples.slice(Math.min(2, Math.max(0, heapSamples.length - 1)));
      const warmMinimum = Math.min(...warmHeap.map((sample) => sample.usedBytes));
      expect(finalUsage.usedSize - warmMinimum).toBeLessThan(16 * 1024 * 1024);
    },
    durationMilliseconds + 300_000,
  );
});

type Aggregate = FrameworkUiSoakChunkReport;

function emptyAggregate(): Aggregate {
  return {
    iterations: 0,
    eventBatches: 0,
    eventsProcessed: 0,
    historyTransitions: 0,
    draftSaves: 0,
    sends: 0,
    visibilityTransitions: 0,
    attachmentCycles: 0,
    sharedOwnershipCycles: 0,
    maxTimelineMilliseconds: 0,
    maxComposerInputMilliseconds: 0,
    resourceViolations: [],
    finalSharedControllers: { activeControllers: 0, owners: 0 },
  };
}

function mergeReport(aggregate: Aggregate, next: FrameworkUiSoakChunkReport): void {
  for (const key of [
    "iterations",
    "eventBatches",
    "eventsProcessed",
    "historyTransitions",
    "draftSaves",
    "sends",
    "visibilityTransitions",
    "attachmentCycles",
    "sharedOwnershipCycles",
  ] as const) {
    aggregate[key] += next[key];
  }
  aggregate.maxTimelineMilliseconds = Math.max(
    aggregate.maxTimelineMilliseconds,
    next.maxTimelineMilliseconds,
  );
  aggregate.maxComposerInputMilliseconds = Math.max(
    aggregate.maxComposerInputMilliseconds,
    next.maxComposerInputMilliseconds,
  );
  aggregate.resourceViolations.push(...next.resourceViolations);
  aggregate.finalSharedControllers = next.finalSharedControllers;
}

async function startDemo(framework: "react" | "svelte", port: number): Promise<StartedProcess> {
  return await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      "demo",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--force",
    ],
    {
      cwd: `${repoRoot}/packages/${framework}`,
      ready: async () =>
        (
          await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2_000) }).catch(
            () => null,
          )
        )?.ok === true,
      timeoutMs: 60_000,
    },
  );
}

async function exerciseReact(page: Page, cycle: number): Promise<void> {
  const textbox = page.getByRole("textbox", { name: "Message the agent" });
  await textbox.fill(`React soak ${cycle}`);
  await textbox.press("Enter");
  await page.getByText(`React soak ${cycle}`, { exact: true }).waitFor();
  const workspace = page.getByRole("button", { name: "Workspace", exact: true });
  await workspace.click();
  await page.keyboard.press("Escape");
}

async function exerciseSvelte(page: Page, cycle: number): Promise<void> {
  const textbox = page.getByRole("textbox", { name: "Message" });
  await textbox.fill(`Svelte soak ${cycle}`);
  await textbox.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === "",
  );
  const sessions = page.getByRole("button", { name: "Sessions" });
  await sessions.click();
  await page.keyboard.press("Escape");
}

function captureFailures(page: Page, failures: string[]): void {
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) =>
    failures.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`),
  );
}

declare global {
  interface Window {
    __OPENGENI_RUN_FRAMEWORK_UI_SOAK_CHUNK__?: (
      iterations: number,
    ) => Promise<FrameworkUiSoakChunkReport>;
  }
}
