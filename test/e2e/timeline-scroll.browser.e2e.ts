import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;
const artifactDir = process.env.OPE99_ARTIFACT_DIR;

type VisibleRow = { id: string | null; top: number | null };

describe("timeline scroll ownership browser regression", () => {
  let web: StartedProcess;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  let networkRequests = 0;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      ["bun", "run", "vite", ".", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: demoRoot,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      "/opt/google/chrome/chrome",
      "/usr/local/bin/chromium",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("request", () => {
      networkRequests += 1;
    });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  test("keeps the reader's row and pixel anchor through prepend, wheel, resize, and append", async () => {
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    }
    await page.evaluate(() => {
      const trace = { active: true, frames: [] as number[], longTasks: [] as number[] };
      window.timelinePerformanceTrace = trace;
      const sampleFrame = (timestamp: number) => {
        trace.frames.push(timestamp);
        if (trace.active) requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
      if (typeof PerformanceObserver !== "undefined") {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) trace.longTasks.push(entry.duration);
        });
        try {
          observer.observe({ type: "longtask", buffered: true });
        } catch {
          // Chrome without the optional long-task entry still reports frame timings.
        }
      }
      document.querySelector<HTMLElement>('[data-timeline-row="row-1040"]')!.scrollIntoView({
        block: "start",
      });
    });
    networkRequests = 0;
    const startedAt = performance.now();
    await page.waitForTimeout(100);
    const beforePrepend = await visible(page);

    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    await page.waitForTimeout(100);
    const duringPrepend = await visible(page);
    expect(duringPrepend.id).toBe(beforePrepend.id);
    expect(duringPrepend.top).toBeCloseTo(beforePrepend.top ?? 0, 0);

    const scroller = page.locator("[data-timeline-test] .og-root > div");
    await scroller.hover();
    await page.mouse.wheel(0, -96);
    await page.waitForTimeout(100);
    const afterWheel = await visible(page);

    await page.locator('[data-timeline-row="row-900"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(100);
    const afterPrepend = await visible(page);
    expect(afterPrepend.id).toBe(afterWheel.id);
    expect(afterPrepend.top).toBeCloseTo(afterWheel.top ?? 0, 0);

    await page.evaluate(() => window.timelineScrollHarness!.growRowsAbove());
    await page.waitForTimeout(100);
    const afterDelayedGrowth = await visible(page);
    expect(afterDelayedGrowth.id).toBe(afterWheel.id);
    expect(afterDelayedGrowth.top).toBeCloseTo(afterWheel.top ?? 0, 0);

    await page.evaluate(() => window.timelineScrollHarness!.append());
    await page.waitForTimeout(100);
    const afterAppend = await visible(page);
    expect(afterAppend.id).toBe(afterWheel.id);
    expect(afterAppend.top).toBeCloseTo(afterWheel.top ?? 0, 0);

    expect(Number(afterAppend.id?.replace("row-", ""))).toBeGreaterThanOrEqual(1_038);
    expect(await page.getByRole("button", { name: "Jump to latest" }).count()).toBe(1);

    if (artifactDir) {
      const browserMetrics = await collectBrowserMetrics(page);
      const evidence = {
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
        networkRequests,
        beforePrepend,
        duringPrepend,
        afterWheel,
        afterPrepend,
        afterDelayedGrowth,
        afterAppend,
        ...browserMetrics,
      };
      await writeFile(
        `${artifactDir}/timeline-scroll-metrics.json`,
        JSON.stringify(evidence, null, 2),
      );
      await page.evaluate((result) => {
        const overlay = document.createElement("pre");
        overlay.dataset.timelineEvidence = "";
        overlay.style.cssText =
          "position:fixed;left:16px;top:16px;z-index:9999;max-width:620px;padding:14px;background:#fff;color:#111;border:3px solid #17803d;font:13px/1.35 monospace;white-space:pre-wrap";
        overlay.textContent = `OPE-99 repaired progressive prepend\nAnchor preserved: ${result.afterWheel.id} @ ${result.afterWheel.top}px through prepend, delayed growth, and append.\nFrames: ${result.frameCount}; p95 ${result.frameIntervalP95Ms}ms; max ${result.maxFrameIntervalMs}ms; long tasks ${result.longTaskCount}; network ${result.networkRequests}.`;
        document.body.append(overlay);
      }, evidence);
      await captureEvidenceMatrix(page, artifactDir);
      await page
        .context()
        .tracing.stop({ path: `${artifactDir}/timeline-scroll-playwright-trace.zip` });
    }
  }, 30_000);
});

async function visible(page: Page): Promise<VisibleRow> {
  return await page.evaluate(() => window.timelineScrollHarness!.visible());
}

async function collectBrowserMetrics(page: Page) {
  const frameMetrics = await page.evaluate(() => {
    const trace = window.timelinePerformanceTrace!;
    trace.active = false;
    const intervals = trace.frames
      .slice(1)
      .map((timestamp, index) => timestamp - trace.frames[index]!)
      .sort((left, right) => left - right);
    const percentile =
      intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))];
    return {
      frameCount: trace.frames.length,
      frameIntervalP95Ms: Math.round((percentile ?? 0) * 100) / 100,
      maxFrameIntervalMs: Math.round((intervals.at(-1) ?? 0) * 100) / 100,
      estimatedDroppedFrames: intervals.reduce(
        (total, interval) => total + Math.max(0, Math.round(interval / 16.67) - 1),
        0,
      ),
      longTaskCount: trace.longTasks.length,
      longTaskTotalMs:
        Math.round(trace.longTasks.reduce((total, duration) => total + duration, 0) * 100) / 100,
      renderedRows: document.querySelectorAll("[data-timeline-row]").length,
    };
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const cdpMetrics = await session.send("Performance.getMetrics");
  const values = new Map(cdpMetrics.metrics.map((metric) => [metric.name, metric.value]));
  await session.detach();
  return {
    ...frameMetrics,
    jsHeapUsedBytes: values.get("JSHeapUsedSize") ?? null,
    domNodeCount: values.get("Nodes") ?? null,
    layoutCount: values.get("LayoutCount") ?? null,
  };
}

async function captureEvidenceMatrix(page: Page, outputDir: string): Promise<void> {
  const states = [
    { name: "desktop-light", width: 1280, height: 900, dark: false },
    { name: "desktop-dark", width: 1280, height: 900, dark: true },
    { name: "mobile-light", width: 390, height: 844, dark: false },
    { name: "mobile-dark", width: 390, height: 844, dark: true },
  ];
  for (const state of states) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.evaluate((dark) => {
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.body.style.background = dark ? "#10141c" : "#f4f6f8";
      document.body.style.color = dark ? "#f4f7fb" : "#18212f";
    }, state.dark);
    await page.screenshot({ path: `${outputDir}/timeline-${state.name}.png`, fullPage: true });
  }
}

declare global {
  interface Window {
    timelineScrollHarness?: {
      append: () => void;
      growRowsAbove: () => void;
      prepend: () => void;
      visible: () => VisibleRow;
    };
    timelinePerformanceTrace?: {
      active: boolean;
      frames: number[];
      longTasks: number[];
    };
  }
}
