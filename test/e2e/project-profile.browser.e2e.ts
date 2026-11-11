// Project profiles in the real rail: a project's avatar stands in for its
// folder, its description shows when you point at it, and "Edit project…"
// opens the same profile dialog a chat uses. Set
// OPENGENI_PROJECT_PROFILE_ARTIFACT_DIR to keep screenshots of every theme and
// layout.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";

let browser: Browser;
let web: StartedProcess;
let baseUrl = "";
const screenshots = process.env.OPENGENI_PROJECT_PROFILE_ARTIFACT_DIR;

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}/test/project-profile.html`;
  web = await startProcess(
    [
      "bun",
      "run",
      "vite",
      "dev",
      ".",
      "--config",
      "test/project-profile.vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  if (screenshots) await mkdir(screenshots, { recursive: true });
}, 90_000);

afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});

async function openPreview(theme: "dark" | "light", platform: "browser" | "macos") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?theme=${theme}&platform=${platform}`);
  await projectGroup(page, "Bugfixes").getByText("Triage bot").waitFor({ timeout: 90_000 });
  return { page, errors };
}

function projectGroup(page: Page, name: string) {
  return page.getByRole("group", { name, exact: true });
}

function projectHeader(page: Page, name: string) {
  return projectGroup(page, name).getByRole("button", { name, exact: true });
}

async function capture(page: Page, name: string) {
  if (!screenshots) return;
  // Let dialogs, menus and tooltips finish opening.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${screenshots}/${name}.png` });
}

test("project headers show their avatar, or the folder without one", async () => {
  const { page, errors } = await openPreview("dark", "browser");
  expect(
    await projectHeader(page, "UI/UX").locator('[data-session-avatar="emoji"]').textContent(),
  ).toBe("🎨");
  expect(
    await projectHeader(page, "Bugfixes").locator('[data-session-avatar="icon"]').count(),
  ).toBe(1);
  // Research has a description but no avatar: it keeps its folder.
  const research = projectHeader(page, "Research");
  expect(await research.locator("[data-session-avatar]").count()).toBe(0);
  expect(await research.locator("svg.lucide-folder-open, svg.lucide-folder").count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

test("pointing at a project shows its description", async () => {
  const { page, errors } = await openPreview("dark", "browser");
  const header = projectHeader(page, "Bugfixes");
  // The description is also the header's accessible description.
  const describedBy = await header.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(await page.locator(`[id="${describedBy}"]`).textContent()).toBe(
    "Customer-reported bugs and regressions until they ship.",
  );
  await header.hover();
  await page
    .getByRole("tooltip")
    .getByText("Customer-reported bugs and regressions until they ship.")
    .waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

test("Edit project saves only the changed fields and updates the header", async () => {
  const { page, errors } = await openPreview("dark", "browser");
  await projectGroup(page, "Research").hover();
  await page.getByRole("button", { name: "Actions for Research", exact: true }).click();
  // One action edits the whole profile; there is no separate Rename.
  expect(await page.getByRole("menuitem", { name: "Rename project" }).count()).toBe(0);
  await page.getByRole("menuitem", { name: "Edit project…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit project" });
  await dialog.waitFor();
  expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Research");
  expect(await dialog.getByRole("textbox", { name: /Description/ }).inputValue()).toBe(
    "Spikes, benchmarks and reading notes.",
  );
  await dialog.getByRole("radio", { name: "Icon" }).click();
  await dialog.getByRole("button", { name: "Telescope", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: /Description/ })
    .fill("Spikes, benchmarks and reading notes before anything is built.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const updates = await page.evaluate(() => (window as any).projectProfileQa.channelUpdates);
  expect(updates).toEqual([
    {
      id: "00000000-0000-4000-8000-000000000004",
      request: {
        description: "Spikes, benchmarks and reading notes before anything is built.",
        avatar: { kind: "icon", icon: "telescope", hue: expect.any(Number) },
      },
    },
  ]);
  await projectHeader(page, "Research").locator('[data-session-avatar="icon"]').waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

test("a taken name keeps the dialog open with the draft", async () => {
  const { page, errors } = await openPreview("light", "browser");
  await projectGroup(page, "Features").hover();
  await page.getByRole("button", { name: "Actions for Features", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit project…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit project" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Bugfixes");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Couldn't save the project. The name may already be in use.").waitFor();
  expect(await dialog.isVisible()).toBe(true);
  expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Bugfixes");
  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

test("previews: sidebar, description, project and chat profiles in every theme and layout", async () => {
  for (const theme of ["dark", "light"] as const) {
    for (const platform of ["browser", "macos"] as const) {
      const { page, errors } = await openPreview(theme, platform);
      const layout = platform === "browser" ? "web" : "desktop";
      const prefix = `${layout}-${theme}`;
      await capture(page, `${prefix}-1-sidebar`);
      await projectHeader(page, "Bugfixes").hover();
      await page.getByRole("tooltip").waitFor();
      await capture(page, `${prefix}-2-project-description`);
      await page.mouse.move(900, 500);
      await projectGroup(page, "UI/UX").hover();
      await page.getByRole("button", { name: "Actions for UI/UX", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit project…", exact: true }).waitFor();
      await capture(page, `${prefix}-3-project-menu`);
      await page.getByRole("menuitem", { name: "Edit project…", exact: true }).click();
      const projectDialog = page.getByRole("dialog", { name: "Edit project" });
      await projectDialog.waitFor();
      await capture(page, `${prefix}-4-edit-project`);
      await projectDialog.getByRole("radio", { name: "Icon" }).click();
      await capture(page, `${prefix}-5-edit-project-icons`);
      await projectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await projectDialog.waitFor({ state: "hidden" });
      // The chat profile it mirrors, from the same sidebar.
      await page.getByText("Triage bot", { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Edit profile…", exact: true }).click();
      const chatDialog = page.getByRole("dialog", { name: "Edit profile" });
      await chatDialog.waitFor();
      await capture(page, `${prefix}-6-edit-chat-profile`);
      await chatDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(errors).toEqual([]);
      await page.close();
    }
  }
}, 300_000);
