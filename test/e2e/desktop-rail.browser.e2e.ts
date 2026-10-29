import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

import {
  expectWindowTop,
  MACOS_BAR_CONTROLS_LEFT,
  MACOS_BAR_ROW_LEFT,
  simulateWindowsTitleBar,
  WINDOW_BAR_HEIGHT,
  windowBarControls,
  windowBarRow,
} from "./desktop-window-bar";

let url: string;
let output: string | undefined;
let web: Awaited<ReturnType<typeof startProcess>>;
let browser: Browser;

beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}/test/desktop-rail.html`;
  output = process.env.OPENGENI_DESKTOP_RAIL_ARTIFACT_DIR;
  if (output) await mkdir(output, { recursive: true });
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
  await browser?.close();
  await web?.stop();
});

test("the rail starts below the desktop window bar and scrolls clear of the window controls", async () => {
  {
    for (const platform of ["macos", "windows", "linux", "browser"]) {
      for (const width of [1280, 640]) {
        const page = await browser.newPage({
          viewport: { width, height: 420 },
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        if (platform === "windows") await simulateWindowsTitleBar(page);
        await page.goto(`${url}?platform=${platform}`);
        const toggle = page.getByRole("button", {
          name: "Collapse sidebar",
          exact: true,
        });
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
        // The macOS app has no row of its own for the traffic lights: the
        // sidebar toggle sits in the window bar beside them, and the rail's
        // header starts with the brand. Elsewhere it stays in the header.
        const sidebarToggles = header.getByRole("button", { name: /sidebar$/ });
        if (platform === "macos") {
          expect(await sidebarToggles.count()).toBe(0);
          const box = (await toggle.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(MACOS_BAR_CONTROLS_LEFT);
          expect(box.y + box.height).toBeLessThanOrEqual(WINDOW_BAR_HEIGHT);
          expect(
            (await windowBarControls(page)).map(({ visible, buttons }) => ({
              visible,
              buttons,
            })),
          ).toEqual([{ visible: true, buttons: ["Collapse sidebar"] }]);
          // The bar comes first on screen and first in the tab order.
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          ).toBe("Collapse sidebar");
          await page.keyboard.press("Shift+Tab");
        } else {
          expect(await sidebarToggles.count()).toBe(1);
        }
        if (output)
          await page.screenshot({
            path: `${output}/${platform}-${width}-top.png`,
          });
        await viewport.evaluate((element) => {
          element.scrollTop = 240;
        });
        expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        // The header scrolls with the list and never reaches the window controls.
        expect((await header.boundingBox())!.y).toBeLessThan(before.y);
        await expectWindowTop(page, platform);
        if (output)
          await page.screenshot({
            path: `${output}/${platform}-${width}-scrolled.png`,
          });
        // Pointer collapse and keyboard expansion remain available after scrolling.
        await toggle.click();
        const expand = page.getByRole("button", {
          name: "Expand sidebar",
          exact: true,
        });
        const expandBox = (await expand.boundingBox())!;
        if (platform === "macos") {
          // The toggle stays put in the bar when the rail collapses.
          expect(expandBox.x).toBeGreaterThanOrEqual(MACOS_BAR_CONTROLS_LEFT);
          expect(expandBox.y + expandBox.height).toBeLessThanOrEqual(WINDOW_BAR_HEIGHT);
        } else {
          expect(expandBox.y).toBeGreaterThanOrEqual(top);
        }
        await expectWindowTop(page, platform);
        if (output)
          await page.screenshot({
            path: `${output}/${platform}-${width}-collapsed.png`,
          });
        await expand.focus();
        await page.keyboard.press("Enter");
        await toggle.waitFor();
        expect((await viewport.boundingBox())!.y).toBe(top);
        if (platform === "macos") {
          // The session page's workspace dock: below 1024px a full-window
          // overlay, mounted but hidden while closed. Closed, the toggle stays
          // in the bar; open, the overlay is the window's inset panel and the
          // toggle, with nothing to show or hide under it, steps aside.
          const shown = async () =>
            (await windowBarControls(page)).map((control) => control.visible);
          expect(await shown()).toEqual([true]);
          await page.getByRole("button", { name: "Open workspace", exact: true }).click();
          await page.getByRole("button", { name: "Close workspace", exact: true }).waitFor();
          if (width < 1024) {
            expect(await shown()).toEqual([false]);
            const overlay = (await page.locator("[data-workspace-surface]").boundingBox())!;
            expect(overlay).toEqual({
              x: 4,
              y: WINDOW_BAR_HEIGHT,
              width: width - 8,
              height: 420 - WINDOW_BAR_HEIGHT - 4,
            });
          } else {
            expect(await shown()).toEqual([true]);
          }
          await expectWindowTop(page, platform);
          await page.getByRole("button", { name: "Close workspace", exact: true }).click();
          await toggle.waitFor();
          expect(await shown()).toEqual([true]);
          await expectWindowTop(page, platform);
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  }
}, 180_000);

// A chat's page. In the macOS app the chat's header is the window bar's row:
// its title and actions sit right of the traffic lights and the sidebar
// toggle, never under them, its buttons take clicks, and the rounded panel
// starts under the bar as on every other page. Elsewhere the header stays the
// panel's first row, below any window bar.
test("a chat's header is the macOS window bar's row", async () => {
  const height = 420;
  for (const platform of ["macos", "windows", "browser"]) {
    for (const [width, rail] of [
      [1280, "open"],
      [1280, "collapsed"],
      [1280, "none"],
      [800, "collapsed"],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (platform === "windows") await simulateWindowsTitleBar(page);
      await page.goto(
        `${url}?platform=${platform}&view=chat${rail === "none" ? "&rail=none" : ""}`,
      );
      const header = page.locator("[data-titlebar]");
      await header.getByText("Ship the window bar").waitFor({ timeout: 90_000 });
      if (rail === "collapsed") {
        await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
      }
      const panel = page.locator("[data-canvas]");
      const check = async () => {
        const headerBox = (await header.boundingBox())!;
        const panelBox = (await panel.boundingBox())!;
        if (platform === "macos") {
          expect(headerBox.y).toBe(0);
          expect(headerBox.height).toBe(WINDOW_BAR_HEIGHT);
          // Beside the open rail the header starts at the panel's edge;
          // otherwise past the sidebar toggle. It ends where the panel ends.
          expect(headerBox.x).toBe(rail === "open" ? 288 : MACOS_BAR_ROW_LEFT);
          expect(headerBox.x + headerBox.width).toBe(width - 4);
          // The panel starts under the bar, as on every other page, and the
          // whole chat is in it.
          expect(panelBox.y).toBe(WINDOW_BAR_HEIGHT);
          expect(panelBox.y + panelBox.height).toBe(height - 4);
          expect(
            await panel.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
          ).toBe("10px");
          const row = (await windowBarRow(page))!;
          expect(row.buttons.map(({ label }) => label)).toContain("More session actions");
        } else {
          expect(headerBox.y).toBe(platform === "windows" ? WINDOW_BAR_HEIGHT : 0);
          // The header is the panel's first row.
          expect(panelBox.y).toBe(headerBox.y);
          expect(await windowBarRow(page)).not.toBeNull();
          expect(await header.evaluate((element) => getComputedStyle(element).position)).toBe(
            "static",
          );
        }
        await expectWindowTop(page, platform);
      };
      await check();
      if (output) {
        await page.screenshot({
          path: `${output}/chat-${platform}-${width}-${rail}.png`,
        });
      }
      // The header's own buttons work from the bar: the workspace opens and
      // closes from it.
      await header.getByRole("button", { name: "Open workspace", exact: true }).click();
      await page.getByRole("button", { name: "Close workspace", exact: true }).waitFor();
      await expectWindowTop(page, platform);
      await page.getByRole("button", { name: "Close workspace", exact: true }).click();
      await header.getByRole("button", { name: "Open workspace", exact: true }).waitFor();
      await check();
      if (rail === "collapsed") {
        // The toggle beside the header still takes clicks.
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        await page.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  }
}, 240_000);
