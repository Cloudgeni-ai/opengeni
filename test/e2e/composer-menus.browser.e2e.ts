import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const root = new URL("../..", import.meta.url).pathname;
describe("consistent production composer menus", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let url: string;
  const errors: string[] = [];
  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/test/composer-menus.html`;
    web = await startProcess(
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
        cwd: `${root}/apps/web`,
        ready: async () => (await fetch(url).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
    });
    page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/context.tsx", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `let settings={};const context={accessContext:{subjectId:"fixture-user"},client:{getAgentLearningSettings:async(_w,_s,source)=>({version:1,settings:source?settings:{knowledge:"automatic",instructions:"review_first",skills:"off"}}),saveAgentLearningSettings:async(_w,input)=>{for(const [key,value] of Object.entries(input.settings)){if(value==="inherit")delete settings[key];else settings[key]=value;}return {version:2,settings};}},captureWorkspaceInvocation:()=>({}),ownsWorkspaceInvocation:()=>true};export function useAppContext(){return context;}`,
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });
  const state = async () => JSON.parse(await page.getByTestId("fixture-state").innerText());
  async function open(name: string) {
    await page.getByRole("button", { name: "More composer actions" }).click();
    await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  }
  test("real resource menus share geometry and preserve mounted switches at desktop and mobile", async () => {
    for (const isNew of [false, true])
      for (const width of [1000, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(url + (isNew ? "?new" : ""), { waitUntil: "networkidle" });
        for (const name of ["Connectors", "Repositories", "Chat settings", "Variable sets"]) {
          await open(name);
          const menu = page.getByRole("menu");
          await menu.waitFor();
          const box = (await menu.boundingBox())!;
          expect(box.width).toBeLessThanOrEqual(Math.min(384, width - 24) + 1);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
            false,
          );
          if (name === "Repositories") {
            const search = menu.getByRole("textbox", { name: "Search repositories" });
            await search.fill("example/app");
            const toggle = menu.getByRole("switch").first();
            expect(await toggle.getAttribute("aria-checked")).toBe("true");
            if (!isNew) {
              expect(await toggle.getAttribute("aria-disabled")).toBe("true");
              await toggle.focus();
              await page.keyboard.press("Space");
              expect((await state()).selected).toEqual([1]);
            }
            expect(
              await menu.getByRole("button", { name: "Refresh list", exact: true }).count(),
            ).toBe(1);
            expect(
              await menu.getByRole("button", { name: "Refresh repositories", exact: true }).count(),
            ).toBe(0);
            await search.fill("");
            await menu
              .getByRole("switch", { name: "Select example/repository-20", exact: true })
              .scrollIntoViewIfNeeded();
          }
          if (name === "Chat settings") {
            const select = menu.getByLabel("Knowledge", { exact: true });
            await select.waitFor();
            expect(await select.inputValue()).toBe("inherit");
            expect(
              await select.locator("..").locator('[aria-hidden="true"]').first().innerText(),
            ).toBe("Allow updates");
            await select.selectOption("off");
            expect(await select.inputValue()).toBe("off");
            await select.selectOption("inherit");
          }
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "hidden" });
        }
      }
    expect(errors).toEqual([]);
  }, 60_000);
  test("variable shortlist preserves off rows, scrolls, removes with Undo, and saves top-first priority", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(url + "?new", { waitUntil: "networkidle" });
    await open("Variable sets");
    const menu = page.getByRole("menu");
    const toggle = (name: string) =>
      menu.getByRole("switch", { name: `Enable ${name}`, exact: true });
    await toggle("Environment 1").click();
    await menu.getByRole("button", { name: "Save", exact: true }).click();
    expect((await state()).runtimeIds).toEqual(["set-2"]);
    await open("Variable sets");
    expect(await toggle("Environment 1").getAttribute("aria-checked")).toBe("false");
    await menu.getByRole("button", { name: "Remove Environment 1", exact: true }).click();
    expect(await toggle("Environment 1").count()).toBe(0);
    await menu.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await toggle("Environment 1").count()).toBe(1);
    await toggle("Environment 1").click();
    await menu.getByRole("button", { name: "Add variable sets", exact: true }).click();
    await toggle("Environment 20").scrollIntoViewIfNeeded();
    await toggle("Environment 20").click();
    expect(await menu.getByRole("button", { name: /Next page/i }).count()).toBe(0);
    await menu.getByRole("textbox", { name: "Search variable sets" }).fill("Environment 19");
    expect(await menu.getByRole("switch").count()).toBe(1);
    await menu.getByRole("button", { name: "Back to selected variable sets" }).click();
    await menu.getByRole("button", { name: "Save", exact: true }).click();
    expect((await state()).runtimeIds).toEqual(["set-2", "set-1", "set-20"]);
    await open("Variable sets");
    await page.screenshot({ path: `${root}/composer-variables-mobile.png` });
    await menu.getByRole("button", { name: "Remove Environment 20", exact: true }).click();
    await menu.getByRole("button", { name: "Cancel", exact: true }).click();
    await open("Variable sets");
    expect(await toggle("Environment 20").getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
  test("connector toggles preserve hidden builtins and file action opens the native chooser", async () => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(url, { waitUntil: "networkidle" });
    await open("Connectors");
    await page.getByRole("menuitemcheckbox", { name: "Slack", exact: true }).click();
    expect((await state()).connectors).toContain("files");
    expect((await state()).connectors).not.toContain("connector-1");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More composer actions" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Add photos & files" }).click();
    await chooser;
    expect(errors).toEqual([]);
  });
});
