import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

test("expanded Sites keep desktop navigation clear of native controls", async () => {
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
            // Chromium has no native Windows overlay. Supply the same CSS
            // environment-derived values the Electron host exposes.
            document.documentElement.style.setProperty("--og-caption-buttons-width", "138px");
            document.documentElement.style.setProperty("--og-caption-row-height", "56px");
          }
        }, platform);
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
        if (platform === "macos") expect(bounds!.x).toBeGreaterThanOrEqual(84);
        else expect(bounds!.x).toBeLessThan(30);
        const header = page.locator("[data-artifact-fullscreen] > [data-window-drag]");
        expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(
          platform === "macos" || platform === "windows" ? 56 : 48,
        );
        expect(
          await back.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region")),
        ).not.toBe("drag");
        if (platform === "windows") {
          const reload = await page.getByRole("button", { name: "Reload Site" }).boundingBox();
          expect(reload!.x + reload!.width).toBeLessThanOrEqual(width - 138);
        }
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

// The app's notices across the top of the window sit where the desktop app
// draws its window controls. macOS: the traffic lights end about 72px in,
// and the purple badge macOS swaps in while the window is shared ends about
// 80px in, both within the top 44px. Windows: the caption buttons fill the
// top-right corner (138px by 56px here).
test("app notices keep clear of the desktop window controls", async () => {
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
  const controls = { macos: { right: 84, bottom: 44 }, windows: { width: 138, height: 56 } };
  try {
    for (const platform of ["macos", "windows", "linux", "browser"] as const) {
      for (const width of [1000, 720]) {
        const page = await browser.newPage({ viewport: { width, height: 640 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const open = async (query: string) => {
          await page.goto(`${baseUrl}/test/desktop-notices.html?platform=${platform}${query}`);
          await page.getByText("Sample page").waitFor({ timeout: 90_000 });
        };
        /** Fails if a box reaches into the corner the platform's window controls fill. */
        const clear = (box: { x: number; y: number; width: number; height: number }) => {
          if (platform === "macos") {
            expect(box.y >= controls.macos.bottom || box.x >= controls.macos.right).toBe(true);
          } else if (platform === "windows") {
            expect(
              box.y >= controls.windows.height ||
                box.x + box.width <= width - controls.windows.width,
            ).toBe(true);
          }
        };
        const desktopTitleBar = platform === "macos" || platform === "windows";

        // The update notice: one sentence and one action, the same in a tab and
        // in the app, and the window's top row on the desktop.
        await open("");
        const notice = page.locator("#opengeni-api-update-notice");
        await notice.waitFor();
        expect(await notice.innerText()).not.toContain("tab");
        await notice.getByText("Opengeni updated.", { exact: true }).waitFor();
        const reload = notice.getByRole("button", { name: "Reload", exact: true });
        expect(await notice.getByRole("button").count()).toBe(1);
        const bar = (await notice.boundingBox())!;
        expect(bar.x).toBe(0);
        expect(bar.width).toBe(width);
        expect(bar.height).toBeGreaterThanOrEqual(desktopTitleBar ? 56 : 40);
        const message = (await notice.getByText("Opengeni updated.").boundingBox())!;
        const button = (await reload.boundingBox())!;
        clear(message);
        clear(button);
        if (platform === "browser" || platform === "linux") expect(message.x).toBeLessThan(30);
        if (desktopTitleBar) {
          // Centred on the title row, like the window controls.
          expect(Math.abs(message.y + message.height / 2 - 28)).toBeLessThanOrEqual(2);
          expect(
            await notice.evaluate((el) =>
              getComputedStyle(el).getPropertyValue("-webkit-app-region"),
            ),
          ).toBe("drag");
          expect(
            await reload.evaluate((el) =>
              getComputedStyle(el).getPropertyValue("-webkit-app-region"),
            ),
          ).toBe("no-drag");
        }
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
        clear((await signIn.boundingBox())!);
        await open("&update=0&paused");
        const banner = page.locator("[data-canvas] > [data-slot='notice']");
        await banner.getByText("Agent work is paused").waitFor();
        for (const part of [
          banner.locator("svg").first(),
          banner.getByText("Agent work is paused"),
          banner.getByRole("button", { name: "Resume" }),
        ])
          clear((await part.boundingBox())!);
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
