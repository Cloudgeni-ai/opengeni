#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { freePort, runCommand, startProcess } from "@opengeni/testing";

const CASES = [1, 100, 1_000, 5_000] as const;
const MODES = ["editable", "readOnly"] as const;
const SAMPLES = 3;
const repoRoot = new URL("..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react`;
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
  cwd: demoRoot,
  timeoutMs: 90_000,
});
if (build.exitCode !== 0) {
  throw new Error(`Queue demo build failed:\n${build.stdout}\n${build.stderr}`);
}
const server = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "preview",
    "demo",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: demoRoot,
    ready: async () => (await fetch(`${baseUrl}/queue.html`).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  },
);
const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const sandboxChromium = "/usr/local/bin/chromium";
const executablePath =
  configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);

try {
  const receipts = [];
  for (const mode of MODES) {
    for (const count of CASES) {
      const samples = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(
          `${baseUrl}/queue.html?count=${count}&theme=dark${mode === "readOnly" ? "&readOnly=1" : ""}`,
          {
            waitUntil: "networkidle",
          },
        );
        await page.evaluate(() => {
          const entries: number[] = [];
          (window as unknown as { __queueLongTasks: number[] }).__queueLongTasks = entries;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) entries.push(entry.duration);
          }).observe({ type: "longtask", buffered: true });
        });
        const collapsed = await page.evaluate(() => {
          const navigation = performance.getEntriesByType("navigation")[0] as
            | PerformanceNavigationTiming
            | undefined;
          return {
            navigationMs: navigation ? navigation.loadEventEnd - navigation.startTime : null,
            rowCount: document.querySelectorAll("[data-queue-turn-id]").length,
          };
        });
        const expandStartedAt = performance.now();
        await page
          .getByRole("button", {
            name: `${count} queued prompt${count === 1 ? "" : "s"}${mode === "readOnly" ? " Read-only" : ""}`,
            exact: true,
          })
          .click();
        await page.waitForFunction(
          (expected) => document.querySelectorAll("[data-queue-turn-id]").length === expected,
          count,
          { timeout: 30_000 },
        );
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const expandMs = performance.now() - expandStartedAt;
        const expanded = await page.evaluate((expectedCount) => {
          const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-queue-turn-id]"));
          const ids = rows.map((row) => row.dataset.queueTurnId ?? "");
          const list = document.querySelector<HTMLElement>('[data-testid="queue-list"]');
          const longTasks =
            (window as unknown as { __queueLongTasks?: number[] }).__queueLongTasks ?? [];
          return {
            rowCount: rows.length,
            uniqueIds: new Set(ids).size,
            firstPosition: rows[0]?.querySelector("span")?.textContent?.trim() ?? null,
            lastPosition: rows.at(-1)?.querySelector("span")?.textContent?.trim() ?? null,
            listScrollHeight: list?.scrollHeight ?? 0,
            documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            longTaskCount: longTasks.length,
            longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
            longTaskMaxMs: Math.max(0, ...longTasks),
            contentParity: rows.length === expectedCount && new Set(ids).size === expectedCount,
          };
        }, count);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        const metrics = await cdp.send("Performance.getMetrics");
        const metric = (name: string) =>
          metrics.metrics.find((entry) => entry.name === name)?.value;
        if (!expanded.contentParity) {
          throw new Error(`Queue DOM retained ${expanded.rowCount}/${count} unique prompts`);
        }
        if (errors.length > 0) throw new Error(`Queue browser errors: ${errors.join("; ")}`);
        samples.push({
          collapsed,
          expandMs,
          expanded,
          jsHeapUsedBytes: metric("JSHeapUsedSize") ?? null,
          nodeCount: metric("Nodes") ?? null,
          layoutCount: metric("LayoutCount") ?? null,
        });
        await context.close();
      }
      receipts.push({
        mode,
        count,
        samples: SAMPLES,
        navigationMs: distribution(
          samples.flatMap((sample) =>
            sample.collapsed.navigationMs === null ? [] : [sample.collapsed.navigationMs],
          ),
        ),
        expandMs: distribution(samples.map((sample) => sample.expandMs)),
        longTaskTotalMs: distribution(samples.map((sample) => sample.expanded.longTaskTotalMs)),
        jsHeapUsedBytes: distribution(
          samples.flatMap((sample) =>
            sample.jsHeapUsedBytes === null ? [] : [sample.jsHeapUsedBytes],
          ),
        ),
        nodeCount: distribution(
          samples.flatMap((sample) => (sample.nodeCount === null ? [] : [sample.nodeCount])),
        ),
        listScrollHeight: samples[0]!.expanded.listScrollHeight,
        contentParity: samples.every((sample) => sample.expanded.contentParity) ? "pass" : "fail",
        documentOverflow: Math.max(...samples.map((sample) => sample.expanded.documentOverflow)),
      });
    }
  }
  console.log(JSON.stringify({ receipts }, null, 2));
} finally {
  await Promise.allSettled([browser.close(), server.stop()]);
}
process.exit(0);

function distribution(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}
