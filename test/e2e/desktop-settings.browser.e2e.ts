import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

// Where macOS draws the traffic lights (centred about 28px down, ending about
// 70px in) and, while the window is shared, the purple sharing badge (about
// 15-80px across, 18-37px down).
const WINDOW_CONTROL_POINTS = [
  [16, 20],
  [24, 28],
  [44, 28],
  [64, 28],
  [78, 36],
  [40, 40],
] as const;

test("the macOS settings rail keeps the window controls row outside its scrolling list", async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/test/desktop-settings.html`;
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
    for (const platform of ["macos", "windows", "browser"]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}?platform=${platform}`);
      const rail = page.locator("[data-settings-rail]");
      const back = rail.getByRole("link", { name: "Back to sessions" });
      await back.waitFor({ timeout: 90_000 });
      const controls = page.locator("[data-settings-window-controls]");
      const backTop = (await back.boundingBox())!.y;
      if (platform === "macos") {
        // A fixed row for the controls, then the list; the back link starts where it did.
        expect(await controls.count()).toBe(1);
        expect(await controls.boundingBox()).toMatchObject({ y: 0, height: 44 });
        expect(
          await controls.evaluate((element) =>
            getComputedStyle(element).getPropertyValue("-webkit-app-region"),
          ),
        ).toBe("drag");
        expect((await rail.boundingBox())!.y).toBe(44);
        expect(backTop).toBe(56);
        expect(await page.locator("[data-rail-header]").count()).toBe(0);
      } else {
        expect(await controls.count()).toBe(0);
        expect((await rail.boundingBox())!.y).toBe(0);
        // The brand row sits above the back link outside macOS.
        expect(await rail.getByRole("link", { name: "Opengeni home" }).count()).toBe(1);
      }
      // Scroll the list part-way, so the picker and search sit near the top.
      await rail.evaluate((element) => {
        element.scrollTop = 72;
      });
      expect(await rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect((await back.boundingBox())!.y).toBeLessThan(backTop);
      if (platform === "macos") {
        // Nothing in the list is drawn or clickable under the controls or the badge.
        for (const [x, y] of WINDOW_CONTROL_POINTS) {
          expect(
            await page.evaluate(
              ([px, py]) =>
                document.elementFromPoint(px, py)?.closest("[data-settings-rail]") != null,
              [x, y] as const,
            ),
          ).toBe(false);
        }
        expect(await controls.boundingBox()).toMatchObject({ y: 0, height: 44 });
        await rail.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        for (const [x, y] of WINDOW_CONTROL_POINTS) {
          expect(
            await page.evaluate(
              ([px, py]) =>
                document.elementFromPoint(px, py)?.closest("[data-settings-rail]") != null,
              [x, y] as const,
            ),
          ).toBe(false);
        }
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 180_000);
