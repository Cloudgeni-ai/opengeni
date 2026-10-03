import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Locator } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const screenshots = process.env.COMPOSER_FOCUS_EVIDENCE;
type PendingFocus = { capture: boolean; callbacks: Array<() => void> };

async function focused(target: Locator) {
  await target.and(target.page().locator(":focus")).waitFor();
}

describe("production composer menu-to-dialog focus ownership", () => {
  let browser: Browser;
  let web: StartedProcess;
  let url: string;

  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/test/composer-keyboard.html`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--config",
        "test/composer-keyboard.vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${root}/apps/web`,
        ready: async () => (await fetch(url).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
        (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
    });
    if (screenshots) await mkdir(screenshots, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  for (const { width, theme } of [
    { width: 390, theme: "light" },
    { width: 1280, theme: "dark" },
  ])
    test(`pending menu autofocus cannot select a typed path: ${width}px, ${theme}`, async () => {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width < 600,
        reducedMotion: "reduce",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      try {
        await page.route("**/*", (route) =>
          new URL(route.request().url()).origin === new URL(url).origin
            ? route.continue()
            : route.abort(),
        );
        await page.goto(`${url}?chat=new&theme=${theme}&presentation=dialog`);
        await page.evaluate(() => document.fonts.ready);
        const trigger = page.getByRole("button", { name: "More composer actions" });
        await trigger.focus();
        await page.keyboard.press("Enter");
        const runsOn = page.getByRole("menuitem", { name: /Runs on/ });
        await runsOn.waitFor();
        await page.keyboard.press("Home");
        await focused(page.getByRole("menuitem", { name: "Connectors", exact: true }));
        await page.keyboard.press("ArrowDown");
        await focused(runsOn);

        // Change only scheduling: retain the actual Radix FocusScope cleanup
        // callback, not a synthetic focus event or a replacement input value.
        await page.evaluate(() => {
          const pending: PendingFocus = { capture: true, callbacks: [] };
          Object.assign(window, { composerPendingFocus: pending });
          const originalTimeout = window.setTimeout.bind(window);
          window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
            if (
              pending.capture &&
              delay === 0 &&
              typeof callback === "function" &&
              callback.toString().includes("AUTOFOCUS_ON_UNMOUNT")
            ) {
              return originalTimeout(() => pending.callbacks.push(() => callback(...args)), 0);
            }
            return originalTimeout(callback, delay, ...args);
          }) as typeof window.setTimeout;
        });
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await focused(dialog.getByRole("button", { name: "Back", exact: true }));
        for (const name of [
          /Managed sandbox/,
          /Build machine/,
          /Headless machine/,
          /Machine root/,
          "Custom path",
        ]) {
          await page.keyboard.press("Tab");
          await focused(page.getByRole("radio", { name, exact: typeof name === "string" }));
        }
        const input = page.getByRole("textbox", { name: "Custom working directory" });
        await page.keyboard.press("Enter");
        await focused(input);
        await page.keyboard.type("/home/");
        expect(await input.inputValue()).toBe("/home/");
        await page.waitForFunction(
          () =>
            (window as typeof window & { composerPendingFocus: PendingFocus }).composerPendingFocus
              .callbacks.length > 0,
        );
        const released = await page.evaluate(() => {
          const pending = (window as typeof window & { composerPendingFocus: PendingFocus })
            .composerPendingFocus;
          pending.capture = false;
          const callbacks = pending.callbacks.splice(0);
          for (const callback of callbacks) callback();
          return callbacks.length;
        });
        expect(released).toBe(1);
        await page.keyboard.type("me/my project");
        expect(await input.inputValue()).toBe("/home/me/my project");
        await focused(input);
        expect(await input.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(19);
        expect(await input.evaluate((node: HTMLInputElement) => node.selectionEnd)).toBe(19);
        if (screenshots)
          await page.screenshot({ path: `${screenshots}/${width}-${theme}-dialog-path.png` });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await focused(trigger);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
});
