// Run with: bun apps/web/test/site-publishing-browser.ts
// Captures the production Site page, Publish to web page and Site sign-in page
// with sample data (test/site-publishing-context.ts) at desktop and phone widths.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

const port = Number(process.env.OPENGENI_SITE_PUBLISHING_PORT ?? (await freePort()));
const baseUrl = `http://127.0.0.1:${port}`;
const output =
  process.env.OPENGENI_SITE_PUBLISHING_SCREENSHOTS ?? "/workspace/.agent/site-publishing";
await mkdir(output, { recursive: true });
const web = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "dev",
    ".",
    "--config",
    "test/site-publishing.vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () =>
      (await fetch(`${baseUrl}/test/site-publishing.html`).catch(() => null))?.ok === true,
    timeoutMs: 60_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
});

type Shot = {
  name: string;
  scenario: string;
  ready: (page: Page) => Promise<unknown>;
  act?: (page: Page) => Promise<unknown>;
  narrow?: boolean;
};

const text = (page: Page, value: string | RegExp) =>
  page.getByText(value).first().waitFor({ timeout: 90_000 });
const shots: Shot[] = [
  {
    name: "site-page-entry",
    scenario: "site",
    narrow: true,
    ready: (page) => page.getByRole("button", { name: "Publish" }).waitFor({ timeout: 90_000 }),
  },
  {
    name: "publish-first",
    scenario: "first",
    narrow: true,
    ready: (page) => text(page, /is available/),
  },
  {
    name: "publish-hostname-taken",
    scenario: "taken",
    ready: (page) => text(page, "Another Site uses this name. Try another."),
  },
  {
    name: "publish-hostname-blocked",
    scenario: "first",
    ready: (page) => text(page, /is available/),
    act: async (page) => {
      await page.getByLabel("Address").fill("paypal-refund");
      await text(page, "This name is not allowed.");
    },
  },
  {
    name: "publish-public-agent-free",
    scenario: "public",
    narrow: true,
    ready: (page) => text(page, "Agent spend this month"),
  },
  {
    name: "publish-agent-guest-tools-nonadmin",
    scenario: "agent-nonadmin",
    ready: (page) => text(page, "Let guests use these tools"),
  },
  {
    name: "publish-custom-limits",
    scenario: "public",
    ready: (page) => text(page, "Agent spend this month"),
    act: async (page) => {
      await page.getByRole("radio", { name: "Custom" }).click();
      await text(page, "Spend per month");
    },
  },
  {
    name: "publish-invited",
    scenario: "invited",
    ready: (page) => text(page, "grace@compiler.example"),
  },
  {
    name: "publish-moderation-reports",
    scenario: "moderation",
    narrow: true,
    ready: (page) => text(page, "The contact form asks for my bank password."),
    act: (page) => page.getByRole("heading", { name: "Reports" }).scrollIntoViewIfNeeded(),
  },
  {
    name: "publish-takedown-dialog",
    scenario: "moderation",
    ready: (page) => text(page, "The contact form asks for my bank password."),
    act: async (page) => {
      await page.getByRole("button", { name: "Take down…" }).click();
      await page.getByLabel("Reason").fill("Phishing report confirmed: fake bank sign-in form");
    },
  },
  {
    name: "publish-taken-down",
    scenario: "suspended",
    ready: (page) => text(page, "Taken down"),
  },
  {
    name: "publish-unavailable",
    scenario: "unavailable",
    ready: (page) => text(page, "Publishing isn't set up on this server"),
  },
  {
    name: "publish-only-me",
    scenario: "onlyme",
    ready: (page) => text(page, "Share this Site with the workspace first"),
  },
  {
    name: "site-auth-authorize",
    scenario: "auth",
    narrow: true,
    ready: (page) => text(page, "Continue to team-crm-4k9x.opengeni.site"),
  },
  {
    name: "site-auth-denied",
    scenario: "auth-denied",
    ready: (page) => text(page, "Continue to team-crm-4k9x.opengeni.site"),
    act: async (page) => {
      await page.getByRole("button", { name: "Continue" }).click();
      await text(page, "You can't open this Site");
    },
  },
];

try {
  for (const [width, height] of [
    [1440, 1500],
    [390, 1400],
  ] as const) {
    for (const shot of shots) {
      if (width < 600 && !shot.narrow) continue;
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/test/site-publishing.html?scenario=${shot.scenario}`, {
        waitUntil: "networkidle",
      });
      const file = `${output}/${shot.name}-${width}.png`;
      try {
        await shot.ready(page);
        await shot.act?.(page);
        await page.waitForTimeout(400);
      } catch (error) {
        await page.screenshot({ path: `${output}/failure-${shot.name}-${width}.png` });
        console.error(shot.name, errors, (await page.locator("body").innerText()).slice(0, 1500));
        throw error;
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${shot.name} at ${width}px has no horizontal overflow`);
      await page.screenshot({ path: file, animations: "disabled" });
      assert.deepEqual(errors, [], `${shot.name} renders without errors`);
      console.log(file);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await web.stop();
}
