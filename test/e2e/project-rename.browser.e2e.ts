import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

let browser: Browser;
let page: Page;
let web: StartedProcess;
const screenshots = process.env.OPENGENI_PROJECT_RENAME_ARTIFACT_DIR;
const pageErrors: string[] = [];

beforeAll(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/test/project-rename.html`;
  web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--config",
      "test/project-rename.vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
      ready: async () => (await fetch(url).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url);
  if (screenshots) await mkdir(screenshots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});

async function capture(name: string, fullPage = true) {
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage });
}

test("folders load their own first 50 and continue within that folder", async () => {
  const redesign = page.getByRole("group", { name: "Website redesign", exact: true });
  const bugfixes = page.getByRole("group", { name: "Bugfixes", exact: true });
  const defaultFolder = page.getByRole("group", { name: "Default", exact: true });
  await redesign.getByText("Website redesign kickoff").waitFor();
  await bugfixes.getByText("Bugfix conversation 50").waitFor();
  await defaultFolder.getByText("Default conversation 50").waitFor();
  expect(await bugfixes.getByText("Bugfix conversation 51").count()).toBe(0);
  expect(await defaultFolder.getByText("Default conversation 51").count()).toBe(0);
  await bugfixes.getByRole("button", { name: "Load older sessions in Bugfixes" }).click();
  await bugfixes.getByText("Bugfix conversation 55").waitFor();
  expect(await defaultFolder.getByText("Default conversation 51").count()).toBe(0);
  await defaultFolder.getByRole("button", { name: "Load older sessions in Default" }).click();
  await defaultFolder.getByText("Default conversation 65").waitFor();
  expect(await page.evaluate(() => (window as any).renameQa.pageCalls)).toEqual(
    expect.arrayContaining([
      { channelId: "project-qa", cursor: undefined, limit: 50 },
      { channelId: "00000000-0000-4000-8000-000000000002", cursor: "50", limit: 50 },
      { channelId: null, cursor: "50", limit: 50 },
    ]),
  );
  await bugfixes.getByRole("button", { name: "Bugfixes", exact: true }).click();
  await capture("project-folders-independent-pages", false);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("project-folders-mobile", false);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(pageErrors).toEqual([]);
}, 30_000);

test("production project menu renames, guards saves, and preserves failed drafts", async () => {
  const open = async (name: string) => {
    await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await capture("project-rename-menu");
    await page.getByRole("menuitem", { name: "Rename project", exact: true }).click();
  };
  await open("Website redesign");
  const dialog = page.getByRole("dialog", { name: "Rename project" });
  const input = dialog.getByRole("textbox");
  const submit = dialog.getByRole("button", { name: "Rename", exact: true });
  expect(await input.inputValue()).toBe("Website redesign");
  await capture("project-rename-dialog");
  await input.fill("   ");
  expect(await submit.isDisabled()).toBe(true);
  await input.fill("Website redesign");
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  expect(await page.evaluate(() => (window as any).renameQa.calls.length)).toBe(0);

  await open("Website redesign");
  await input.fill("Product launch");
  await page.evaluate(() => {
    (window as any).renameQa.fail = true;
  });
  await submit.click();
  await page.getByText("Couldn't rename the project. The name may already be in use.").waitFor();
  expect(await input.inputValue()).toBe("Product launch");
  expect(await dialog.isVisible()).toBe(true);
  await capture("project-rename-error");
  await page.evaluate(() => {
    (window as any).renameQa.fail = false;
    (window as any).renameQa.delay = 1000;
  });
  await submit.click();
  expect(await input.isDisabled()).toBe(true);
  await page.keyboard.press("Escape");
  expect(await dialog.isVisible()).toBe(true);
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Actions for Product launch", exact: true }).waitFor();
  expect(await page.evaluate(() => (window as any).renameQa.calls)).toEqual([
    {
      workspace: "11111111-1111-4111-8111-111111111111",
      id: "project-qa",
      request: { name: "Product launch" },
    },
    {
      workspace: "11111111-1111-4111-8111-111111111111",
      id: "project-qa",
      request: { name: "Product launch" },
    },
  ]);
  await capture("project-rename-success");
  expect(pageErrors).toEqual([]);
}, 30_000);
