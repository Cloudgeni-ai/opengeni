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

  test("an agent's page shows its Slack handle per Slack workspace", async () => {
    const page = await open("agent");
    await page.getByText("@Opengeni +releases").waitFor();
    const acme = page.getByRole("switch", { name: "Available in Acme", exact: true });
    expect(await acme.isChecked()).toBe(true);
    expect(await page.getByRole("switch", { name: "Available in Acme Support" }).isChecked()).toBe(
      false,
    );
    await page.getByRole("button", { name: "Introduce" }).waitFor();
    await page.close();
  }, 60_000);

  test("an Only me agent says why it can't be in Slack", async () => {
    const page = await open("agent-private");
    await page.getByText("Needs People in Platform under Who can use it.").first().waitFor();
    const acme = page.getByRole("switch", { name: "Available in Acme", exact: true });
    expect(await acme.getAttribute("aria-disabled")).toBe("true");
    await page.close();
  }, 60_000);

  test("choosing an agent in the composer fills in its First message", async () => {
    const page = await open("composer", 390);
    const composer = page.getByRole("textbox").first();
    expect(await composer.inputValue()).toContain("Set me up");
    await page.getByRole("button", { name: /^Chat with:/ }).click();
    await page.getByRole("menuitem", { name: /Browse agents/ }).waitFor();
    await page.getByRole("menuitem", { name: /^Opengeni/ }).click();
    expect(await composer.inputValue()).toBe("");
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
