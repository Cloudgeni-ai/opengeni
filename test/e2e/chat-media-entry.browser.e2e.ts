import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
describe("rich chat media entry", () => {
  let browser: Browser;
  let web: StartedProcess;
  let baseUrl: string;
  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--config",
        "test/chat-media.vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        ready: async () =>
          (await fetch(`${baseUrl}/test/chat-media.html`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
  });
  afterAll(async () => {
    await browser?.close();
    await web?.stop();
  });

  async function geometry(page: Page) {
    return page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
      return {
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        viewport: scroller.clientHeight,
      };
    });
  }
  for (const width of [1280, 390]) {
    test(`delayed media preserves the initial tip and offscreen work stays deferred at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${baseUrl}/test/chat-media.html`);
        await page.waitForFunction(() => {
          const root = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
          return root && getComputedStyle(root).visibility !== "hidden" && root.scrollTop > 0;
        });
        await page.waitForFunction(
          () => window.chatMediaFixture?.siteReads > 0 && window.chatMediaFixture.imageReads > 0,
        );
        const before = await geometry(page);
        const initial = await page.evaluate(() => ({
          sites: window.chatMediaFixture.siteReads,
          images: window.chatMediaFixture.imageReads,
          active: document.querySelectorAll('[data-chat-media="active"]').length,
        }));
        expect(initial.sites).toBeLessThan(6);
        expect(initial.images).toBeLessThan(6);
        expect(initial.active).toBeLessThan(8);
        // Sample every frame through delayed metadata, bytes, iframe load and
        // the inline fragment's late growth, not only the settled endpoint.
        const movement = await page.evaluate(async () => {
          const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const top = node.scrollTop;
          const height = node.scrollHeight;
          let maxTopDelta = 0;
          let maxHeightDelta = 0;
          window.chatMediaFixture.release();
          const started = performance.now();
          while (performance.now() - started < 1200) {
            await new Promise(requestAnimationFrame);
            maxTopDelta = Math.max(maxTopDelta, Math.abs(node.scrollTop - top));
            maxHeightDelta = Math.max(maxHeightDelta, Math.abs(node.scrollHeight - height));
          }
          return { maxTopDelta, maxHeightDelta };
        });
        expect(movement.maxTopDelta).toBeLessThanOrEqual(2);
        expect(movement.maxHeightDelta).toBeLessThanOrEqual(2);
        console.info("chat-media-entry", JSON.stringify({ width, ...initial, ...movement }));
        const after = await geometry(page);
        expect(Math.abs(after.height - after.viewport - after.top)).toBeLessThanOrEqual(2);
        expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
        expect(await page.locator('[data-media-row="17"] img').count()).toBe(1);
        expect(await page.locator('[data-media-row="16"] iframe').count()).toBe(1);
        const artifactDir = process.env.CHAT_MEDIA_ARTIFACT_DIR;
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({ path: join(artifactDir, `chat-media-${width}.png`) });
          await page.locator('[data-media-row="16"]').screenshot({
            path: join(artifactDir, `chat-site-${width}.png`),
          });
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("reading older messages remains stable and interactive state survives scrolling and full-screen", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${baseUrl}/test/chat-media.html`);
      const scroller = page.locator("[data-og-timeline-scroller]");
      await page.waitForFunction(() => window.chatMediaFixture?.siteReads > 0);
      await scroller.hover({ position: { x: 5, y: 40 } });
      await page.mouse.wheel(0, -2200);
      await page.getByRole("button", { name: "Jump to latest" }).waitFor();
      const before = await geometry(page);
      const samples = await page.evaluate(async () => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
        const top = node.scrollTop;
        let delta = 0;
        window.chatMediaFixture.release();
        const start = performance.now();
        while (performance.now() - start < 1200) {
          await new Promise(requestAnimationFrame);
          delta = Math.max(delta, Math.abs(node.scrollTop - top));
        }
        return delta;
      });
      expect(samples).toBeLessThanOrEqual(2);
      expect(Math.abs((await geometry(page)).height - before.height)).toBeLessThanOrEqual(2);
      await page.getByRole("button", { name: "Jump to latest" }).click();
      const siteRow = page.locator('[data-media-row="16"]');
      const site = siteRow.frameLocator("iframe");
      await site.getByRole("button", { name: "Change state" }).click();
      await scroller.hover({ position: { x: 5, y: 40 } });
      await page.mouse.wheel(0, -2200);
      await page.getByRole("button", { name: "Jump to latest" }).waitFor();
      await page.getByRole("button", { name: "Jump to latest" }).click();
      expect(await site.getByRole("button", { name: "State retained" }).count()).toBe(1);
      const beforeFullscreen = await geometry(page);
      await siteRow.getByRole("button", { name: "Open Site full screen" }).click();
      expect((await geometry(page)).height).toBe(beforeFullscreen.height);
      expect(await site.getByRole("button", { name: "State retained" }).count()).toBe(1);
      await siteRow.getByRole("button", { name: "Back", exact: true }).click();
      expect((await geometry(page)).height).toBe(beforeFullscreen.height);
      expect(await site.getByRole("button", { name: "State retained" }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);
});
