import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

test("macOS rail reserves native controls outside the scroll viewport", async () => {
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
        await page.goto(`${url}?platform=${platform}`);
        const toggle = page.getByRole("button", { name: "Collapse sidebar", exact: true });
        await toggle.waitFor({ timeout: 90_000 });
        await page.locator("[data-session-row]").first().waitFor();
        const viewport = page.locator("[data-rail-scroll-viewport]");
        const header = page.locator("[data-rail-header]");
        const before = await header.boundingBox();
        if (platform === "macos") {
          expect((await viewport.boundingBox())!.y).toBe(56);
          expect(await page.locator("[data-rail-window-controls]").count()).toBe(1);
          expect(await page.locator("[data-rail-window-controls] button").count()).toBe(1);
          if (output) await page.screenshot({ path: `${output}/macos-${width}-top.png` });
        } else {
          expect(await page.locator("[data-rail-window-controls]").count()).toBe(0);
          expect((await viewport.boundingBox())!.y).toBe(0);
        }
        await viewport.evaluate((element) => {
          element.scrollTop = 240;
        });
        expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        if (platform === "macos") {
          expect((await header.boundingBox())!.y).toBe(before!.y);
          expect(
            await page.evaluate(
              () =>
                document.elementFromPoint(40, 28)?.closest("[data-rail-scroll-viewport]") === null,
            ),
          ).toBe(true);
          if (output) await page.screenshot({ path: `${output}/macos-${width}-scrolled.png` });
          // Pointer collapse and keyboard expansion remain available after scrolling.
          await toggle.click();
          const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
          expect((await expand.boundingBox())!.y).toBeGreaterThanOrEqual(44);
          expect((await viewport.boundingBox())!.y).toBe(88);
          if (output) await page.screenshot({ path: `${output}/macos-${width}-collapsed.png` });
          await expand.focus();
          await page.keyboard.press("Enter");
          await toggle.waitFor();
          expect((await viewport.boundingBox())!.y).toBe(56);
        } else {
          expect((await header.boundingBox())!.y).toBeLessThan(before!.y);
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 180_000);
