import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;
const artifactDir = process.env.TIMELINE_SCROLL_ARTIFACT_DIR;

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

    await page.evaluate(() => window.timelineScrollHarness!.stream());
    await page.waitForTimeout(100);
    const afterStream = await visible(page);
    expect(afterStream.id).toBe(afterWheel.id);
    expect(afterStream.top).toBeCloseTo(afterWheel.top ?? 0, 0);

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
        afterStream,
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
        overlay.textContent = `Timeline scroll progressive prepend verified\nAnchor preserved: ${result.afterWheel.id} @ ${result.afterWheel.top}px through prepend, delayed growth, and append.\nFrames: ${result.frameCount}; p95 ${result.frameIntervalP95Ms}ms; max ${result.maxFrameIntervalMs}ms; long tasks ${result.longTaskCount}; network ${result.networkRequests}.`;
        document.body.append(overlay);
      }, evidence);
      await captureEvidenceMatrix(page, artifactDir);
      await page
        .context()
        .tracing.stop({ path: `${artifactDir}/timeline-scroll-playwright-trace.zip` });
    }
  }, 30_000);

  test("preserves the anchor when the first progressive row meets the reader", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html?adjacent`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1040"]').waitFor({ timeout: 15_000 });
    const target = page.locator('[data-timeline-row="row-1040"]');
    await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);

    const before = await visible(page);
    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    const samples = await visibleIntervals(page, 16, 20);
    expect(samples.length).toBe(16);
    expect(samples.every((sample) => sample.id === before.id)).toBe(true);
    expect(samples.every((sample) => Math.abs((sample.top ?? 0) - (before.top ?? 0)) < 1)).toBe(
      true,
    );
  }, 30_000);

  test("preserves the anchor during every progressive prepend frame", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
    const target = page.locator('[data-timeline-row="row-1040"]');
    await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);

    const before = await visible(page);
    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    const samples = await visibleIntervals(page, 16, 20);
    expect(samples.length).toBe(16);
    expect(samples.every((sample) => sample.id === before.id)).toBe(true);
    expect(samples.every((sample) => Math.abs((sample.top ?? 0) - (before.top ?? 0)) < 1)).toBe(
      true,
    );
  }, 30_000);

  test("preserves every progressive prepend frame on narrow mobile", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
    const target = page.locator('[data-timeline-row="row-1040"]');
    await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);

    const before = await visible(page);
    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    const samples = await visibleFrames(page, 24);
    expect(samples.length).toBe(24);
    expect(samples.every((sample) => sample.id === before.id)).toBe(true);
    expect(samples.every((sample) => Math.abs((sample.top ?? 0) - (before.top ?? 0)) < 1)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
  }, 30_000);

  test("keeps wheel ownership through the remaining prepend frames", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
    const target = page.locator('[data-timeline-row="row-1040"]');
    await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);

    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    await nextFrames(page, 2);
    const scroller = page.locator("[data-timeline-test] .og-root > div");
    await scroller.hover();
    await page.mouse.wheel(0, -96);
    await page.waitForTimeout(20);
    const afterWheel = await visible(page);
    const samples = await visibleFrames(page, 24);
    expect(samples.length).toBe(24);
    expect(samples.every((sample) => sample.id === afterWheel.id)).toBe(true);
    expect(samples.every((sample) => Math.abs((sample.top ?? 0) - (afterWheel.top ?? 0)) < 1)).toBe(
      true,
    );
  }, 30_000);

  test("follows a reader that is within the near-bottom threshold", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });

    const scroller = page.locator("[data-timeline-test] .og-root > div");
    await scroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight - node.clientHeight - 24;
    });
    await page.waitForTimeout(100);
    const before = await scroller.evaluate((node) => ({
      gap: node.scrollHeight - node.scrollTop - node.clientHeight,
      scrollTop: node.scrollTop,
    }));
    expect(before.gap).toBeLessThan(48);

    await page.evaluate(() => window.timelineScrollHarness!.append());
    // The follow snaps to the bottom on the commit (and on the next frame
    // for resize-observed growth) — wait for it to land instead of sampling
    // between the append and the snap.
    await page.waitForFunction(
      () => {
        const node = document.querySelector("[data-timeline-test] .og-root > div");
        return (
          node instanceof HTMLElement && node.scrollHeight - node.scrollTop - node.clientHeight < 2
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    const after = await scroller.evaluate((node) => ({
      gap: node.scrollHeight - node.scrollTop - node.clientHeight,
      scrollTop: node.scrollTop,
    }));
    expect(after.gap).toBeLessThan(2);
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  }, 30_000);

  test("keeps a narrow mobile reader anchored through prepend", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
    const target = page.locator('[data-timeline-row="row-1040"]');
    await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);

    const before = await visible(page);
    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    await page.waitForTimeout(100);
    const after = await visible(page);
    expect(after.id).toBe(before.id);
    expect(after.top).toBeCloseTo(before.top ?? 0, 0);
    await page.setViewportSize({ width: 1280, height: 900 });
  }, 30_000);

  test("keeps a nested row anchored when prepend merges into its activity group", async () => {
    await page.goto(`${baseUrl}/timeline-scroll-merge-test.html`);
    await page.waitForFunction(() => window.timelineMergeHarness !== undefined);
    const target = page.getByText("reasoning-50", { exact: true });
    await target.waitFor({ timeout: 15_000 });
    await target.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(100);

    const before = await nestedVisible(page, "reasoning-50");
    await page.evaluate(() => window.timelineMergeHarness!.prependActivity());
    await page.waitForTimeout(100);
    const after = await nestedVisible(page, "reasoning-50");

    expect(after.text).toBe(before.text);
    expect(after.top).toBeCloseTo(before.top, 0);
  }, 30_000);

  test("loads earlier messages when collapsed steps leave no upward scroll range", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);

    // The tail contains only compact, collapsed step rows. Earlier history
    // must load without requiring the reader to expand one just to manufacture
    // a scroll range.
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    const beforeScroll = await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.metrics(),
    );
    expect(beforeScroll.maxScroll).toBeGreaterThan(0);

    await scroller.hover();
    for (let index = 0; index < 12; index += 1) {
      await page.mouse.wheel(0, -1_200);
      if (
        (await page.evaluate(() => window.timelineCollapsedHistoryHarness!.metrics().scrollTop)) <
        100
      ) {
        break;
      }
    }
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop < 100,
      undefined,
      { timeout: 5_000 },
    );
    expect(await page.locator('[data-conversation-message="user-1"]').isVisible()).toBe(true);
    expect(await page.locator('[data-conversation-message="assistant-27"]').isVisible()).toBe(true);

    // Expanding and collapsing a step changes row height, but it must neither
    // remove surrounding chat rows nor destroy the usable scroll range.
    const step = page.getByRole("button", { name: /steps/ }).nth(4);
    const anchor = page.locator('[data-conversation-message="user-201"]');
    await anchor.evaluate((node) => node.scrollIntoView({ block: "center" }));
    const anchorTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    await step.click();
    await page.waitForTimeout(180);
    await step.click();
    await page.waitForTimeout(180);
    expect(await anchor.count()).toBe(1);
    expect(await page.locator('[data-conversation-message^="user-"]').count()).toBe(9);
    expect(await page.locator('[data-conversation-message^="assistant-"]').count()).toBe(9);
    expect(
      (await page.evaluate(() => window.timelineCollapsedHistoryHarness!.metrics())).maxScroll,
    ).toBeGreaterThan(0);
    expect(await anchor.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(
      anchorTop,
      0,
    );
  }, 30_000);

  test("keeps the live tail fixed when a delayed underfill page resolves", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);
    await page.waitForFunction(() => {
      const node = window.timelineCollapsedHistoryHarness!.scroller();
      return node.style.visibility !== "hidden";
    });

    const evidence = await page.evaluate(async () => {
      const harness = window.timelineCollapsedHistoryHarness!;
      const before = harness.metrics();
      harness.settleOlder("success");
      const samples = [];
      for (let index = 0; index < 24; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(harness.metrics());
      }
      return { before, samples };
    });
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });

    expect(evidence.samples).toHaveLength(24);
    const parkedGap = evidence.samples[0]!.liveTailGap;
    expect(evidence.samples.every((sample) => Math.abs(sample.liveTailGap - parkedGap) < 1)).toBe(
      true,
    );
    expect(parkedGap).toBeLessThan(48);
    expect(evidence.samples.every((sample) => sample.maxScroll - sample.scrollTop < 2)).toBe(true);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
  }, 30_000);

  test("retries one transient underfill failure without resize loops or duplicate requests", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("failure"));
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });

    // Repeated layout observations against the unchanged short window do not
    // turn one rejection into a polling loop.
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry-older]") === null);
    expect(await retry.count()).toBe(0);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("backfills history when collapsing dynamic step content removes the scroll range", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?dynamic-collapse`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);

    const step = page.getByRole("button", { name: /steps/ }).first();
    await step.click();
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 0,
      undefined,
      { timeout: 5_000 },
    );

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.armOlder());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(0);

    await step.click();
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
    expect(await page.locator('[data-conversation-message^="user-"]').count()).toBe(9);
    expect(await page.locator('[data-conversation-message^="assistant-"]').count()).toBe(9);
    expect(
      (await page.evaluate(() => window.timelineCollapsedHistoryHarness!.metrics())).maxScroll,
    ).toBeGreaterThan(0);
  }, 30_000);
});

async function visible(page: Page): Promise<VisibleRow> {
  return await page.evaluate(() => window.timelineScrollHarness!.visible());
}

async function visibleFrames(page: Page, count: number): Promise<VisibleRow[]> {
  return await page.evaluate(async (frameCount) => {
    const samples: VisibleRow[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(window.timelineScrollHarness!.visible());
    }
    return samples;
  }, count);
}

async function visibleIntervals(
  page: Page,
  count: number,
  intervalMs: number,
): Promise<VisibleRow[]> {
  return await page.evaluate(
    async ({ count: sampleCount, interval }) => {
      const samples: VisibleRow[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, interval));
        samples.push(window.timelineScrollHarness!.visible());
      }
      return samples;
    },
    { count, interval: intervalMs },
  );
}

async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function nestedVisible(
  page: Page,
  text: string,
): Promise<{ text: string; top: number; scrollTop: number; overflowAnchor: string }> {
  return await page.evaluate((targetText) => {
    const scroller = document.querySelector<HTMLElement>(
      "[data-timeline-merge-test] .og-root > div",
    );
    const target = [...document.querySelectorAll<HTMLElement>("span, p")].find(
      (candidate) => candidate.textContent === targetText,
    );
    if (!scroller || !target) throw new Error(`missing nested timeline row ${targetText}`);
    return {
      text: target.textContent ?? "",
      top: target.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      scrollTop: scroller.scrollTop,
      overflowAnchor: getComputedStyle(scroller).overflowAnchor,
    };
  }, text);
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
      stream: () => void;
      visible: () => VisibleRow;
    };
    timelineMergeHarness?: {
      prependActivity: () => void;
    };
    timelinePerformanceTrace?: {
      active: boolean;
      frames: number[];
      longTasks: number[];
    };
  }
}
