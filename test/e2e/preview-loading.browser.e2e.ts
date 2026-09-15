import { afterAll, beforeAll, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

let server: StartedProcess;
let browser: Browser;
let url: string;

beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}/preview-loading-test.html`;
  server = await startProcess(
    ["bun", "run", "vite", ".", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: new URL("../../packages/react/demo", import.meta.url).pathname,
      ready: async () =>
        (await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

test("preview loading survives refresh, settles, and respects reduced motion", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(url);
  const status = page.getByRole("status");
  await status.waitFor();
  expect(await status.getAttribute("aria-busy")).toBe("true");
  expect(await page.locator("pre, .animate-og-pulse").count()).toBe(0);
  const canvas = status.locator('.og-preview-loading canvas[data-painted="true"]');
  await canvas.waitFor();
  expect(await canvas.getAttribute("aria-hidden")).toBe("true");
  expect(await status.getByText("Preparing preview…", { exact: true }).count()).toBe(1);
  expect(await status.locator(".og-command-reel").count()).toBe(0);
  const firstFrame = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  await page.waitForFunction(
    (previous) => {
      const surface = document.querySelector<HTMLCanvasElement>(".og-preview-loading canvas");
      return surface && surface.toDataURL() !== previous;
    },
    firstFrame,
  );
  expect(await status.getByRole("button").count()).toBe(0);
  expect(await canvas.evaluate((node) => node.getBoundingClientRect().height)).toBe(320);
  await page.reload();
  await status.waitFor();
  await canvas.waitFor();
  expect(await page.locator("pre").count()).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stillFrames = await canvas.evaluate(async (node) => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // Let the media-change listener repaint before sampling the static grid.
    await nextFrame();
    await nextFrame();
    const surface = node as HTMLCanvasElement;
    const before = surface.toDataURL();
    for (let frame = 0; frame < 4; frame += 1) await nextFrame();
    return { before, after: surface.toDataURL() };
  });
  expect(stillFrames.after).toBe(stillFrames.before);
  expect(await status.getByText("Preparing preview…", { exact: true }).count()).toBe(1);
  await page.getByText("Finish generation", { exact: true }).click();
  await page.locator('[data-preview="ready"]').waitFor();
  expect(await status.count()).toBe(0);
  expect(await page.locator(".og-preview-loading").count()).toBe(0);
  await page.reload();
  await page.getByText("Stop generation", { exact: true }).click();
  await page.getByText("Preview incomplete", { exact: true }).waitFor();
  expect(await status.getAttribute("aria-busy")).toBe("false");
  expect(await page.locator(".og-preview-loading").count()).toBe(0);
  expect(await status.locator(".og-command-reel-running").count()).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(
    await status
      .locator(".og-command-reel")
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
  await page.close();
});
