import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

import {
  expectWindowTop,
  LEGACY_MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_POSITION,
  MACOS_BAR_CONTROLS_LEFT,
  MACOS_BAR_ROW_LEFT,
  simulateWindowsTitleBar,
  trafficLightCentre,
  WINDOW_BAR_HEIGHT,
  windowBar,
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
      // Below 1024px the open workspace fills the window: on macOS the header
      // steps out of the bar under it (expectWindowTop checks it is hidden
      // and takes no clicks).
      if (platform === "macos") expect((await windowBarRow(page))!.layerOpen).toBe(width < 1024);
      await expectWindowTop(page, platform);
      if (width >= 1024) {
        // So does the maximized workspace.
        await page.getByRole("button", { name: "Maximize dock", exact: true }).click();
        await page.getByRole("button", { name: "Restore dock", exact: true }).waitFor();
        if (platform === "macos") expect((await windowBarRow(page))!.layerOpen).toBe(true);
        await expectWindowTop(page, platform);
        await page.getByRole("button", { name: "Restore dock", exact: true }).click();
        await page.getByRole("button", { name: "Maximize dock", exact: true }).waitFor();
        await expectWindowTop(page, platform);
      }
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

test("the macOS sidebar toggle is centred on the traffic lights", async () => {
  // The shell reports its bar (`?bar=`) and zoom (`?zoom=`); a shell that
  // doesn't (0.1.33 and older) has the lights lower, on its old 56px row.
  // Page pixels times the zoom are window points, where the lights are.
  const shells = [
    { bar: "44", zoom: 1, lights: MAC_TRAFFIC_LIGHT_POSITION },
    { bar: "44", zoom: 1.25, lights: MAC_TRAFFIC_LIGHT_POSITION },
    { bar: "44", zoom: 0.8, lights: MAC_TRAFFIC_LIGHT_POSITION },
    { bar: "none", zoom: 1, lights: LEGACY_MAC_TRAFFIC_LIGHT_POSITION },
  ];
  const layouts = [
    { width: 1280, view: "rail", rail: "open" },
    { width: 1280, view: "rail", rail: "collapsed" },
    { width: 800, view: "rail", rail: "collapsed" },
    { width: 1280, view: "chat", rail: "open" },
    { width: 1280, view: "chat", rail: "none" },
    { width: 800, view: "chat", rail: "collapsed" },
  ] as const;
  for (const { bar, zoom, lights } of shells) {
    const centre = trafficLightCentre(lights);
    for (const { width, view, rail } of layouts) {
      const page = await browser.newPage({ viewport: { width, height: 420 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `${url}?platform=macos&bar=${bar}&zoom=${zoom}${view === "chat" ? "&view=chat" : ""}${rail === "none" ? "&rail=none" : ""}`,
      );
      const where = `bar=${bar} zoom=${zoom} ${view} ${rail} ${width}px`;
      // The bar is the lights' row: centred on them, top to bottom.
      const ready =
        view === "chat"
          ? page.locator("[data-titlebar]").getByText("Ship the window bar")
          : page.locator("[data-session-row]").first();
      await ready.waitFor({ timeout: 90_000 });
      expect((await windowBar(page))!.height * zoom, where).toBeCloseTo(centre * 2, 1);
      // With no rail there is no sidebar toggle; the chat's header has the line.
      let toggleRight = 0;
      if (rail !== "none") {
        const collapse = page.getByRole("button", { name: "Collapse sidebar", exact: true });
        await collapse.waitFor();
        if (rail === "collapsed") await collapse.click();
        const toggle = page.getByRole("button", {
          name: rail === "collapsed" ? "Expand sidebar" : "Collapse sidebar",
          exact: true,
        });
        await toggle.waitFor();
        const box = (await toggle.boundingBox())!;
        const toggleCentre = (box.y + box.height / 2) * zoom;
        expect(Math.abs(toggleCentre - centre), where).toBeLessThanOrEqual(0.5);
        // Clear of the traffic lights and the sharing badge at any zoom.
        expect(box.x * zoom, where).toBeCloseTo(MACOS_BAR_CONTROLS_LEFT, 1);
        toggleRight = box.x + box.width;
      }
      if (view === "chat") {
        // The chat's header shares the line, after the toggle.
        const row = (await windowBarRow(page))!;
        expect(row.left, where).toBeGreaterThanOrEqual(toggleRight);
        const actions = row.buttons.find(({ label }) => label === "More session actions")!;
        expect(
          Math.abs(((actions.top + actions.bottom) / 2) * zoom - centre),
          where,
        ).toBeLessThanOrEqual(0.5);
        expect(actions.clickable, where).toBe(true);
      }
      if (output) {
        await page.screenshot({
          path: `${output}/centre-${bar}-${zoom}-${view}-${rail}-${width}.png`,
          clip: { x: 0, y: 0, width: 400, height: 80 },
        });
      }
      expect(errors, where).toEqual([]);
      await page.close();
    }
  }
}, 240_000);
