// Run from apps/web with its focused Vite config serving this production-component fixture:
// bun run vite --config test/composer-keyboard.vite.config.ts --host 127.0.0.1 --port 4321
// bun test/composer-keyboard-browser-check.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page, type Locator } from "playwright";

const base =
  process.env.COMPOSER_KEYBOARD_URL ?? "http://127.0.0.1:4321/test/composer-keyboard.html";
const out =
  process.env.COMPOSER_KEYBOARD_EVIDENCE ?? `${import.meta.dirname}/composer-keyboard-evidence`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox"],
});
async function focused(target: Locator) {
  await target.evaluate((node) => {
    if (document.activeElement !== node)
      throw new Error(
        `Focus is on ${document.activeElement?.outerHTML}, expected ${node.outerHTML}`,
      );
  });
}
async function press(page: Page, key: string) {
  await page.keyboard.press(key);
  // Radix defers roving focus by one task.
  await page.waitForTimeout(30);
}
const results: unknown[] = [];
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      for (const chat of ["existing", "new"])
        for (const presentation of ["menu", "dialog"]) {
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
          await page.route("**/*", (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await page.goto(`${base}?chat=${chat}&theme=${theme}&presentation=${presentation}`);
          await page.evaluate(() => document.fonts.ready);
          const trigger = page.getByRole("button", { name: "More composer actions" });
          await trigger.waitFor();
          // Keyboard-only entry from the real composer trigger; no script focus of menu choices.
          await trigger.focus();
          await press(page, "Enter");
          const runsOn = page.getByRole("menuitem", { name: /Runs on/ });
          await runsOn.waitFor();
          await press(page, "Home");
          // Connectors precedes Runs on in the production + panel.
          for (let step = 0; step < 5; step++) {
            if (await runsOn.evaluate((node) => document.activeElement === node)) break;
            await press(page, "ArrowDown");
            assert(await page.getByRole("menu").count(), "Composer menu closed during entry");
          }
          await focused(runsOn);
          await press(page, "Enter");
          const role = presentation === "menu" ? "menuitemradio" : "radio";
          const surface = page.getByRole(presentation === "menu" ? "menu" : "dialog");
          await surface.waitFor();
          const screenshot = async () => {
            const box = (await surface.boundingBox())!;
            const y = Math.max(0, box.y - 24);
            await page.screenshot({
              path: `${out}/${width}-${theme}-${chat}-${presentation}.png`,
              clip: {
                x: Math.max(0, width / 2 - 408),
                y,
                width: Math.min(width, 816),
                height: 800 - y,
              },
            });
          };
          const moveTo = async (target: Locator) => {
            // Dialogs start on Back, menus start on the checked enabled radio.
            for (let step = 0; step < 8; step++) {
              if (await target.evaluate((node) => document.activeElement === node)) return;
              await press(page, presentation === "menu" ? "ArrowDown" : "Tab");
            }
            await focused(target);
          };
          if (chat === "existing") {
            const build = page.getByRole(role, { name: "Build machine", exact: true });
            if (presentation === "menu")
              await focused(page.getByRole(role, { name: "Cloud sandbox", exact: true }));
            await moveTo(build);
            await press(page, "Enter");
            assert.equal(await build.getAttribute("aria-checked"), "true");
            await focused(build);
            assert.equal(await surface.count(), 1);
            assert.deepEqual(
              await page.evaluate(() => (window as any).composerKeyboard.attachments),
              ["build"],
            );
            await screenshot();
            await moveTo(page.getByRole(role, { name: /Headless machine/ }));
            await press(page, "Space");
            assert.deepEqual(
              await page.evaluate(() => (window as any).composerKeyboard.attachments),
              ["build", "headless"],
            );
          } else {
            const custom = page.getByRole(role, { name: "Custom path", exact: true });
            await moveTo(custom);
            await press(page, "Enter");
            const input = page.getByRole("textbox", { name: "Custom working directory" });
            await focused(input);
            await page.keyboard.type("/home/me/my project");
            assert.equal(await input.inputValue(), "/home/me/my project");
            await press(page, "Home");
            await press(page, "ArrowRight");
            assert.equal(await input.evaluate((node: HTMLInputElement) => node.selectionStart), 1);
            await focused(input);
            await screenshot();
            if (presentation === "menu") {
              for (const key of ["Tab", "Shift+Tab", "Enter"]) {
                await press(page, key);
                await focused(custom);
                assert.equal(await surface.count(), 1);
                await press(page, "Enter");
                await focused(input);
                assert.equal(await input.inputValue(), "/home/me/my project");
              }
              await press(page, "Tab");
              await press(page, "ArrowUp");
            } else {
              await press(page, "Shift+Tab");
              await focused(custom);
              await press(page, "Shift+Tab");
            }
            await focused(page.getByRole(role, { name: /Machine root/ }));
            await press(page, "Enter");
            assert.equal(await input.count(), 0);
            assert.equal(await surface.count(), 1);
          }
          await press(page, "Escape");
          assert.equal(await surface.count(), 0);
          await focused(trigger);
          assert.equal(await page.evaluate(() => (window as any).composerKeyboard.sends), 0);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          assert.deepEqual(errors, []);
          results.push({ width, theme, chat, presentation, passed: true });
          await page.close();
        }
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, out }));
} finally {
  await browser.close();
}
