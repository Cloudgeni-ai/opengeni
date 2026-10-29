import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

import { expectWindowTop, simulateWindowsTitleBar, WINDOW_BAR_HEIGHT } from "./desktop-window-bar";

test("the rail starts below the desktop window bar and scrolls clear of the window controls", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/test/desktop-rail.html`;
  const output = process.env.OPENGENI_DESKTOP_RAIL_ARTIFACT_DIR;
  if (output) await mkdir(output, { recursive: true });
  const web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--config",
      "test/desktop-rail-preview.vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      ready: async () => (await fetch(url).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const platform of ["macos", "windows", "linux", "browser"]) {
      for (const width of [1280, 640]) {
        const page = await browser.newPage({ viewport: { width, height: 420 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        if (platform === "windows") await simulateWindowsTitleBar(page);
        await page.goto(`${url}?platform=${platform}`);
        const toggle = page.getByRole("button", { name: "Collapse sidebar", exact: true });
        await toggle.waitFor({ timeout: 90_000 });
        await page.locator("[data-session-row]").first().waitFor();
        const viewport = page.locator("[data-rail-scroll-viewport]");
        const header = page.locator("[data-rail-header]");
        const top = platform === "macos" || platform === "windows" ? WINDOW_BAR_HEIGHT : 0;
        // One rail layout everywhere: the list starts at the top of the page,
        // which on macOS and Windows is below the window bar.
        expect((await viewport.boundingBox())!.y).toBe(top);
        const before = (await header.boundingBox())!;
        expect(before.y).toBeGreaterThanOrEqual(top);
        await expectWindowTop(page, platform);
        if (output) await page.screenshot({ path: `${output}/${platform}-${width}-top.png` });
        await viewport.evaluate((element) => {
          element.scrollTop = 240;
        });
        expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        // The header scrolls with the list and never reaches the window controls.
        expect((await header.boundingBox())!.y).toBeLessThan(before.y);
        await expectWindowTop(page, platform);
        if (output) await page.screenshot({ path: `${output}/${platform}-${width}-scrolled.png` });
        // Pointer collapse and keyboard expansion remain available after scrolling.
        await toggle.click();
        const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
        expect((await expand.boundingBox())!.y).toBeGreaterThanOrEqual(top);
        await expectWindowTop(page, platform);
        if (output) await page.screenshot({ path: `${output}/${platform}-${width}-collapsed.png` });
        await expand.focus();
        await page.keyboard.press("Enter");
        await toggle.waitFor();
        expect((await viewport.boundingBox())!.y).toBe(top);
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 180_000);
