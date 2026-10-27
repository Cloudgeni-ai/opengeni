import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

import { expectWindowTop, simulateWindowsTitleBar, WINDOW_BAR_HEIGHT } from "./desktop-window-bar";

test("expanded Sites start below the desktop window bar", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = fileURLToPath(new URL("../../.agent/artifact-desktop/", import.meta.url));
  await mkdir(output, { recursive: true });
  const web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      ready: async () =>
        (await fetch(`${baseUrl}/test/artifact-desktop.html`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? chromium.executablePath(),
  });
  try {
    for (const platform of ["macos", "windows", "linux", "browser"] as const) {
      for (const width of [1000, 640]) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseUrl}/test/artifact-desktop.html`);
        await page
          .getByRole("button", { name: "Open Site full screen" })
          .waitFor({ timeout: 90_000 });
        await page.evaluate((hostPlatform) => {
          document.documentElement.classList.add("dark");
          if (hostPlatform !== "browser") document.documentElement.dataset.desktop = hostPlatform;
          if (hostPlatform === "windows") {
            // Chromium has no native Windows overlay: stand in for the 44px
            // title bar area the desktop shell asks for.
            document.documentElement.style.setProperty("--og-window-bar-height", "44px");
          }
        }, platform);
        const desktopBar = platform === "macos" || platform === "windows";
        await expectWindowTop(page, platform);
        const inlineHeight = await page
          .locator("dialog > div")
          .first()
          .evaluate((el) => el.getBoundingClientRect().height);
        expect(inlineHeight).toBe(48);
        const frame = page.frameLocator("iframe");
        // Establish live Site state before testing the host's navigation. An
        // early Chromium iframe pointer click can miss without dispatching the
        // fixture handler; that is not evidence of state lost on fullscreen exit.
        await frame.getByRole("button", { name: "Try the Site" }).press("Enter");
        await frame.getByRole("button", { name: "Site state preserved" }).waitFor();
        const originalIframe = await page.locator("iframe").elementHandle();
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(true);
        const back = page.getByRole("button", { name: "Back", exact: true });
        const bounds = await back.boundingBox();
        expect(bounds).not.toBeNull();
        // The full-window Site starts below the bar, with its usual header.
        expect(bounds!.x).toBeLessThan(30);
        const fullWindow = (await page.locator("[data-artifact-fullscreen]").boundingBox())!;
        expect(fullWindow.y).toBe(desktopBar ? WINDOW_BAR_HEIGHT : 0);
        expect(fullWindow.y + fullWindow.height).toBe(700);
        const header = page.locator("[data-artifact-fullscreen] > [data-window-drag]");
        expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(48);
        await expectWindowTop(page, platform);
        expect(
          await back.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region")),
        ).not.toBe("drag");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `${output}/${platform}-${width}.png` });
        // Pointer and keyboard both exit; neither remounts the live Site.
        await back.click();
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        await frame.getByRole("button", { name: "Site state preserved" }).waitFor();
        expect(
          await page.locator("iframe").evaluate((el, original) => el === original, originalIframe),
        ).toBe(true);
        expect(await page.locator("[data-window-drag]").count()).toBe(0);
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        await back.focus();
        await page.keyboard.press("Enter");
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        await page.keyboard.press("Escape");
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        await frame.getByRole("button", { name: "Site state preserved" }).waitFor();
        expect(
          await page.locator("iframe").evaluate((el, original) => el === original, originalIframe),
        ).toBe(true);
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 210_000);

// The desktop app can show a page its preload didn't reach, so the page has no
// bridge. The app's user agent still says it is the macOS app; without that,
// the page has no window bar and the full-window Site's Back sits under the
// traffic lights, where a click lands on the lights (green zooms the window)
// and there is no way back.
const MAC_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Opengeni/0.1.32 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36";
const MAC_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

test("the macOS app's full-window Site Back stays clickable without the shell bridge", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = fileURLToPath(new URL("../../.agent/artifact-desktop/", import.meta.url));
  await mkdir(output, { recursive: true });
  const web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      ready: async () =>
        (await fetch(`${baseUrl}/test/artifact-desktop.html`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? chromium.executablePath(),
  });
  try {
    for (const [label, userAgent] of [
      ["macos-app", MAC_DESKTOP_UA],
      ["mac-browser", MAC_BROWSER_UA],
    ] as const) {
      for (const theme of ["dark", "light"] as const) {
        const context = await browser.newContext({
          userAgent,
          viewport: { width: 1000, height: 700 },
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseUrl}/test/artifact-desktop.html`);
        await page
          .getByRole("button", { name: "Open Site full screen" })
          .waitFor({ timeout: 90_000 });
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle("dark", dark);
          document.documentElement.dataset.ogTheme = dark ? "dark" : "light";
        }, theme === "dark");
        expect(await page.evaluate(() => "opengeniDesktop" in window)).toBe(false);
        expect(await page.evaluate(() => document.documentElement.dataset.desktop ?? null)).toBe(
          label === "macos-app" ? "macos" : null,
        );
        // The account menu offers the desktop app download only outside it,
        // by the same decision as the layout.
        expect(
          await page.evaluate(() =>
            (
              window as unknown as { opengeniFixture: { offersDesktopDownload(): boolean } }
            ).opengeniFixture.offersDesktopDownload(),
          ),
        ).toBe(label !== "macos-app");
        await page.getByRole("button", { name: "Open Site full screen" }).click();
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(true);
        const back = page.getByRole("button", { name: "Back", exact: true });
        const bounds = (await back.boundingBox())!;
        const header = page.locator("[data-artifact-fullscreen] > [data-window-drag]");
        const headerHeight = await header.evaluate((el) => el.getBoundingClientRect().height);
        const fullWindow = (await page.locator("[data-artifact-fullscreen]").boundingBox())!;
        await page.screenshot({
          path: `${output}/no-bridge-${label}-${theme}.png`,
          clip: { x: 0, y: 0, width: 640, height: 120 },
        });
        // The full-window Site keeps its usual header and Back.
        expect(bounds.x).toBeLessThan(30);
        expect(headerHeight).toBe(48);
        if (label === "macos-app") {
          // It starts below the window bar, which holds the traffic lights
          // and the sharing badge, so nothing of it is under them.
          expect(fullWindow.y).toBe(WINDOW_BAR_HEIGHT);
          await expectWindowTop(page, "macos");
          expect(
            await back.evaluate((el) =>
              getComputedStyle(el).getPropertyValue("-webkit-app-region"),
            ),
          ).toBe("no-drag");
        } else {
          // A browser on a Mac keeps the web layout.
          expect(fullWindow.y).toBe(0);
          await expectWindowTop(page, "browser");
        }
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        expect(await page.locator("dialog").evaluate((el) => el.matches(":modal"))).toBe(false);
        if (label === "macos-app" && theme === "dark") {
          // A window the page opens (a sign-in or connect flow) has the system
          // title bar, so it keeps the web layout.
          const [popup] = await Promise.all([
            context.waitForEvent("page"),
            page.evaluate(() => void window.open("/test/artifact-desktop.html", "_blank")),
          ]);
          await popup
            .getByRole("button", { name: "Open Site full screen" })
            .waitFor({ timeout: 90_000 });
          expect(
            await popup.evaluate(() => document.documentElement.dataset.desktop ?? null),
          ).toBeNull();
          await popup.close();
          // So does one the app opens with no handle back (`openBlankTab`,
          // as checkout and GitHub settings do) once it reaches the app.
          const [blank] = await Promise.all([
            context.waitForEvent("page"),
            page.evaluate(() => {
              const tab = (
                window as unknown as { opengeniFixture: { openBlankTab(): Window | null } }
              ).opengeniFixture.openBlankTab();
              if (tab) tab.location.href = "/test/artifact-desktop.html";
            }),
          ]);
          await blank
            .getByRole("button", { name: "Open Site full screen" })
            .waitFor({ timeout: 90_000 });
          expect(await blank.evaluate(() => window.opener)).toBeNull();
          expect(
            await blank.evaluate(() => document.documentElement.dataset.desktop ?? null),
          ).toBeNull();
          await blank.close();
        }
        expect(errors).toEqual([]);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 210_000);

// The app's notices across the top of the page start below the desktop
// window bar, which holds the window controls.
test("app notices start below the desktop window bar", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      ready: async () =>
        (await fetch(`${baseUrl}/test/desktop-notices.html`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? chromium.executablePath(),
  });
  try {
    for (const platform of ["macos", "windows", "linux", "browser"] as const) {
      for (const width of [1000, 720]) {
        const page = await browser.newPage({ viewport: { width, height: 640 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        if (platform === "windows") await simulateWindowsTitleBar(page);
        const open = async (query: string) => {
          await page.goto(`${baseUrl}/test/desktop-notices.html?platform=${platform}${query}`);
          await page.getByText("Sample page").waitFor({ timeout: 90_000 });
        };
        const top = platform === "macos" || platform === "windows" ? WINDOW_BAR_HEIGHT : 0;

        // The update notice: one sentence and one action, the same in a tab and
        // in the app, at the top of the page.
        await open("");
        const notice = page.locator("#opengeni-api-update-notice");
        await notice.waitFor();
        expect(await notice.innerText()).not.toContain("tab");
        await notice.getByText("Opengeni updated.", { exact: true }).waitFor();
        const reload = notice.getByRole("button", { name: "Reload", exact: true });
        expect(await notice.getByRole("button").count()).toBe(1);
        const bar = (await notice.boundingBox())!;
        expect(bar).toMatchObject({ x: 0, y: top, width });
        expect(bar.height).toBeGreaterThanOrEqual(40);
        expect((await notice.getByText("Opengeni updated.").boundingBox())!.x).toBeLessThan(30);
        await expectWindowTop(page, platform);
        // The page below starts under the notice.
        expect((await page.locator("nav").boundingBox())!.y).toBeGreaterThanOrEqual(
          bar.y + bar.height,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await Promise.all([page.waitForEvent("load"), reload.click()]);

        // Other notices above every page, and a page banner beside a
        // collapsed rail, keep clear too.
        await open("&update=0&signin");
        const signIn = page.locator("[data-app-notice] [data-slot='notice']");
        await signIn.getByText("Google is now connected").waitFor();
        const signInBox = (await signIn.boundingBox())!;
        expect(signInBox.y).toBeGreaterThanOrEqual(top);
        // Centred as in a browser.
        if (width === 1000) {
          expect(Math.abs(signInBox.x - ((width - 768) / 2 + 16))).toBeLessThanOrEqual(1);
        }
        await expectWindowTop(page, platform);
        await open("&update=0&paused");
        const banner = page.locator("[data-canvas] > [data-slot='notice']");
        await banner.getByText("Agent work is paused").waitFor();
        expect((await banner.boundingBox())!.y).toBe(top);
        await expectWindowTop(page, platform);
        // Beside the open rail the banner keeps its usual spacing.
        await open("&update=0&paused&rail=open");
        expect((await banner.getByText("Agent work is paused").boundingBox())!.x).toBeLessThan(
          240 + 60,
        );
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await web.stop();
  }
}, 210_000);
