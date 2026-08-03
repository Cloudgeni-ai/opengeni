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
import { chromium, type Browser, type Page } from "playwright";

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

describe("timeline tip-follow browser regression", () => {
  let web: StartedProcess;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

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
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  async function openHarness(): Promise<void> {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/timeline-tip-follow-test.html`);
    await page.waitForFunction(() => window.tipFollowHarness !== undefined);
    // First-paint park + reveal.
    await page.waitForTimeout(600);
    expect((await page.evaluate(() => window.tipFollowHarness!.metrics())).distanceFromTip).toBe(0);
  }

  test("streamed nested growth + mid-stream chrome dock + pause converges to the exact tip", async () => {
    await openHarness();
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
      await page.close();
    }
  }, 30_000);

  test("a single late-layout burst with a same-beat chrome dock still lands on the tip", async () => {
    await openHarness();
    try {
      await page.evaluate(() => {
        window.tipFollowHarness!.lateGrow(300);
        window.tipFollowHarness!.dockChrome(56);
      });
      expect(await waitForTip(page)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("wheel-up during the settle glide still unpins (echo counting stays honest)", async () => {
    await openHarness();
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
      await page.close();
    }
  }, 30_000);
});
