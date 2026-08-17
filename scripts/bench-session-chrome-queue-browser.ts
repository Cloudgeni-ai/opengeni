#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { freePort, runCommand, startProcess } from "@opengeni/testing";

const CASES = [1, 100, 1_000, 5_000] as const;
const SAMPLES = 3;
const readOnly = process.env.SESSION_CHROME_QUEUE_READ_ONLY === "1";
const requestedCpuThrottleRate = Number(process.env.SESSION_CHROME_CPU_THROTTLE_RATE ?? "1");
const cpuThrottleRate =
  Number.isFinite(requestedCpuThrottleRate) && requestedCpuThrottleRate >= 1
    ? requestedCpuThrottleRate
    : 1;
const repoRoot = new URL("..", import.meta.url).pathname;
const webRoot = `${repoRoot}/apps/web`;
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const extensionBuild = await runCommand(["bun", "run", "build"], {
  cwd: `${repoRoot}/apps/browser-extension`,
  timeoutMs: 90_000,
});
if (extensionBuild.exitCode !== 0) {
  throw new Error(
    `Browser extension prerequisite failed:\n${extensionBuild.stdout}\n${extensionBuild.stderr}`,
  );
}
const build = await runCommand(["bun", "run", "vite", "build", "--mode", "performance"], {
  cwd: webRoot,
  timeoutMs: 180_000,
});
if (build.exitCode !== 0) {
  throw new Error(`Production web build failed:\n${build.stdout}\n${build.stderr}`);
}
const server = await startProcess(["bun", "src/server.ts"], {
  cwd: webRoot,
  env: { PORT: String(port), HOST: "127.0.0.1" },
  ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
  timeoutMs: 45_000,
});
const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const sandboxChromium = "/usr/local/bin/chromium";
const executablePath =
  configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);

try {
  const receipts = [];
  for (const count of CASES) {
    const samples = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      await context.addInitScript(() => {
        const durations: number[] = [];
        (window as unknown as { __sessionChromeLongTasks: number[] }).__sessionChromeLongTasks =
          durations;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      const page = await context.newPage();
      const emulation = await context.newCDPSession(page);
      await emulation.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      const wallStartedAt = performance.now();
      await page.goto(
        `${baseUrl}/dev/composer-chrome?scenario=queued-only&queueCount=${count}&queueOpen=0&queueReadOnly=${readOnly ? "1" : "0"}`,
        {
          waitUntil: "networkidle",
          timeout: 60_000,
        },
      );
      const queueButton = page.locator('[data-og-session-chrome-signal="queue"]');
      await queueButton.waitFor({ state: "visible", timeout: 60_000 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const collapsedReadyMs = performance.now() - wallStartedAt;
      const collapsed = await browserMetrics(context, page);
      await page.evaluate(() => {
        (
          window as unknown as { __sessionChromeLongTasks: number[] }
        ).__sessionChromeLongTasks.length = 0;
      });
      const expandStartedAt = performance.now();
      await queueButton.click();
      await page.waitForFunction(
        (expected) => document.querySelectorAll("[data-queue-turn-id]").length === expected,
        count,
        { timeout: 60_000 },
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const expandMs = performance.now() - expandStartedAt;

      const measured = await page.evaluate((expectedCount) => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-queue-turn-id]"));
        const ids = rows.map((row) => row.dataset.queueTurnId ?? "");
        const texts = rows.map((row) => row.querySelector("p")?.textContent ?? "");
        const expectedText = (index: number) =>
          `Queued performance prompt ${String(index + 1).padStart(5, "0")} ${"q".repeat(480)}`;
        const expectedTextChars = Array.from({ length: expectedCount }, (_, index) =>
          expectedText(index),
        ).reduce((sum, text) => sum + text.length, 0);
        const navigation = performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined;
        const longTasks =
          (window as unknown as { __sessionChromeLongTasks?: number[] }).__sessionChromeLongTasks ??
          [];
        const queuePanel = document.querySelector<HTMLElement>(
          '[data-og-session-chrome-panel="queue"]',
        );
        return {
          navigationDomContentLoadedMs: navigation
            ? navigation.domContentLoadedEventEnd - navigation.startTime
            : null,
          navigationLoadMs: navigation ? navigation.loadEventEnd - navigation.startTime : null,
          rowCount: rows.length,
          uniqueIds: new Set(ids).size,
          firstId: ids[0] ?? null,
          lastId: ids.at(-1) ?? null,
          panelScrollHeight: queuePanel?.scrollHeight ?? 0,
          documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          longTaskCount: longTasks.length,
          longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
          longTaskMaxMs: Math.max(0, ...longTasks),
          retainedTextChars: texts.reduce((sum, text) => sum + text.length, 0),
          expectedTextChars,
          contentParity:
            rows.length === expectedCount &&
            new Set(ids).size === expectedCount &&
            texts.every((text, index) => text === expectedText(index)),
        };
      }, count);
      const expanded = await browserMetrics(context, page);
      let actionClarityParity: "not-applicable" | "pass" = "not-applicable";
      if (!readOnly && sample === 0) {
        const steerAction = page.getByRole("button", {
          name: "Steer queued prompt 1",
          exact: true,
        });
        const moreAction = page.getByRole("button", {
          name: "More actions for queued prompt 1",
          exact: true,
        });
        const restingActionCount = await page.locator("button[data-queue-command]").count();
        if (
          (await steerAction.textContent()) !== "Steer" ||
          (await moreAction.textContent()) !== "More" ||
          restingActionCount !== count * 2 ||
          (await steerAction.getAttribute("title")) !== null
        ) {
          throw new Error("SessionChrome queue actions are not clear before a touch interaction");
        }
        await moreAction.click();
        const actionStripId = await moreAction.getAttribute("aria-controls");
        const actionStrip = page.locator(`#${actionStripId}`);
        const actionLabels = await actionStrip.locator("button").allTextContents();
        const actionStripBox = await actionStrip.boundingBox();
        const expectedLabels =
          count === 1 ? ["Edit", "Delete"] : ["Move up", "Move down", "Edit", "Delete"];
        if (
          (await moreAction.getAttribute("aria-expanded")) !== "true" ||
          actionLabels.join(",") !== expectedLabels.join(",") ||
          !actionStripBox ||
          actionStripBox.x < 0 ||
          actionStripBox.x + actionStripBox.width > 390 ||
          (await page.getByRole("tooltip").count()) !== 0
        ) {
          throw new Error("SessionChrome disclosed text actions failed touch or viewport parity");
        }
        await moreAction.click();
        actionClarityParity = "pass";
      }

      if (!measured.contentParity) {
        throw new Error(`SessionChrome retained ${measured.rowCount}/${count} unique prompts`);
      }
      if (errors.length > 0) throw new Error(`SessionChrome browser errors: ${errors.join("; ")}`);
      samples.push({
        collapsedReadyMs,
        expandMs,
        measured,
        collapsed,
        expanded,
        actionClarityParity,
      });
      await emulation.detach();
      await context.close();
    }

    receipts.push({
      count,
      samples: SAMPLES,
      collapsedReadyMs: distribution(samples.map((sample) => sample.collapsedReadyMs)),
      expandMs: distribution(samples.map((sample) => sample.expandMs)),
      navigationDomContentLoadedMs: distribution(
        samples.flatMap((sample) =>
          sample.measured.navigationDomContentLoadedMs === null
            ? []
            : [sample.measured.navigationDomContentLoadedMs],
        ),
      ),
      navigationLoadMs: distribution(
        samples.flatMap((sample) =>
          sample.measured.navigationLoadMs === null ? [] : [sample.measured.navigationLoadMs],
        ),
      ),
      longTaskTotalMs: distribution(samples.map((sample) => sample.measured.longTaskTotalMs)),
      longTaskMaxMs: distribution(samples.map((sample) => sample.measured.longTaskMaxMs)),
      jsHeapUsedBytes: distribution(
        samples.flatMap((sample) =>
          sample.expanded.jsHeapUsedBytes === null ? [] : [sample.expanded.jsHeapUsedBytes],
        ),
      ),
      collapsedJsHeapUsedBytes: distribution(
        samples.flatMap((sample) =>
          sample.collapsed.jsHeapUsedBytes === null ? [] : [sample.collapsed.jsHeapUsedBytes],
        ),
      ),
      nodeCount: distribution(
        samples.flatMap((sample) =>
          sample.expanded.nodeCount === null ? [] : [sample.expanded.nodeCount],
        ),
      ),
      collapsedNodeCount: distribution(
        samples.flatMap((sample) =>
          sample.collapsed.nodeCount === null ? [] : [sample.collapsed.nodeCount],
        ),
      ),
      panelScrollHeight: samples[0]!.measured.panelScrollHeight,
      retainedTextChars: samples[0]!.measured.retainedTextChars,
      expectedTextChars: samples[0]!.measured.expectedTextChars,
      contentParity: samples.every((sample) => sample.measured.contentParity) ? "pass" : "fail",
      actionClarityParity: readOnly
        ? "not-applicable"
        : samples.some((sample) => sample.actionClarityParity === "pass")
          ? "pass"
          : "fail",
      documentOverflow: Math.max(...samples.map((sample) => sample.measured.documentOverflow)),
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        surface: "production SessionChrome in production web bundle",
        mode: readOnly ? "read-only rows" : "interactive rows",
        cpuThrottleRate,
        viewport: { width: 390, height: 844, mobile: true, touch: true },
        receipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([browser.close(), server.stop()]);
}
process.exit(0);

async function browserMetrics(
  context: import("playwright").BrowserContext,
  page: import("playwright").Page,
) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  const metric = (name: string) =>
    metrics.metrics.find((entry) => entry.name === name)?.value ?? null;
  await cdp.detach();
  return {
    jsHeapUsedBytes: metric("JSHeapUsedSize"),
    nodeCount: metric("Nodes"),
    layoutCount: metric("LayoutCount"),
  };
}

function distribution(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
  };
}
