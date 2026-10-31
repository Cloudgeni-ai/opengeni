import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";

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
} from "./desktop-window-bar";

const PLATFORMS = ["browser", "windows", "macos"] as const;
type Platform = (typeof PLATFORMS)[number];

/** Where the page starts: below the window bar on macOS and Windows. */
const pageTop = (platform: Platform) => (platform === "browser" ? 0 : WINDOW_BAR_HEIGHT);

describe("the desktop window bar", () => {
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

  async function open(platform: Platform, query: string, width: number, height: number) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (platform === "windows") await simulateWindowsTitleBar(page);
    await page.goto(`${url}?platform=${platform}${query}`);
    return { page, errors };
  }

  const setScroll = (page: Page, selector: string, top: "end" | number) =>
    page.locator(selector).evaluate((element, to) => {
      element.scrollTop = to === "end" ? element.scrollHeight : to;
      return element.scrollTop;
    }, top);

  test("Settings starts below the bar, at rest and scrolled", async () => {
    const backTop = new Map<Platform, number>();
    for (const platform of PLATFORMS) {
      const { page, errors } = await open(platform, "", 1280, 420);
      const rail = page.locator("[data-settings-rail]");
      const back = rail.getByRole("link", { name: "Back to sessions" });
      await back.waitFor({ timeout: 90_000 });
      // One rail layout everywhere: the brand row, then the back link.
      expect(await rail.getByRole("link", { name: "Opengeni home" }).count()).toBe(1);
      expect((await rail.boundingBox())!.y).toBe(pageTop(platform));
      backTop.set(platform, (await back.boundingBox())!.y - pageTop(platform));
      await expectWindowTop(page, platform);
      // Scrolled part-way and to the end, the list never reaches the window controls.
      expect(await setScroll(page, "[data-settings-rail]", 72)).toBeGreaterThan(0);
      await expectWindowTop(page, platform);
      await setScroll(page, "[data-settings-rail]", "end");
      await expectWindowTop(page, platform);
      expect(errors).toEqual([]);
      await page.close();
    }
    // The rail's own layout is the same on every platform.
    expect(new Set(backTop.values()).size).toBe(1);
  }, 180_000);

  test("content pages start below the bar beside the open and collapsed rail", async () => {
    const title = new Map<string, { x: number; y: number }>();
    const description = new Map<string, { x: number; y: number }>();
    for (const platform of PLATFORMS) {
      for (const width of [720, 900, 1280]) {
        const { page, errors } = await open(platform, "&view=content", width, 600);
        const heading = page.getByRole("heading", { name: "Automations", exact: true });
        await heading.waitFor({ timeout: 90_000 });
        const intro = page.locator("[data-slot=page-header-description]");
        for (const rail of ["expanded", "collapsed"]) {
          if (rail === "collapsed") {
            await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
            await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
          }
          // In the macOS app the title is in the window bar (see below).
          if (platform !== "macos") {
            const box = (await heading.boundingBox())!;
            title.set(`${platform}-${width}-${rail}`, { x: box.x, y: box.y - pageTop(platform) });
          }
          const line = (await intro.boundingBox())!;
          description.set(`${platform}-${width}-${rail}`, { x: line.x, y: line.y });
          await expectWindowTop(page, platform);
          // In the macOS app the page is an inset, rounded panel on the
          // window's material, flush with the rail and 4px in from the
          // window's right and bottom edges, like native Mac apps.
          const canvas = page.locator("[data-canvas]");
          const panel = await canvas.evaluate((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const nav = element.previousElementSibling!.getBoundingClientRect();
            return {
              radius: style.borderTopLeftRadius,
              border: style.borderTopWidth,
              gapLeft: rect.left - nav.right,
              gapRight: innerWidth - rect.right,
              gapBottom: innerHeight - rect.bottom,
              top: rect.top,
            };
          });
          expect(panel).toEqual(
            platform === "macos"
              ? {
                  radius: "10px",
                  border: "1px",
                  gapLeft: 0,
                  gapRight: 4,
                  gapBottom: 4,
                  top: WINDOW_BAR_HEIGHT,
                }
              : {
                  radius: "0px",
                  border: "0px",
                  gapLeft: 0,
                  gapRight: 0,
                  gapBottom: 0,
                  top: pageTop(platform),
                },
          );
          // The collapsed rail stays 56px wide on every platform.
          if (rail === "collapsed") {
            expect((await page.locator("nav[data-collapsed='true']").boundingBox())!.width).toBe(
              56,
            );
          }
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
    // Below the bar the layout is the web app's own: same places on Windows,
    // and on macOS the same across within the panel's 1px border and its 4px
    // inset (a centred column moves by half of it, plus the border), with the
    // title in the bar instead of above the description.
    for (const [key, box] of title) {
      if (!key.startsWith("browser-")) continue;
      expect({ key, ...title.get(key.replace("browser", "windows"))! }).toEqual({ key, ...box });
      const web = description.get(key)!;
      const mac = description.get(key.replace("browser", "macos"))!;
      expect({ key, near: Math.abs(mac.x - box.x) <= 3 }).toEqual({ key, near: true });
      expect({ key, near: Math.abs(mac.x - web.x) <= 3 }).toEqual({ key, near: true });
    }
    // And the web app is unchanged: 24px past the rail below 1024px, then the
    // centred column with its 32px inset.
    expect(title.get("browser-900-collapsed")!.x).toBe(80);
    expect(title.get("browser-900-expanded")!.x).toBe(312);
    expect(title.get("browser-1280-collapsed")!.x).toBe(188);
    expect(title.get("browser-1280-expanded")!.x).toBe(320);
  }, 240_000);

  test("menus open next to their buttons below the bar", async () => {
    const offsets = new Map<Platform, number[]>();
    for (const platform of PLATFORMS) {
      const { page, errors } = await open(platform, "&view=content", 1100, 640);
      await page.getByRole("heading", { name: "Automations", exact: true }).waitFor({
        timeout: 90_000,
      });
      const found: number[] = [];
      for (const name of [/^Account menu/, /^Session view/, /^Actions for Website redesign/]) {
        const trigger = page.getByRole("button", { name });
        const button = (await trigger.boundingBox())!;
        await trigger.click();
        const menu = page.getByRole("menu").first();
        await menu.waitFor();
        // Let the opening animation settle.
        await page.waitForTimeout(300);
        const box = (await menu.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(pageTop(platform));
        // Where a menu reaches over the bar in a short window, it stays clickable.
        if (platform !== "browser") {
          expect(
            await menu.evaluate((element) =>
              getComputedStyle(
                element.closest("[data-radix-popper-content-wrapper]")!,
              ).getPropertyValue("-webkit-app-region"),
            ),
          ).toBe("no-drag");
        }
        // The menu's start and its gap to the button's near edge (the account
        // menu lists fewer items in the desktop app, so compare edges, not tops).
        const below = box.y >= button.y + button.height / 2;
        found.push(
          Math.round(box.x - button.x),
          Math.round(below ? box.y - (button.y + button.height) : button.y - (box.y + box.height)),
        );
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
      }
      offsets.set(platform, found);
      expect(errors).toEqual([]);
      await page.close();
    }
    // A menu sits in the same place relative to its button as in the web app.
    expect(offsets.get("windows")).toEqual(offsets.get("browser")!);
    expect(offsets.get("macos")).toEqual(offsets.get("browser")!);
  }, 180_000);

  test("every macOS page has the same window bar as a chat", async () => {
    // A chat's bar (desktop-rail.browser.e2e.ts): the sidebar toggle 84
    // window points from the left and the page's title line from the
    // canvas's left edge (never before 120), both centred on the traffic
    // lights, in a bar of the same height, with the title shown once. Here
    // the settings shell (also without the app's rail, as personal settings),
    // a list page, a form page and a detail page, with the current shell and
    // one that doesn't report its bar (0.1.33 and older), open and collapsed.
    const views = [
      { view: "", title: "General" },
      { view: "&apprail=none", title: "General" },
      { view: "&view=content", title: "Automations" },
      { view: "&view=content&page=form", title: "New automation" },
      { view: "&view=content&page=detail", title: "Nightly report" },
    ];
    const shells = [
      { bar: "44", lights: MAC_TRAFFIC_LIGHT_POSITION },
      { bar: "none", lights: LEGACY_MAC_TRAFFIC_LIGHT_POSITION },
    ];
    for (const { bar, lights } of shells) {
      const centre = trafficLightCentre(lights);
      for (const { view, title } of views) {
        const { page, errors } = await open("macos", `${view}&bar=${bar}`, 1280, 600);
        for (const rail of ["open", "collapsed"]) {
          const where = `${view || "settings"} bar=${bar} ${rail}`;
          if (rail === "collapsed") {
            await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
          }
          const toggle = page.getByRole("button", {
            name: rail === "collapsed" ? "Expand sidebar" : "Collapse sidebar",
            exact: true,
          });
          await toggle.waitFor({ timeout: 90_000 });
          const toggleBox = (await toggle.boundingBox())!;
          expect(toggleBox.x, where).toBe(MACOS_BAR_CONTROLS_LEFT);
          expect(Math.abs(toggleBox.y + toggleBox.height / 2 - centre), where).toBeLessThanOrEqual(
            0.5,
          );
          expect((await windowBar(page))!.height, where).toBe(centre * 2);
          // The row follows the canvas's edge from a ResizeObserver, which
          // runs before the next paint: let that frame happen first.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          // The page's title line is the bar's row, as a chat's header is.
          const row = await page.evaluate(() => {
            const rows = [
              ...document.querySelectorAll<HTMLElement>("[data-window-bar-row] > [data-titlebar]"),
            ];
            const header = rows[0];
            const canvas = header?.parentElement;
            if (!header || !canvas) return { count: rows.length };
            const text = header.querySelector("span")!.getBoundingClientRect();
            const box = header.getBoundingClientRect();
            return {
              count: rows.length,
              text: header.textContent,
              left: box.left,
              canvasLeft: canvas.getBoundingClientRect().left,
              textCentre: text.top + text.height / 2,
              drag: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
            };
          });
          expect(row.count, where).toBe(1);
          expect(row.text, where).toBe(title);
          expect(row.left, where).toBe(Math.max(row.canvasLeft!, MACOS_BAR_ROW_LEFT));
          expect(Math.abs(row.textCentre! - centre), where).toBeLessThanOrEqual(0.5);
          expect(row.drag, where).toBe("drag");
          // Shown once: the page's own heading stays for assistive tech only.
          const heading = page.getByRole("heading", { name: title, exact: true });
          expect(await heading.count(), where).toBe(1);
          expect((await heading.boundingBox())!.width, where).toBeLessThanOrEqual(1);
          if (bar === "44") await expectWindowTop(page, "macos");
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  }, 420_000);
});
