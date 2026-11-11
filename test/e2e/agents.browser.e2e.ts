import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser, type Page } from "playwright";

const root = new URL("../..", import.meta.url).pathname;

describe("agents in the browser", () => {
  let browser: Browser;
  let web: StartedProcess;
  let url: string;

  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/test/agents.html`;
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
        timeoutMs: 60_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
    });
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  async function open(view: string, width = 1280): Promise<Page> {
    const page = await browser.newPage({
      viewport: { width, height: 1600 },
      reducedMotion: "reduce",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?view=${view}`, { waitUntil: "networkidle" });
    expect(errors).toEqual([]);
    return page;
  }

  test("the Agents page lists agents with the move banners and a rename notice", async () => {
    const page = await open("agents");
    await page.getByText("Bot templates are now agents.").waitFor();
    await page.getByText("Slack agents are now agents. Manage them here.").waitFor();
    await page.getByText(/More than one agent is called/).waitFor();
    await page.getByRole("button", { name: "New agent" }).waitFor();
    expect(await page.getByText("Release manager", { exact: true }).count()).toBe(1);
    // A dismissed banner stays dismissed.
    await page.getByRole("button", { name: "Dismiss" }).first().click();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("Slack agents are now agents. Manage them here.").waitFor();
    expect(await page.getByText("Bot templates are now agents.").count()).toBe(0);
    await page.close();
  }, 60_000);

  test("an agent's page shows how to call it in each linked Slack workspace", async () => {
    const page = await open("agent");
    await page.getByText("@Opengeni Release manager").waitFor();
    // There is no switch to make it available: it is, wherever it can be.
    expect(await page.getByRole("switch", { name: /^Available in/u }).count()).toBe(0);
    await page
      .getByText("For now an agent works in one Slack workspace, and it's in Acme.")
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Introduce" }).waitFor();
    await page.close();
  }, 60_000);

  test("an Only me agent says why it can't be in Slack", async () => {
    const page = await open("agent-private");
    await page.getByText("Only me agents stay in the app.", { exact: false }).first().waitFor();
    await page.close();
  }, 60_000);

  test("choosing an agent in the composer selects it and leaves the composer empty", async () => {
    const page = await open("composer", 390);
    const main = page.locator("main");
    const composer = page.getByRole("textbox").first();
    const chip = page.getByRole("button", { name: /^Chat with:/ });
    const choose = async (name: RegExp) => {
      await chip.click();
      await page.getByRole("menuitem", { name: /Browse agents/ }).waitFor();
      await page.getByRole("menuitem", { name }).click();
    };
    await page.getByRole("button", { name: /^Chat with: Onboarding buddy/ }).waitFor();
    expect(await composer.inputValue()).toBe("");
    expect(await main.getAttribute("data-draft-text")).toBe("");

    // An Only me agent: its chat is Only me, and Workspace says why it's off.
    await choose(/^Meeting notes/);
    expect(await composer.inputValue()).toBe("");
    await page.getByRole("button", { name: "Visibility: Only me" }).click();
    const workspace = page.getByRole("menuitemradio", { name: /Workspace/ });
    expect(await workspace.getAttribute("aria-disabled")).toBe("true");
    expect(await workspace.textContent()).toContain("Only me agents have Only me chats.");
    await page.keyboard.press("Escape");
    // Back to Opengeni restores who can see it.
    await choose(/^Opengeni/);
    await page.getByRole("button", { name: "Visibility: Workspace" }).waitFor();

    // What the person typed is theirs: it is saved and stays across agents.
    await composer.pressSequentially("Set up my laptop.");
    await choose(/^Onboarding buddy/);
    expect(await composer.inputValue()).toBe("Set up my laptop.");
    expect(await main.getAttribute("data-draft-text")).toBe("Set up my laptop.");
    expect(await main.getAttribute("data-can-send")).toBe("true");
    await choose(/^Opengeni/);
    expect(await composer.inputValue()).toBe("Set up my laptop.");
    await page.close();
  }, 60_000);

  test("where Only me chats aren't available, an Only me agent says so and Send stays off", async () => {
    const page = await open("composer-only-me&private=off", 390);
    await page.getByRole("alert").getByText("Only me agents need Only me chats").waitFor();
    expect(await page.locator("main").getAttribute("data-can-send")).toBe("false");
    await page.getByRole("button", { name: "Chat with: Meeting notes" }).click();
    const notes = page.getByRole("menuitem", { name: /^Meeting notes/ });
    expect(await notes.getAttribute("aria-disabled")).toBe("true");
    await page.close();
  }, 60_000);

  test("an agent chat names the agent and says where it started", async () => {
    const page = await open("header", 390);
    await page.getByText("Started in Slack by Kari").waitFor();
    expect(await page.locator("[data-session-agent]").textContent()).toBe("Release manager");
    await page.close();
  }, 60_000);

  test("an ordinary chat offers Make this an agent", async () => {
    const page = await open("header-menu");
    await page.getByRole("button", { name: "More session actions" }).click();
    await page.getByRole("menuitem", { name: "Make this an agent" }).waitFor();
    await page.close();
  }, 60_000);
});
