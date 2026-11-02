// Screenshots of the agents UI from its browser fixture (real components).
// Run with: bun apps/web/test/agents-browser.ts
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}/test/agents.html`;
const output = process.env.OPENGENI_AGENTS_SCREENSHOTS ?? "/workspace/.agent/agents-ui";
await mkdir(output, { recursive: true });
const web = await startProcess(
  ["bun", "run", "vite", "dev", ".", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
    timeoutMs: 60_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.OPENGENI_TEST_CHROMIUM ??
    (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
});

type Shot = {
  name: string;
  view: string;
  width?: number;
  height?: number;
  ready: (page: Page) => Promise<unknown>;
  act?: (page: Page) => Promise<unknown>;
};

const text = (value: string) => (page: Page) =>
  page.getByText(value, { exact: false }).first().waitFor();

const shots: Shot[] = [
  { name: "agents-page", view: "agents", ready: text("Bot templates are now agents") },
  {
    name: "agents-page-mobile",
    view: "agents",
    width: 390,
    height: 1100,
    ready: text("Bot templates are now agents"),
  },
  { name: "agent-slack", view: "agent", height: 1750, ready: text("@Opengeni +releases") },
  {
    name: "agent-slack-mobile",
    view: "agent",
    width: 390,
    height: 2300,
    ready: text("@Opengeni +releases"),
  },
  { name: "agent-only-me", view: "agent-private", height: 1400, ready: text("Available in") },
  {
    name: "make-this-an-agent",
    view: "make-agent",
    height: 1500,
    ready: text("Make this an agent"),
  },
  {
    name: "composer-agent-chip-open",
    view: "composer",
    height: 700,
    ready: (page) => page.getByRole("button", { name: /^Chat with:/ }).waitFor(),
    act: async (page) => {
      await page.getByRole("button", { name: /^Chat with:/ }).click();
      await page.getByRole("menuitem", { name: /Browse agents/ }).waitFor();
    },
  },
  {
    name: "composer-agent-chip-mobile",
    view: "composer",
    width: 390,
    height: 700,
    ready: (page) => page.getByRole("button", { name: /^Chat with:/ }).waitFor(),
  },
  {
    name: "agent-chat-header",
    view: "header",
    height: 200,
    ready: text("Started in Slack by Kari"),
  },
  {
    name: "agent-chat-header-mobile",
    view: "header",
    width: 390,
    height: 200,
    ready: text("Started in Slack by Kari"),
  },
  {
    name: "header-make-this-an-agent",
    view: "header-menu",
    height: 640,
    ready: (page) => page.getByRole("button", { name: "More session actions" }).waitFor(),
    act: async (page) => {
      await page.getByRole("button", { name: "More session actions" }).click();
      await page.getByRole("menuitem", { name: "Make this an agent" }).waitFor();
    },
  },
];

const only = process.env.OPENGENI_AGENTS_SHOT;
try {
  for (const shot of shots) {
    if (only && shot.name !== only) continue;
    const page = await browser.newPage({
      viewport: { width: shot.width ?? 1440, height: shot.height ?? 950 },
      reducedMotion: "reduce",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${baseUrl}?view=${shot.view}`, { waitUntil: "networkidle" });
    await shot.ready(page).catch(async (error: unknown) => {
      await page.screenshot({ path: `${output}/${shot.name}-failed.png` });
      throw new Error(`${shot.name}: ${String(error)}\n${errors.join("\n")}`);
    });
    await shot.act?.(page);
    await page.waitForTimeout(300);
    const file = `${output}/${shot.name}.png`;
    await page.screenshot({ path: file });
    if (errors.length > 0) throw new Error(`${shot.name}: ${errors.join("; ")}`);
    console.log(file);
    await page.close();
  }
} finally {
  await browser.close();
  await web.stop();
}
