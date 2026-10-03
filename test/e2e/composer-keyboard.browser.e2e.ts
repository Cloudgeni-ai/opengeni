import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Locator, type Page } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const screenshots = process.env.COMPOSER_KEYBOARD_EVIDENCE;
type Case = {
  width: number;
  theme: string;
  chat: string;
  presentation: string;
};
const results: Array<Case & { passed: true }> = [];

async function focused(target: Locator) {
  // Radix defers roving focus. Observe the exact destination before another key.
  await target.and(target.page().locator(":focus")).waitFor();
}

async function pressAndFocus(page: Page, key: string, target: Locator) {
  await page.keyboard.press(key);
  await focused(target);
}

async function evidence(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { composerKeyboard: { attachments: string[]; sends: number } })
        .composerKeyboard,
  );
}

describe("production composer machine and path keyboard navigation", () => {
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
    if (screenshots)
      await writeFile(`${screenshots}/results.json`, JSON.stringify(results, null, 2));
  });

  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      for (const chat of ["existing", "new"])
        for (const presentation of ["menu", "dialog"])
          test(`${chat} chat, ${presentation}, ${width}px, ${theme}`, async () => {
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
              await page.goto(`${url}?chat=${chat}&theme=${theme}&presentation=${presentation}`);
              await page.evaluate(() => document.fonts.ready);
              const trigger = page.getByRole("button", { name: "More composer actions" });
              await trigger.waitFor();
              // Keyboard entry uses the real composer trigger and full drill-in shell.
              // No menu choice receives script focus.
              await trigger.focus();
              await page.keyboard.press("Enter");
              const runsOn = page.getByRole("menuitem", { name: /Runs on/ });
              await runsOn.waitFor();
              await pressAndFocus(
                page,
                "Home",
                page.getByRole("menuitem", { name: "Connectors", exact: true }),
              );
              await pressAndFocus(page, "ArrowDown", runsOn);
              expect(await page.getByRole("menu").count()).toBe(1);
              await page.keyboard.press("Enter");
              const role = presentation === "menu" ? "menuitemradio" : "radio";
              const surface = page.getByRole(presentation === "menu" ? "menu" : "dialog");
              await surface.waitFor();
              const radio = (name: string | RegExp) =>
                page.getByRole(role, { name, exact: typeof name === "string" });
              const nextKey = presentation === "menu" ? "ArrowDown" : "Tab";
              if (presentation === "dialog") {
                await focused(surface.getByRole("button", { name: "Back", exact: true }));
                await pressAndFocus(
                  page,
                  "Tab",
                  radio(chat === "existing" ? "Cloud sandbox" : /Managed sandbox/),
                );
              }
              const capture = async () => {
                if (!screenshots) return;
                const box = (await surface.boundingBox())!;
                const y = Math.max(0, box.y - 24);
                await page.screenshot({
                  path: `${screenshots}/${width}-${theme}-${chat}-${presentation}.png`,
                  clip: {
                    x: Math.max(0, width / 2 - 408),
                    y,
                    width: Math.min(width, 816),
                    height: 800 - y,
                  },
                });
              };
              if (chat === "existing") {
                await focused(radio("Cloud sandbox"));
                const build = radio("Build machine");
                // One step must skip the offline machine, without an extra key hiding a failure.
                await pressAndFocus(page, nextKey, build);
                await page.keyboard.press("Enter");
                await build.and(page.locator('[aria-checked="true"]')).waitFor();
                expect(await build.getAttribute("aria-checked")).toBe("true");
                await focused(build);
                expect(await surface.count()).toBe(1);
                expect((await evidence(page)).attachments).toEqual(["build"]);
                await capture();
                await pressAndFocus(page, nextKey, radio(/Headless machine/));
                await page.keyboard.press("Space");
                await radio(/Headless machine/)
                  .and(page.locator('[aria-checked="true"]'))
                  .waitFor();
                expect((await evidence(page)).attachments).toEqual(["build", "headless"]);
              } else {
                const build = radio(/Build machine/);
                if (presentation === "dialog") await pressAndFocus(page, "Tab", build);
                else await focused(build);
                await pressAndFocus(page, nextKey, radio(/Headless machine/));
                await pressAndFocus(page, nextKey, radio(/Machine root/));
                const custom = radio("Custom path");
                await pressAndFocus(page, nextKey, custom);
                const input = page.getByRole("textbox", { name: "Custom working directory" });
                await pressAndFocus(page, "Enter", input);
                await page.keyboard.type("/home/me/my project");
                expect(await input.inputValue()).toBe("/home/me/my project");
                await page.keyboard.press("Home");
                await page.keyboard.press("ArrowRight");
                expect(await input.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(
                  1,
                );
                await focused(input);
                await capture();
                if (presentation === "menu") {
                  for (const key of ["Tab", "Shift+Tab", "Enter"]) {
                    await pressAndFocus(page, key, custom);
                    expect(await surface.count()).toBe(1);
                    await pressAndFocus(page, "Enter", input);
                    expect(await input.inputValue()).toBe("/home/me/my project");
                  }
                  await pressAndFocus(page, "Tab", custom);
                  await pressAndFocus(page, "ArrowUp", radio(/Machine root/));
                } else {
                  await pressAndFocus(page, "Shift+Tab", custom);
                  await pressAndFocus(page, "Shift+Tab", radio(/Machine root/));
                }
                await page.keyboard.press("Enter");
                await input.waitFor({ state: "hidden" });
                expect(await input.count()).toBe(0);
                expect(await surface.count()).toBe(1);
              }
              await page.keyboard.press("Escape");
              await surface.waitFor({ state: "hidden" });
              expect(await surface.count()).toBe(0);
              await focused(trigger);
              expect((await evidence(page)).sends).toBe(0);
              expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              ).toBe(true);
              expect(errors).toEqual([]);
              results.push({ width, theme, chat, presentation, passed: true });
            } finally {
              await page.close();
            }
          }, 30_000);
});
