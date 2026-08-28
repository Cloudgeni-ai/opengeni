// Real-browser tip-follow convergence regression.
//
// The happy-dom shell tests store exact fractional scrollTop, so they cannot
// see the class of bug where the engine floors sub-device-pixel writes: the
// settle-phase camera slowed under 1px/frame, every write was discarded, and
// pinned follow parked 20-50px short of the tip forever (clipped under the
// SessionChrome dock, still inside the pin band — no Jump-to-latest). This
// suite drives the screenshot scenario end-to-end in Chromium: nested
// tool/late-layout growth inside a live step, an in-flow chrome dock shrinking
// the scroller mid-stream, then a pause — and asserts the camera lands on the
// exact tip.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;

async function waitForTip(page: Page): Promise<number> {
  await page.waitForFunction(
    () => window.tipFollowHarness!.metrics().distanceFromTip <= 1,
    undefined,
    { timeout: 8_000 },
  );
  return (await page.evaluate(() => window.tipFollowHarness!.metrics())).distanceFromTip;
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function pressScrollKeyAndWait(page: Page, key: "End" | "PageUp"): Promise<void> {
  const settled = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
        if (!node) throw new Error("timeline scroller is unavailable");
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        if ("onscrollend" in node) {
          node.addEventListener("scrollend", finish, { once: true });
        } else {
          let previous = node.scrollTop;
          let stableFrames = 0;
          const sample = () => {
            if (Math.abs(node.scrollTop - previous) < 0.5) {
              stableFrames += 1;
            } else {
              stableFrames = 0;
              previous = node.scrollTop;
            }
            if (stableFrames >= 3) finish();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }
        setTimeout(finish, 2_000);
      }),
  );
  await page.keyboard.press(key);
  await settled;
}

type HarnessOptions = {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  reducedMotion?: "no-preference" | "reduce";
};

describe("timeline tip-follow browser regression", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  const browserErrors: string[] = [];

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
  }, 60_000);

  afterAll(async () => {
    try {
      expect(browserErrors).toEqual([]);
    } finally {
      await Promise.allSettled([browser?.close(), web?.stop()]);
    }
  });

  async function openHarness(options: HarnessOptions = {}): Promise<{
    context: BrowserContext;
    page: Page;
  }> {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      reducedMotion: options.reducedMotion ?? "no-preference",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location().url;
      if (location.endsWith("/favicon.ico")) return;
      browserErrors.push(`console: ${message.text()}`);
    });
    await page.goto(`${baseUrl}/timeline-tip-follow-test.html`);
    await page.waitForFunction(() => window.tipFollowHarness !== undefined);
    // First-paint park + reveal.
    await page.waitForTimeout(600);
    expect((await page.evaluate(() => window.tipFollowHarness!.metrics())).distanceFromTip).toBe(0);
    return { context, page };
  }

  test("streamed nested growth + mid-stream chrome dock + pause converges to the exact tip", async () => {
    const { context, page } = await openHarness();
    try {
      for (let beat = 0; beat < 40; beat += 1) {
        await page.evaluate(() => window.tipFollowHarness!.lateGrow(10));
        if (beat % 5 === 4) {
          await page.evaluate(() => window.tipFollowHarness!.appendToolRow());
        }
        if (beat === 20) {
          await page.evaluate(() => window.tipFollowHarness!.dockChrome(56));
        }
        await page.waitForTimeout(50);
      }
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a single late-layout burst with a same-beat chrome dock still lands on the tip", async () => {
    const { context, page } = await openHarness();
    try {
      await page.evaluate(() => {
        window.tipFollowHarness!.lateGrow(300);
        window.tipFollowHarness!.dockChrome(56);
      });
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("pinned live growth is visible by the next paint instead of creating camera debt", async () => {
    const { context, page } = await openHarness();
    try {
      await page.evaluate(() => window.tipFollowHarness!.lateGrow(300));
      await nextPaint(page);
      expect((await page.evaluate(() => window.tipFollowHarness!.metrics())).distanceFromTip).toBe(
        0,
      );
    } finally {
      await context.close();
    }
  }, 30_000);

  test("content-shrink deadband is invariant to 3px and 6px animation cadences", async () => {
    const first = await openHarness();
    const second = await openHarness();
    const run = async (page: Page, steps: readonly number[]) => {
      await page.evaluate(() => window.tipFollowHarness!.lateGrow(120));
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
      const before = await page.evaluate(() => window.tipFollowHarness!.metrics());
      let maxDebt = 0;
      for (const step of steps) {
        await page.evaluate((amount) => window.tipFollowHarness!.lateGrow(-amount), step);
        await nextPaint(page);
        const metrics = await page.evaluate(() => window.tipFollowHarness!.metrics());
        maxDebt = Math.max(maxDebt, metrics.distanceFromTip);
      }
      return {
        before,
        after: await page.evaluate(() => window.tipFollowHarness!.metrics()),
        maxDebt,
      };
    };
    try {
      const fine = await run(
        first.page,
        Array.from({ length: 20 }, () => 3),
      );
      const coarse = await run(
        second.page,
        Array.from({ length: 10 }, () => 6),
      );
      for (const result of [fine, coarse]) {
        expect(result.after.scrollHeight).toBeCloseTo(result.before.scrollHeight - 60, 0);
        expect(result.after.scrollTop).toBeCloseTo(result.before.scrollTop - 60, 0);
        expect(result.after.distanceFromTip).toBeLessThanOrEqual(1);
        expect(result.maxDebt).toBeLessThanOrEqual(1);
      }
      expect(coarse.after.scrollTop).toBeCloseTo(fine.after.scrollTop, 0);
    } finally {
      await Promise.all([first.context.close(), second.context.close()]);
    }
  }, 30_000);

  test("wheel-up during the settle glide still unpins (echo counting stays honest)", async () => {
    const { context, page } = await openHarness();
    try {
      // Kick a settle glide, then wheel up mid-glide: the reader must win.
      await page.evaluate(() => window.tipFollowHarness!.lateGrow(200));
      await page.waitForTimeout(120);
      const scroller = page.locator("[data-tip-follow] .og-root > div");
      await scroller.hover();
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(400);
      const metrics = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(metrics.pinned).toBe(false);
      // Growth after leave must not yank the reader back to the tip.
      await page.evaluate(() => window.tipFollowHarness!.lateGrow(120));
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(after.scrollTop).toBeLessThanOrEqual(metrics.scrollTop + 1);
    } finally {
      await context.close();
    }
  }, 30_000);

  for (const scenario of [
    {
      name: "narrow mobile at DPR 3",
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      reducedMotion: "no-preference" as const,
      shell: { width: 326, height: 700 },
    },
    {
      name: "tablet with reduced motion",
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce" as const,
      shell: { width: 704, height: 820 },
    },
    {
      name: "desktop at fractional device scaling",
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1.25,
      reducedMotion: "no-preference" as const,
      shell: { width: 900, height: 680 },
    },
  ]) {
    test(`keeps pinned stream truth through responsive churn on ${scenario.name}`, async () => {
      const { context, page } = await openHarness(scenario);
      try {
        await page.evaluate((shell) => {
          window.tipFollowHarness!.setShellSize(shell.width, shell.height);
        }, scenario.shell);
        expect(await waitForTip(page)).toBeLessThanOrEqual(1);

        for (let beat = 0; beat < 24; beat += 1) {
          await page.evaluate((currentBeat) => {
            const harness = window.tipFollowHarness!;
            harness.appendStreamText(
              currentBeat % 4 === 0
                ? "\nA wrapped streaming line arrives with enough words to exercise responsive layout."
                : " token",
            );
            if (currentBeat % 3 === 0) harness.lateGrow(11);
            if (currentBeat % 6 === 5) harness.appendToolRow();
            if (currentBeat === 6) harness.setComposerHeight(148);
            if (currentBeat === 10) harness.dockChrome(58);
            if (currentBeat === 14) {
              harness.setShellSize(
                Math.max(300, Math.round(window.innerWidth * 0.68)),
                Math.max(520, Math.round(window.innerHeight * 0.72)),
              );
            }
            if (currentBeat === 19) harness.setShellSize(window.innerWidth - 64, 680);
          }, beat);
          await nextPaint(page);
          const metrics = await page.evaluate(() => window.tipFollowHarness!.metrics());
          expect(metrics.pinned).toBe(true);
          expect(metrics.distanceFromTip).toBeLessThanOrEqual(1);
        }

        expect(await waitForTip(page)).toBeLessThanOrEqual(1);
        const finalMetrics = await page.evaluate(() => window.tipFollowHarness!.metrics());
        expect(finalMetrics.horizontalOverflow).toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    }, 45_000);
  }

  test("keyboard leave, history prepend, late reflow, and End preserve reader ownership", async () => {
    const { context, page } = await openHarness();
    try {
      const scroller = page.locator("[data-og-timeline-scroller]");
      await scroller.focus();
      await pressScrollKeyAndWait(page, "PageUp");
      await page.waitForFunction(() => !window.tipFollowHarness!.metrics().pinned);
      const before = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(before.scrollTop).toBeLessThan(before.maxScroll - 100);

      for (const operation of [
        "prepend",
        "grow-above",
        "append-tip",
        "late-grow-tip",
        "resize-shell",
      ] as const) {
        await page.evaluate((currentOperation) => {
          const harness = window.tipFollowHarness!;
          switch (currentOperation) {
            case "prepend":
              harness.prepend(8);
              break;
            case "grow-above":
              harness.growRowsAbove(29);
              break;
            case "append-tip":
              harness.appendStreamText(
                "\nLate content at the live tip must not yank an unpinned reader.",
              );
              break;
            case "late-grow-tip":
              harness.lateGrow(96);
              break;
            case "resize-shell":
              harness.setShellSize(760, 640);
          }
        }, operation);
        await nextPaint(page);
        const afterOperation = await page.evaluate(() => window.tipFollowHarness!.metrics());
        if (
          afterOperation.pinned ||
          afterOperation.visible.id !== before.visible.id ||
          Math.abs((afterOperation.visible.top ?? 0) - (before.visible.top ?? 0)) >= 1
        ) {
          throw new Error(
            `reader anchor changed after ${operation}: before=${JSON.stringify(before)} after=${JSON.stringify(afterOperation)}`,
          );
        }
      }

      await pressScrollKeyAndWait(page, "End");
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
      expect((await page.evaluate(() => window.tipFollowHarness!.metrics())).pinned).toBe(true);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("coarse-pointer upward gesture unpins and later tip growth cannot yank the reader", async () => {
    const { context, page } = await openHarness({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
    });
    try {
      await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
        if (!node) throw new Error("timeline scroller is unavailable");
        node.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerId: 1,
            pointerType: "touch",
          }),
        );
        node.scrollTop = Math.max(0, node.scrollTop - 320);
        node.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerId: 1,
            pointerType: "touch",
          }),
        );
        node.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerId: 1,
            pointerType: "touch",
          }),
        );
      });
      await page.waitForFunction(() => {
        const metrics = window.tipFollowHarness!.metrics();
        return !metrics.pinned && metrics.scrollTop < metrics.maxScroll - 100;
      });
      const before = await page.evaluate(() => window.tipFollowHarness!.metrics());

      await page.evaluate(() => {
        window.tipFollowHarness!.appendStreamText(
          "\nA coarse-pointer reader is still inspecting earlier content.",
        );
        window.tipFollowHarness!.lateGrow(180);
      });
      await nextPaint(page);
      const after = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(after.pinned).toBe(false);
      expect(after.visible.id).toBe(before.visible.id);
      expect(after.visible.top).toBeCloseTo(before.visible.top ?? 0, 0);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("cumulative one-pixel pointer scrolling leaves the tip", async () => {
    const { context, page } = await openHarness({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
    });
    try {
      await page.evaluate(async () => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
        if (!node) throw new Error("timeline scroller is unavailable");
        node.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerId: 2,
            pointerType: "touch",
          }),
        );
        for (let step = 0; step < 80; step += 1) {
          node.scrollTop = Math.max(0, node.scrollTop - 1);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        node.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            isPrimary: true,
            pointerId: 2,
            pointerType: "touch",
          }),
        );
      });
      await page.waitForFunction(() => !window.tipFollowHarness!.metrics().pinned);
      const before = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(before.distanceFromTip).toBeGreaterThan(48);

      await page.evaluate(() => window.tipFollowHarness!.lateGrow(120));
      await nextPaint(page);
      const after = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(after.pinned).toBe(false);
      expect(after.visible.id).toBe(before.visible.id);
      expect(after.visible.top).toBeCloseTo(before.visible.top ?? 0, 0);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a frozen page catches up to the exact tip after queued layout resumes", async () => {
    const { context, page } = await openHarness();
    const cdp = await context.newCDPSession(page);
    try {
      await page.evaluate(() => {
        setTimeout(() => {
          window.tipFollowHarness!.appendStreamText("\nbackground token wall");
          window.tipFollowHarness!.lateGrow(360);
        }, 100);
      });
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      await page.waitForFunction(() => window.tipFollowHarness!.operations().length >= 2);
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
      const metrics = await page.evaluate(() => window.tipFollowHarness!.metrics());
      expect(metrics.pinned).toBe(true);
      expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
    } finally {
      await cdp.detach().catch(() => {});
      await context.close();
    }
  }, 30_000);

  test("seeded mixed-operation stress keeps explicit reader and camera invariants", async () => {
    const { context, page } = await openHarness({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 2,
    });
    try {
      await page.evaluate(() => {
        const trace = { active: true, frames: [] as number[], longTasks: [] as number[] };
        window.tipFollowPerformanceTrace = trace;
        const sample = (timestamp: number) => {
          trace.frames.push(timestamp);
          if (trace.active) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        if (typeof PerformanceObserver !== "undefined") {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) trace.longTasks.push(entry.duration);
          });
          try {
            observer.observe({ type: "longtask" });
          } catch {
            // Frame intervals remain the portable performance signal.
          }
        }
      });
      let seed = 0x51a7c0de;
      const next = () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 0x1_0000_0000;
      };

      for (let step = 0; step < 60; step += 1) {
        const operation = Math.floor(next() * 6);
        const amount = 4 + Math.floor(next() * 24);
        await page.evaluate(
          ({ operation: currentOperation, amount: currentAmount, step: currentStep }) => {
            const harness = window.tipFollowHarness!;
            switch (currentOperation) {
              case 0:
                harness.appendStreamText(currentStep % 5 === 0 ? "\nseeded wrapped line" : " x");
                break;
              case 1:
                harness.lateGrow(currentAmount);
                break;
              case 2:
                harness.appendToolRow();
                break;
              case 3:
                harness.setComposerHeight(72 + currentAmount * 2);
                break;
              case 4:
                harness.dockChrome(36 + currentAmount);
                break;
              default:
                harness.setShellSize(620 + currentAmount * 6, 560 + currentAmount * 3);
            }
          },
          { operation, amount, step },
        );
        await nextPaint(page);
        const metrics = await page.evaluate(() => window.tipFollowHarness!.metrics());
        expect(metrics.pinned).toBe(true);
        if (metrics.distanceFromTip > 4) {
          const operations = await page.evaluate(() => window.tipFollowHarness!.operations());
          throw new Error(
            `seed 0x51a7c0de exceeded the viewport deadband at step ${step}: operation=${operation} amount=${amount} metrics=${JSON.stringify(metrics)} trace=${JSON.stringify(operations)}`,
          );
        }
        if (step % 10 === 9) {
          expect(await waitForTip(page)).toBeLessThanOrEqual(1);
        }
      }

      const operations = await page.evaluate(() => window.tipFollowHarness!.operations());
      expect(operations).toHaveLength(60);
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
      const performanceMetrics = await page.evaluate(() => {
        const trace = window.tipFollowPerformanceTrace!;
        trace.active = false;
        const intervals = trace.frames
          .slice(1)
          .map((timestamp, index) => timestamp - trace.frames[index]!)
          .sort((left, right) => left - right);
        return {
          frameCount: trace.frames.length,
          frameIntervalP95:
            intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] ?? 0,
          longestTask: Math.max(0, ...trace.longTasks),
          ...window.tipFollowHarness!.metrics(),
        };
      });
      expect(performanceMetrics.frameCount).toBeGreaterThan(60);
      expect(performanceMetrics.frameIntervalP95).toBeLessThan(100);
      expect(performanceMetrics.longestTask).toBeLessThan(150);
      expect(performanceMetrics.renderedRows).toBeLessThan(100);
      expect(performanceMetrics.horizontalOverflow).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 60_000);
});

declare global {
  interface Window {
    tipFollowPerformanceTrace?: {
      active: boolean;
      frames: number[];
      longTasks: number[];
    };
  }
}
