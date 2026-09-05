import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;
const artifactDir = process.env.TIMELINE_SCROLL_ARTIFACT_DIR;

type VisibleRow = { id: string | null; top: number | null };

async function withConfiguredCpuThrottle<T>(page: Page, task: () => Promise<T>): Promise<T> {
  const configuredRate = Number(process.env.TIMELINE_SCROLL_CPU_THROTTLE_RATE ?? "1");
  if (!Number.isFinite(configuredRate) || configuredRate < 1) {
    throw new Error("TIMELINE_SCROLL_CPU_THROTTLE_RATE must be a finite number at least 1");
  }
  if (configuredRate === 1) {
    return task();
  }
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: configuredRate });
  try {
    return await task();
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
  }
}

function observeBrowserErrors(page: Page, browserErrors: string[]): void {
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (location.endsWith("/favicon.ico")) return;
    browserErrors.push(`console: ${message.text()}`);
  });
}

describe("timeline scroll ownership browser regression", () => {
  let productionServer: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  let productionBuildDir: string | undefined;
  let networkRequests = 0;
  const browserErrors: string[] = [];

  beforeAll(async () => {
    productionBuildDir = await mkdtemp(join(tmpdir(), "opengeni-timeline-scroll-"));
    const productionEnvironment = {
      OPENGENI_REACT_DEMO_OUT_DIR: productionBuildDir,
      OPENGENI_TIMELINE_SCROLL_TEST_BUILD: "1",
    };
    const build = Bun.spawn(["bun", "run", "vite", "build", "."], {
      cwd: demoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        ...productionEnvironment,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await build.exited) !== 0) {
      throw new Error(
        `timeline production harness build failed\n${await new Response(build.stderr).text()}`,
      );
    }
    const productionPort = await freePort();
    baseUrl = `http://127.0.0.1:${productionPort}`;
    productionServer = Bun.serve({
      hostname: "127.0.0.1",
      port: productionPort,
      fetch: async (request) => {
        const pathname = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
        if (pathname.includes("..")) {
          return new Response("Not found", { status: 404 });
        }
        const relativePath = pathname || "timeline-scroll-test.html";
        const asset = Bun.file(join(productionBuildDir!, relativePath));
        return (await asset.exists())
          ? new Response(asset, { headers: { "content-type": asset.type } })
          : new Response("Not found", { status: 404 });
      },
    });
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
    observeBrowserErrors(page, browserErrors);
    page.on("request", () => {
      networkRequests += 1;
    });
    await page.goto(`${baseUrl}/timeline-scroll-test.html`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    try {
      expect(browserErrors).toEqual([]);
    } finally {
      await Promise.allSettled([browser?.close(), productionServer?.stop(true)]);
      if (productionBuildDir) {
        await rm(productionBuildDir, { recursive: true, force: true });
      }
    }
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

  test("production-scheduled 100-row prepend avoids a browser long task", async () => {
    const performancePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    observeBrowserErrors(performancePage, browserErrors);
    try {
      await performancePage.goto(`${baseUrl}/timeline-scroll-test.html`);
      await performancePage.waitForFunction(() => window.timelineScrollHarness !== undefined);
      await performancePage.locator('[data-timeline-row="row-1000"]').waitFor({ timeout: 15_000 });
      await performancePage.locator('[data-timeline-row="row-1040"]').evaluate((node) => {
        node.scrollIntoView({ block: "start" });
      });
      await performancePage.waitForTimeout(100);

      const before = await visible(performancePage);
      const performance = await withConfiguredCpuThrottle(performancePage, () =>
        performancePage.evaluate(
          () =>
            new Promise<{
              longTasks: number[];
              maxFrameIntervalMs: number;
            }>((resolve) => {
              const longTasks: number[] = [];
              const frames: number[] = [];
              const observer =
                typeof PerformanceObserver === "undefined"
                  ? null
                  : new PerformanceObserver((list) => {
                      for (const entry of list.getEntries()) longTasks.push(entry.duration);
                    });
              try {
                observer?.observe({ type: "longtask" });
              } catch {
                // Frame intervals remain the portable signal.
              }
              const sample = (timestamp: number) => {
                frames.push(timestamp);
                if (frames.length < 12) {
                  requestAnimationFrame(sample);
                  return;
                }
                observer?.takeRecords().forEach((entry) => longTasks.push(entry.duration));
                observer?.disconnect();
                const intervals = frames.slice(1).map((value, index) => value - frames[index]!);
                resolve({
                  longTasks,
                  maxFrameIntervalMs: Math.max(0, ...intervals),
                });
              };
              requestAnimationFrame(() => {
                window.timelineScrollHarness!.prependDeferred();
                requestAnimationFrame(sample);
              });
            }),
        ),
      );
      const after = await visible(performancePage);

      expect(after.id).toBe(before.id);
      expect(after.top).toBeCloseTo(before.top ?? 0, 0);
      expect(performance.longTasks).toEqual([]);
      expect(performance.maxFrameIntervalMs).toBeLessThan(50);
    } finally {
      await performancePage.close();
    }
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

  test("a compact newest-suffix prepend keeps the reader instead of snapping to the live tip", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-scroll-test.html?compact-tail`);
    await page.waitForFunction(() => window.timelineScrollHarness !== undefined);
    await page.locator('[data-timeline-row="row-13"]').waitFor({ timeout: 15_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForFunction(() => {
      const node = document.querySelector<HTMLElement>(
        "[data-timeline-test] [data-og-timeline-scroller]",
      );
      return !!node && node.style.visibility !== "hidden" && node.scrollHeight > 0;
    });

    // Size the shell so the newest suffix barely overflows. That is the
    // production first-paint shape: the reader can sit at y=0 while the
    // restored gap after prepend is still inside PIN_THRESHOLD of the tip.
    await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".timeline-test-shell-compact");
      const node = document.querySelector<HTMLElement>(
        "[data-timeline-test] [data-og-timeline-scroller]",
      );
      if (!shell || !node) {
        throw new Error("compact tail scroller missing");
      }
      const targetMaxScroll = 36;
      const chrome = shell.clientHeight - node.clientHeight;
      shell.style.height = `${Math.max(chrome + 80, node.scrollHeight - targetMaxScroll + chrome)}px`;
    });
    await page.waitForTimeout(50);

    const scroller = page.locator("[data-timeline-test] [data-og-timeline-scroller]");
    const beforeWheel = await scroller.evaluate((node) => ({
      scrollTop: node.scrollTop,
      maxScroll: node.scrollHeight - node.clientHeight,
      gap: node.scrollHeight - node.clientHeight - node.scrollTop,
    }));
    expect(beforeWheel.maxScroll).toBeGreaterThan(1);
    expect(beforeWheel.maxScroll).toBeLessThanOrEqual(48);
    expect(beforeWheel.gap).toBeLessThan(2);

    await scroller.hover();
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.wheel(0, -120);
      if ((await scroller.evaluate((node) => node.scrollTop)) < 2) {
        break;
      }
    }
    await page.waitForFunction(
      () => {
        const node = document.querySelector<HTMLElement>(
          "[data-timeline-test] [data-og-timeline-scroller]",
        );
        return !!node && node.scrollTop < 2;
      },
      undefined,
      { timeout: 5_000 },
    );
    await page.locator("[data-og-jump-to-latest]").waitFor({ timeout: 5_000 });

    const atTop = await scroller.evaluate((node) => ({
      scrollTop: node.scrollTop,
      gap: node.scrollHeight - node.clientHeight - node.scrollTop,
      height: node.scrollHeight,
    }));
    expect(atTop.scrollTop).toBeLessThan(2);
    expect(atTop.gap).toBeGreaterThan(1);
    expect(atTop.gap).toBeLessThanOrEqual(48);

    const anchor = page.locator('[data-timeline-row="row-13"]').first();
    const beforeAnchorTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);

    await page.evaluate(() => window.timelineScrollHarness!.prepend());
    await page.locator('[data-timeline-row="row-1"]').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(80);

    const after = await scroller.evaluate((node) => ({
      scrollTop: node.scrollTop,
      gap: node.scrollHeight - node.clientHeight - node.scrollTop,
      height: node.scrollHeight,
      pin: node.getAttribute("data-og-bottom-follow"),
    }));
    const afterAnchorTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    expect(after.height).toBeGreaterThan(atTop.height + 200);
    expect(after.scrollTop).toBeGreaterThan(200);
    expect(after.gap).toBeCloseTo(atTop.gap, 0);
    expect(after.pin).toBe("false");
    expect(afterAnchorTop).toBeCloseTo(beforeAnchorTop, 0);
    expect(await page.locator("[data-og-jump-to-latest]").count()).toBe(1);
  }, 30_000);

  test("keeps a nested row anchored when prepend merges into its activity group", async () => {
    await page.goto(`${baseUrl}/timeline-scroll-merge-test.html`);
    await page.waitForFunction(() => window.timelineMergeHarness !== undefined);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const target = page.getByText("reasoning-50", { exact: true });
    await target.waitFor({ timeout: 15_000 });
    await target.evaluate(async (node) => {
      const scroller = document.querySelector<HTMLElement>(
        "[data-timeline-merge-test] .og-root > div",
      );
      if (!scroller) throw new Error("timeline merge scroller is unavailable");
      const settled =
        "onscrollend" in scroller
          ? new Promise<void>((resolve) => {
              scroller.addEventListener("scrollend", () => resolve(), { once: true });
            })
          : new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
      node.scrollIntoView({ block: "start" });
      await settled;
    });

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

  test("keeps one pending underfill callback through StrictMode effect replay", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&overlap-loads&strict-mode`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() >= 1);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
  }, 30_000);

  test("releases synchronous cached prefetch progress after a void callback return", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?sync-cached-prefetch`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 800,
    );
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await scroller.evaluate((node) => {
      node.scrollTop = 800;
      node.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop > 400,
    );
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("backfills a synchronously progressed window that remains underfilled", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?sync-cached-underfill`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 800,
    );
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
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
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const evidence = await page.evaluate(async () => {
      const harness = window.timelineCollapsedHistoryHarness!;
      harness.settleOlder("success");
      await new Promise<void>((resolve) => {
        const prepended = () =>
          document.querySelector('[data-conversation-message="user-1"]') !== null;
        if (prepended()) {
          resolve();
          return;
        }
        const observer = new MutationObserver(() => {
          if (!prepended()) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(harness.scroller(), { childList: true, subtree: true });
      });
      const samples = [];
      for (let index = 0; index < 24; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(harness.metrics());
      }
      return samples;
    });
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });

    expect(evidence).toHaveLength(24);
    const parkedGap = evidence[0]!.liveTailGap;
    expect(evidence.every((sample) => Math.abs(sample.liveTailGap - parkedGap) < 1)).toBe(true);
    expect(parkedGap).toBeLessThan(48);
    expect(evidence.every((sample) => sample.maxScroll - sample.scrollTop < 2)).toBe(true);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
  }, 30_000);

  test("keeps a pinned live tail across final-page availability before prepend", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);
    await page.waitForFunction(() => {
      const node = window.timelineCollapsedHistoryHarness!.scroller();
      return node.style.visibility !== "hidden";
    });

    const immediate = await page.evaluate(async () => {
      const harness = window.timelineCollapsedHistoryHarness!;
      await harness.appendLivePageMarkNoOlderAndSettleOlder();
      return harness.metrics();
    });
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });

    expect(immediate.maxScroll - immediate.scrollTop).toBeLessThan(2);
    expect(immediate.liveTailGap).toBeLessThan(48);
    await page.waitForFunction(() => {
      const metrics = window.timelineCollapsedHistoryHarness!.metrics();
      return metrics.maxScroll - metrics.scrollTop < 2;
    });
    expect(await page.getByRole("button", { name: "Jump to latest" }).count()).toBe(0);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
  }, 30_000);

  test("keeps a returned live tail pinned when ordinary prefetch settles before prepend", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&prefetch-window&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 800,
    );

    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await scroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(() => {
      const metrics = window.timelineCollapsedHistoryHarness!.metrics();
      return metrics.maxScroll - metrics.scrollTop < 2;
    });

    const immediate = await page.evaluate(async () => {
      const harness = window.timelineCollapsedHistoryHarness!;
      await harness.appendLivePageMarkNoOlderAndSettleOlder();
      return harness.metrics();
    });
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });

    expect(immediate.maxScroll - immediate.scrollTop).toBeLessThan(2);
    expect(immediate.liveTailGap).toBeLessThan(48);
    expect(await scroller.getAttribute("data-og-bottom-follow")).toBe("true");
    // Pin intent changes synchronously, while AnimatePresence retains the
    // exiting control for its 150 ms fade. Wait for that visual lifecycle
    // instead of treating the retained exit node as stale scroll state.
    await page.getByRole("button", { name: "Jump to latest" }).waitFor({ state: "detached" });
    expect(await page.getByRole("button", { name: "Jump to latest" }).count()).toBe(0);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
  }, 30_000);

  test("keeps top prefetch behind a pending underfill owner after live growth", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load&overlap-loads`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.appendLivePage());
    await page.locator('[data-conversation-message="user-1200"]').waitFor({ timeout: 5_000 });
    // Let the live messages' entrance motion settle so the
    // subsequent pixel delta measures only the older prepend.
    await page.waitForTimeout(500);
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop < 100,
    );
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    const anchorEvidence = await page.evaluate(() => {
      const harness = window.timelineCollapsedHistoryHarness!;
      const root = harness.scroller();
      const capture = (anchorKey?: string | null) => {
        const rootTop = root.getBoundingClientRect().top;
        const group = anchorKey
          ? Array.from(root.querySelectorAll<HTMLElement>("[data-og-timeline-group-anchor]")).find(
              (node) => node.dataset.ogGroupKey === anchorKey,
            )
          : root.querySelector<HTMLElement>("[data-og-timeline-group-anchor]");
        return group
          ? {
              key: group.dataset.ogGroupKey ?? null,
              top: group.getBoundingClientRect().top - rootTop,
            }
          : null;
      };
      const before = capture();
      harness.settleLoad(1, "success", true);
      return { before, after: capture(before?.key) };
    });
    expect(anchorEvidence.before).not.toBeNull();
    expect(anchorEvidence.after?.key).toBe(anchorEvidence.before?.key);
    expect(anchorEvidence.after?.top).toBeCloseTo(anchorEvidence.before?.top ?? 0, 0);

    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
    expect(
      await page.evaluate(() => {
        const metrics = window.timelineCollapsedHistoryHarness!.metrics();
        return metrics.maxScroll - metrics.scrollTop;
      }),
    ).toBeGreaterThan(48);
  }, 30_000);

  test("keeps a pending older owner across bounded live-tail eviction", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load&overlap-loads`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    // Append at the live edge while enforcing a bounded newest-suffix window:
    // the pending request's oldest row disappears, but newer retained rows
    // prove this is forward eviction rather than a committed older page.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.appendBoundedLivePage());
    await page.locator('[data-conversation-message="user-1200"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 800,
    );
    await page.waitForTimeout(500);

    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop < 100,
    );
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // Rejection still settles A's rebased owner. Resize callbacks cannot turn
    // it into an automatic duplicate, and one explicit retry owns B.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleLoad(1, "failure"));
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });
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

    // B's successful prepend preserves the retained row/pixel anchor and
    // retires the retry without permitting any stale callback to reopen it.
    const anchorEvidence = await page.evaluate(() => {
      const harness = window.timelineCollapsedHistoryHarness!;
      const root = harness.scroller();
      const rootTop = root.getBoundingClientRect().top;
      const before = root.querySelector<HTMLElement>("[data-og-timeline-group-anchor]");
      const key = before?.dataset.ogGroupKey ?? null;
      const top = before ? before.getBoundingClientRect().top - rootTop : null;
      harness.settleLoad(2, "success", true);
      const after = key
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-og-timeline-group-anchor]")).find(
            (node) => node.dataset.ogGroupKey === key,
          )
        : null;
      return {
        key,
        top,
        afterKey: after?.dataset.ogGroupKey ?? null,
        afterTop: after ? after.getBoundingClientRect().top - rootTop : null,
      };
    });
    expect(anchorEvidence.key).not.toBeNull();
    expect(anchorEvidence.afterKey).toBe(anchorEvidence.key);
    expect(anchorEvidence.afterTop).toBeCloseTo(anchorEvidence.top ?? 0, 0);
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("continues sentinel pagination after a zero-overlap older-page replacement", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&overlap-loads&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    // Live newest-suffix bounding first removes A's original oldest row. The
    // owner is unmarked, so this remains forward eviction and A owns the
    // underfill/sentinel paths.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.appendBoundedLivePage());
    await page.locator('[data-conversation-message="user-1200"]').waitFor({ timeout: 5_000 });
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // The accepted older page then fills the oldest-directed cap by itself,
    // replacing every prior row. Its exact commit mark releases A even with zero
    // identity overlap; the scrollable replacement waits for reader intent.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.replaceWithFullOlderPage());
    await page.locator('[data-conversation-message="user-500"]').waitFor({ timeout: 5_000 });
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 400,
    );
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop < 100,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);

    // A's delayed settlement cannot release or reclaim B. Resize callbacks do
    // not duplicate B, and B can commit the retained older page normally.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleLoad(1, "success"));
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleLoad(2, "success", true),
    );
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("anchors a reader-driven zero-overlap older replacement at its bottom seam", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&overlap-loads&omit-loading-older&prefetch-window`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 400,
    );

    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop < 100,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);
    const before = await page.evaluate(() => window.timelineCollapsedHistoryHarness!.metrics());

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.replaceWithFullOlderPage());
    await page.locator('[data-conversation-message="user-100"]').waitFor({ timeout: 5_000 });
    const after = await page.evaluate(() => window.timelineCollapsedHistoryHarness!.metrics());
    expect(before.scrollTop).toBeLessThan(100);
    expect(after.maxScroll - after.scrollTop).toBeLessThan(2);
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 400);
    expect(await page.getByRole("button", { name: "Jump to latest" }).count()).toBe(1);

    // The delayed request settlement cannot reclaim the committed owner. Once
    // the reader leaves the seam and approaches the top again, exactly one new
    // sentinel request owns the replacement window.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleLoad(1, "success"));
    await page.mouse.wheel(0, 8_000);
    await page.waitForFunction(() => {
      const metrics = window.timelineCollapsedHistoryHarness!.metrics();
      return metrics.maxScroll - metrics.scrollTop < 2;
    });
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().scrollTop < 100,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
  }, 30_000);

  test("retries one transient underfill failure without resize loops or duplicate requests", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    // Streaming at the live edge changes the newest item and row count only.
    // The pending older-page owner must survive so its rejection can still
    // authorize the explicit retry.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.appendLiveItem());
    await page.locator('[data-conversation-message="user-1001"]').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("failure"));
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });

    // Tail-only growth after failure must preserve Retry and must not become a
    // silent automatic retry for hosts without synchronous loading state.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.appendLiveItem());
    await page.locator('[data-conversation-message="user-1002"]').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    expect(await retry.count()).toBe(1);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // A timeline/chrome resize can make the rejected window scrollable.
    // Observing that geometry must not auto-load, and the explicit retry must
    // remain usable.
    await page.locator(".timeline-collapsed-history-shell").evaluate((node) => {
      (node as HTMLElement).style.height = "140px";
    });
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 1,
    );
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    await page.locator(".timeline-collapsed-history-shell").evaluate((node) => {
      (node as HTMLElement).style.height = "139px";
      (node as HTMLElement).style.height = "140px";
    });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);
    expect(await retry.count()).toBe(0);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("keeps Retry hidden until a fulfilled non-final older page commits", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    // The request fulfills before its successful non-final prepend commits.
    // A speculative Retry click and viewport resize must not replace its exact
    // same-boundary owner or start a concurrent request.
    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("success"),
    );
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("[data-og-retry]")?.click();
    });
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.getByRole("button", { name: "Retry earlier activity" }).count()).toBe(0);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // The delayed prepend advances the oldest boundary while preserving
    // hasOlder=true. Only that committed progress may start page B.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.prependUnderfilledPage());
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    expect(await page.getByRole("button", { name: "Retry earlier activity" }).count()).toBe(0);

    // B rejection confirms no progress and exposes exactly one bounded retry.
    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("failure"),
    );
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });
    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 3);
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(3);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);
  }, 30_000);

  test("continues pagination after a fulfilled fully filtered older page", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&omit-loading-older&suppress-auth-needed`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("success"),
    );
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
    expect(await page.getByRole("button", { name: "Retry earlier activity" }).count()).toBe(0);

    // The committed durable page contains only a suppressed auth notice, so
    // the visible first row does not change. Its pre-filter progress receipt
    // must still release A and request page B.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.prependFilteredOlderPage());
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    expect(await page.getByText("example.com").count()).toBe(0);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("continues pagination after a committed projection-empty older page", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&empty-window&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("success"),
    );
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // A raw durable page committed, but every event was omitted by projection.
    // The exact receipt must release A even though the projected source remains
    // empty, allowing the next page with visible history to start.
    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.commitProjectionEmptyOlderPage(),
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    expect(await page.getByRole("button", { name: "Retry earlier activity" }).count()).toBe(0);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("continues pagination after a committed same-first-id older page", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("success"),
    );
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // Projection merged the accepted raw page into the existing first row.
    // The row id is unchanged, but the commit receipt must still retire A and
    // admit exactly one follow-on older request.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.commitSameFirstOlderPage());
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    expect(await page.getByRole("button", { name: "Retry earlier activity" }).count()).toBe(0);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("keeps an empty rejected page behind one explicit retry", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&empty-window&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("failure"),
    );
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });

    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("continues pagination after the first successful page from an empty window", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&empty-window&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    // Promise fulfillment is not progress by itself. Once the first durable
    // page commits, undefined → defined is a real boundary advance and must
    // release A so the still-underfilled window can request page B.
    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("success"),
    );
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.prependUnderfilledPage());
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);

    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("promotes a settled prefetch after viewport collapse to bounded retry", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?manual-load&prefetch-window&omit-loading-older`,
    );
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    const scroller = page.locator("[data-collapsed-history-test] [data-og-timeline-scroller]");
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll > 800,
    );
    await scroller.hover();
    await page.mouse.wheel(0, -8_000);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.locator(".timeline-collapsed-history-shell").evaluate((node) => {
      (node as HTMLElement).style.height = "10000px";
    });
    await page.waitForFunction(
      () => window.timelineCollapsedHistoryHarness!.metrics().maxScroll <= 1,
    );
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleOlderWithoutPrepend("failure"),
    );
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    await page.locator(".timeline-collapsed-history-shell").evaluate((node) => {
      (node as HTMLElement).style.height = "9999px";
      (node as HTMLElement).style.height = "10000px";
    });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);
  }, 30_000);

  test("removes Retry when the public older loader disappears", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("failure"));
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });
    expect(
      await page.evaluate(() =>
        window.timelineCollapsedHistoryHarness!.clickRetainedRetryAfterRemovingLoader(),
      ),
    ).toBe(true);
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);

    expect(await retry.count()).toBe(0);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);
  }, 30_000);

  test("keeps the newer underfill owner when the previous page settles late", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-collapsed-history-test.html?manual-load&overlap-loads`);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness !== undefined);
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);

    // Page A commits a still-underfilled page B before A's promise settles.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.prependUnderfilledPage());
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    // A settles after B owns the marker. Neither the settlement commit nor
    // resize callbacks may reopen a duplicate B request.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleLoad(1, "success"));
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    // B can still reject and authorize one explicit retry; repeated resizes
    // and the exiting retry node never start another concurrent load.
    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleLoad(2, "failure"));
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 3);
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(3);

    await page.evaluate(() =>
      window.timelineCollapsedHistoryHarness!.settleLoad(3, "success", true),
    );
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(3);
  }, 30_000);

  test("retries older pagination after newer navigation declines a collapse backfill", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${baseUrl}/timeline-collapsed-history-test.html?dynamic-collapse&decline-during-newer&manual-load`,
    );
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
    expect(await page.locator("[data-og-loading-newer]").count()).toBe(1);

    // Collapsing the window makes it underfilled while newer pagination owns
    // the first-party navigation lock. loadOlder declines with exact `false`.
    await step.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 1);
    const retry = page.getByRole("button", { name: "Retry earlier activity" });
    await retry.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    // Resize callbacks cannot amplify the declined request while Retry owns
    // this exact oldest boundary.
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(1);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.finishNewer());
    await page.waitForFunction(() => document.querySelector("[data-og-loading-newer]") === null);
    expect(await retry.count()).toBe(1);

    await retry.click();
    await page.waitForFunction(() => window.timelineCollapsedHistoryHarness!.loadCalls() === 2);
    await page.setViewportSize({ width: 1280, height: 899 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.timelineCollapsedHistoryHarness!.loadCalls())).toBe(2);

    await page.evaluate(() => window.timelineCollapsedHistoryHarness!.settleOlder("success"));
    await page.locator('[data-conversation-message="user-1"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("[data-og-retry]") === null);
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

  test("keeps one held-turn commentary reply visible across disclosure collapse and expand", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/timeline-held-turn-test.html`);

    const fallback = page.getByText("The child is still running; I will resume when it finishes.", {
      exact: true,
    });
    const disclosure = page.getByRole("button", { name: /steps?/ }).first();

    await fallback.waitFor({ timeout: 5_000 });
    expect(await fallback.count()).toBe(1);
    expect(await fallback.isVisible()).toBe(true);
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");

    await disclosure.click();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await fallback.count()).toBe(1);
    expect(await fallback.isVisible()).toBe(true);
    expect(await page.getByText("Wait for input", { exact: false }).count()).toBe(1);

    await disclosure.click();
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await fallback.count()).toBe(1);
    expect(await fallback.isVisible()).toBe(true);

    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: `${artifactDir}/timeline-held-turn-commentary-visible.png`,
        fullPage: true,
      });
    }
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
      prependDeferred: () => void;
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
