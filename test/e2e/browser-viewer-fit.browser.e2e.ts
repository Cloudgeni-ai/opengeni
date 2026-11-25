import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";
import { chromium } from "playwright";

test("BrowserViewer can fit the page to its panel and keeps the fixed frame by default", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/browser.html`;
  const demo = await startProcess(
    ["bun", "run", "demo", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: new URL("../../packages/react", import.meta.url).pathname,
      ready: async () => (await fetch(url).catch(() => null))?.ok === true,
    },
  );
  const localChromium = "/usr/local/bin/chromium";
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync(localChromium) ? localChromium : undefined);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const canvas = page.getByLabel("Interactive browser page");
    await page.goto(`${url}?width=730`);
    await canvas.waitFor({ state: "visible" });
    expect(await canvas.getAttribute("width")).toBe("1280");
    expect((await canvas.boundingBox())?.height).toBeLessThan(450);

    await page.goto(`${url}?width=730&fitViewport=1`);
    const expectPanelFill = async (width: number) => {
      await page.waitForFunction((expectedWidth) => {
        const surface = document.querySelector<HTMLCanvasElement>(
          'canvas[aria-label="Interactive browser page"]',
        );
        const panel = surface?.parentElement;
        return (
          surface &&
          panel &&
          surface.width === expectedWidth &&
          surface.height === panel.clientHeight &&
          surface.getBoundingClientRect().height === panel.clientHeight
        );
      }, width);
      expect((await canvas.boundingBox())?.width).toBe(width);
    };
    await expectPanelFill(730);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPanelFill(390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectPanelFill(730);
  } finally {
    await browser?.close();
    await demo.stop();
  }
}, 45_000);
