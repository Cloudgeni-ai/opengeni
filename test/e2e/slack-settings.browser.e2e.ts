import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import {
  slackFixtureResponse,
  workspaceId,
  siblingId,
  type SlackFixtureState,
} from "./fixtures/slack-settings";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidence = `${repoRoot}/.agent/evidence/slack-settings`;
let browser: Browser;
let web: StartedProcess;
let baseUrl: string;

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await mkdir(evidence, { recursive: true });
  web = await startProcess(
    ["bun", "run", "vite", "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: `${repoRoot}/apps/web`,
      env: { VITE_API_BASE_URL: "http://127.0.0.1:9" },
      ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30_000);

// The Slack integration's Capabilities page (the only page open in these tests).
const slackPage = "[data-capability-page]";

test("connected page is compact, accessible, and keeps real routing and disconnect controls", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const state = { installed: true, routingSaves: 0, disconnects: 0 };
  try {
    await installApi(page, state);
    await page.goto(`${baseUrl}/workspaces/${workspaceId}/plugins?integration=slack`);
    // The legacy link opens the Slack page, not a sheet.
    const sheet = page.locator(slackPage);
    await sheet.getByRole("heading", { name: "Opengeni bot", exact: true }).waitFor();
    expect(await sheet.locator("h1").textContent()).toBe("Slack");
    await sheet.getByRole("button", { name: "Cloudgeni", exact: true }).click();
    expect(new URL(page.url()).searchParams.get("open")).toBe("integration:slack");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await sheet.getByRole("heading", { name: "Work started from Slack", exact: true }).waitFor();
    expect(await sheet.getByRole("button", { name: "Reconnect", exact: true }).isVisible()).toBe(
      false,
    );
    expect(await sheet.getByText("Bot", { exact: true }).isVisible()).toBe(false);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (nextTheme) => document.documentElement.setAttribute("data-og-theme", nextTheme),
        theme,
      );
      await page.waitForTimeout(600);
      const accessibility = await new AxeBuilder({ page }).include(slackPage).analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({ path: `${evidence}/connected-${theme}.png` });
    }
    await sheet.getByRole("button", { name: "Channels" }).click();
    const routing = page.locator("main");
    await page.getByRole("heading", { name: "Slack channels", exact: true }).waitFor();
    await routing.getByRole("combobox").selectOption(siblingId);
    await routing.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.getByRole("heading", { name: "Work started from Slack", exact: true }).waitFor();
    expect(state.routingSaves).toBe(1);
    await sheet.getByRole("button", { name: "More actions for Cloudgeni", exact: true }).click();
    await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Disconnect the Opengeni Slack bot?" });
    await confirmation.getByText(/whole organization/).waitFor();
    expect(state.disconnects).toBe(0);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 360, height: 800 });
    await sheet.getByRole("button", { name: /^Technical details/ }).click();
    await sheet.getByText("Bot", { exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).include(slackPage).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${evidence}/expanded-mobile.png` });
  } finally {
    await context.close();
  }
}, 90_000);

test("sibling workspace opens the same bot settings without changing workspace", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await installApi(page, { installed: true, routingSaves: 0, disconnects: 0 });
    await page.goto(`${baseUrl}/workspaces/${siblingId}/plugins?integration=slack`);
    const sheet = page.locator(slackPage);
    await sheet.getByRole("button", { name: "Cloudgeni", exact: true }).click();
    await sheet.getByRole("heading", { name: "Work started from Slack", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe(`/workspaces/${siblingId}/plugins`);
    await sheet.getByRole("heading", { name: "Available in Opengeni", exact: true }).waitFor();
    expect(await sheet.getByRole("button", { name: "Open Slack settings" }).count()).toBe(0);
  } finally {
    await context.close();
  }
}, 60_000);

test("OAuth conflict stays visible after reload without blocking another workspace", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await installApi(page, { installed: false, routingSaves: 0, disconnects: 0 });
    await page.goto(
      `${baseUrl}/workspaces/${workspaceId}/capabilities?slack=error&reason=http_409`,
    );
    const sheet = page.locator(slackPage);
    await sheet
      .getByText("Slack is already linked to another installation", { exact: true })
      .waitFor();
    await page.reload();
    await sheet
      .getByText("Slack is already linked to another installation", { exact: true })
      .waitFor();
    await sheet.getByRole("button", { name: "Add Slack workspace", exact: true }).waitFor();
    await sheet.getByRole("button", { name: "Dismiss", exact: true }).click();
    expect(new URL(page.url()).searchParams.has("slack")).toBe(false);
  } finally {
    await context.close();
  }
}, 60_000);

test("multiple bot installations keep access changes on the selected workspace", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const state: SlackFixtureState = {
    installed: true,
    multiple: true,
    routingSaves: 0,
    disconnects: 0,
  };
  try {
    await installApi(page, state);
    await page.goto(`${baseUrl}/workspaces/${siblingId}/plugins?integration=slack`);
    const sheet = page.locator(slackPage);
    await sheet.getByRole("button", { name: "Community", exact: true }).waitFor();
    await sheet.getByText("Alex · Cloudgeni", { exact: true }).waitFor();
    await page.screenshot({ path: `${evidence}/inventory.png` });
    await sheet.getByRole("button", { name: "Community", exact: true }).click();
    expect(
      await sheet.getByText("Publish important decisions to Slack", { exact: true }).count(),
    ).toBe(0);
    await sheet.getByRole("button", { name: "Edit access", exact: true }).click();
    await sheet.getByRole("combobox", { name: "Bot workspace access" }).click();
    await page.getByRole("option", { name: "Selected workspaces", exact: true }).click();
    await sheet.getByRole("checkbox", { name: "Analytics", exact: true }).click();
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.getByRole("button", { name: "Edit access", exact: true }).waitFor();
    expect(state.access?.["00000000-0000-4000-8000-000000000818"]).toMatchObject({
      enabled: true,
      workspaceIds: [siblingId],
    });
    expect(state.access?.["00000000-0000-4000-8000-000000000814"]).toBeUndefined();
    expect(new URL(page.url()).pathname).toBe(`/workspaces/${siblingId}/plugins`);
    await page.screenshot({ path: `${evidence}/community-access.png` });
    await page.goto(`${baseUrl}/workspaces/${workspaceId}/plugins?integration=slack`);
    await sheet.getByRole("button", { name: /^Workspace automation/ }).click();
    await sheet
      .getByText(
        "Settings for the Cloudgeni Opengeni workspace. Reaction settings apply to all bots installed here.",
        { exact: true },
      )
      .waitFor();
    await sheet.getByText(/Posts as Cloudgeni · #dev/).waitFor();
  } finally {
    await context.close();
  }
}, 60_000);

test("schedule keeps the task and timing visible with secondary settings collapsed", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  try {
    await installApi(page, { installed: true, multiple: true, routingSaves: 0, disconnects: 0 });
    await page.goto(`${baseUrl}/workspaces/${siblingId}/schedules/new`);
    await page.getByRole("heading", { name: "New schedule", exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(
        "Review yesterday’s customer conversations and post a short summary to #usage-analytics in the internal Slack workspace as the Opengeni bot.",
      );
    await page
      .getByRole("textbox", { name: "NameOptional" })
      .fill("Daily customer conversation outcomes");
    const settings = page.getByRole("button", { name: /^Settings / });
    expect(await settings.getAttribute("aria-expanded")).toBe("false");
    expect((await new AxeBuilder({ page }).include("form").analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${evidence}/schedule.png` });
    await settings.click();
    expect(await page.getByRole("combobox", { name: "Where it runs" }).textContent()).toContain(
      "Workspace default",
    );
    expect(
      await page
        .getByText("Currently: Managed sandbox. Follows changes to the workspace default.")
        .count(),
    ).toBe(1);
    await page.screenshot({ path: `${evidence}/schedule-machine-default.png` });
    expect(await page.getByText("Post to Slack", { exact: true }).count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${evidence}/schedule-mobile.png` });
  } finally {
    await context.close();
  }
}, 60_000);

test("workspace default machine saves once and schedules show its current name", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const machineId = "00000000-0000-4000-8000-000000000831";
  const state: SlackFixtureState = {
    installed: true,
    routingSaves: 0,
    disconnects: 0,
    machines: [
      {
        sandboxId: machineId,
        enrollmentId: "shared-build",
        workspaceId: siblingId,
        kind: "selfhosted",
        scope: "workspace",
        name: "Build Mac",
        state: "online",
        os: "macos",
        arch: "arm64",
      },
      {
        sandboxId: "personal",
        enrollmentId: "personal",
        workspaceId: siblingId,
        kind: "selfhosted",
        scope: "user",
        name: "Personal laptop",
        state: "online",
        os: "macos",
        arch: "arm64",
      },
    ],
  };
  try {
    await installApi(page, state);
    await page.goto(`${baseUrl}/workspaces/${siblingId}/settings?section=general`);
    const picker = page.getByRole("combobox", { name: "Default machine", exact: true });
    await picker.click();
    await page.getByRole("option", { name: "Build Mac", exact: true }).waitFor();
    expect(await page.getByRole("option", { name: "Personal laptop" }).count()).toBe(0);
    await page.getByRole("option", { name: "Build Mac", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('[role="combobox"]')?.textContent?.includes("Build Mac"),
    );
    expect(state.defaultExecutionTarget).toEqual({ kind: "machine", targetSandboxId: machineId });
    await page.screenshot({ path: `${evidence}/workspace-default-machine.png` });
    await page.goto(`${baseUrl}/workspaces/${siblingId}/sessions`);
    await page.getByRole("textbox", { name: "Message the agent" }).waitFor();
    const savedDraft = page.waitForResponse(
      (response) =>
        response.url().endsWith("/new-session-draft") && response.request().method() === "PUT",
    );
    await page
      .getByRole("textbox", { name: "Message the agent" })
      .fill("Check the workspace default machine.");
    await savedDraft;
    await page.getByRole("button", { name: "More composer actions" }).click();
    await page.getByRole("menuitem", { name: /Runs on.*Build Mac/ }).waitFor();
    expect(state.draft?.options).toMatchObject({ targetSandboxId: machineId });
    await page.screenshot({ path: `${evidence}/new-chat-default-machine.png` });
    await page.goto(`${baseUrl}/workspaces/${siblingId}/schedules/new`);
    await page.getByRole("button", { name: /^Settings / }).click();
    await page
      .getByText("Currently: Build Mac. Follows changes to the workspace default.")
      .waitFor();
    await page
      .getByRole("combobox", { name: "Where it runs" })
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${evidence}/schedule-shared-machine.png` });
    state.machines = [];
    await page.reload();
    await page.getByRole("button", { name: /^Settings / }).click();
    await page.getByText("Machine unavailable. Choose a replacement or reconnect it.").waitFor();
    expect(
      await page.getByRole("button", { name: "Create schedule", exact: true }).isDisabled(),
    ).toBe(true);
    state.sessions = [
      {
        id: "00000000-0000-4000-8000-000000000841",
        workspaceId: siblingId,
        title: "Customer conversation analysis",
        status: "idle",
        resources: [],
        tools: [],
        firstPartyMcpTools: [],
        firstPartyMcpPermissions: [],
        visibility: "workspace",
        model: "gpt-5.6-sol",
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
      },
    ];
    await page.reload();
    await page.getByRole("combobox", { name: "Chat", exact: true }).click();
    await page.getByRole("option", { name: /Use an existing chat/ }).click();
    await page.getByRole("combobox", { name: "Send to", exact: true }).click();
    await page.getByRole("option", { name: /Customer conversation analysis/ }).click();
    await page.getByRole("button", { name: /Uses this chat’s settings/ }).click();
    await page.getByRole("link", { name: "Open chat settings" }).waitFor();
    await page
      .getByRole("link", { name: "Open chat settings" })
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${evidence}/schedule-inherited-settings.png` });
  } finally {
    await context.close();
  }
}, 60_000);

async function installApi(page: Page, state: SlackFixtureState) {
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const response = await slackFixtureResponse(
      new Request(route.request().url(), {
        method: route.request().method(),
        ...(route.request().postData() ? { body: route.request().postData()! } : {}),
      }),
      state,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}
