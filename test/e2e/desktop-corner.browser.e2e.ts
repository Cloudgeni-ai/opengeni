import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";

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

describe("the macOS window controls' corner", () => {
  let browser: Browser;
  let web: StartedProcess;
  let url: string;

  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/test/desktop-corner.html`;
    web = await startProcess(
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
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("the settings rail keeps the window controls row outside its scrolling list", async () => {
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
  }, 180_000);

  test("a content page beside a collapsed rail starts past the controls and sharing badge", async () => {
    const titleLeft = new Map<string, number>();
    for (const platform of ["browser", "windows", "macos"]) {
      for (const width of [900, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 600 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?view=content&platform=${platform}`);
        const title = page.getByRole("heading", { name: "Automations", exact: true });
        await title.waitFor({ timeout: 90_000 });
        const expanded = (await title.boundingBox())!;
        await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
        const collapsed = (await title.boundingBox())!;
        // The title is in the window's top row (Windows keeps its caption row clear).
        if (platform !== "windows") expect(collapsed.y).toBeLessThan(44);
        if (platform === "macos") {
          // 32px past the 56px rail, like the session title bar, at every width;
          // beside the open rail nothing changes.
          expect(collapsed.x).toBe(Math.max(88, titleLeft.get(`browser-${width}-collapsed`)!));
          expect(expanded.x).toBe(titleLeft.get(`browser-${width}-expanded`)!);
        } else {
          titleLeft.set(`${platform}-${width}-collapsed`, collapsed.x);
          titleLeft.set(`${platform}-${width}-expanded`, expanded.x);
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
    // The web and Windows layouts are unchanged: 24px past the rail below
    // 1024px, then the centred column with its 32px inset.
    expect(Object.fromEntries(titleLeft)).toEqual({
      "browser-900-collapsed": 80,
      "browser-900-expanded": 312,
      "browser-1280-collapsed": 188,
      "browser-1280-expanded": 320,
      "windows-900-collapsed": 80,
      "windows-900-expanded": 312,
      "windows-1280-collapsed": 188,
      "windows-1280-expanded": 320,
    });
  }, 180_000);
});
