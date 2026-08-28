import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const fixturePath = "/test/personal-github-identity.html";

describe("personal GitHub identity dialog in Chromium", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
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
        cwd: `${repoRoot}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}${fixturePath}`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    page = await context.newPage();
    await openFixture(page, baseUrl);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([context?.close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("keeps the desktop flow compact, keyboard-operable, and exact", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("heading", { name: "Your GitHub identity" }).count()).toBe(1);
    expect(await dialog.textContent()).toContain("Connected as @octocat");
    expect(await dialog.textContent()).toContain("additional allowlist");

    const search = dialog.getByLabel("Find a GitHub repository");
    await search.focus();
    await search.fill("research");
    const allow = dialog.getByRole("button", { name: "Allow octocat/research-notes" });
    await allow.focus();
    await page.keyboard.press("Space");
    expect(
      await dialog
        .getByRole("button", { name: "Remove octocat/research-notes" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await search.fill("");

    const save = dialog.getByRole("button", { name: "Save repositories" });
    await save.focus();
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    expect(await receipt(page)).toEqual({
      action: "save",
      selection: [
        { repositoryId: "101", fullName: "octocat/opengeni", access: "write" },
        { repositoryId: "102", fullName: "octocat/design-system", access: "read" },
        { repositoryId: "103", fullName: "octocat/research-notes", access: "write" },
      ],
    });

    await page.getByRole("button", { name: "Manage GitHub identity" }).click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({ path: "/tmp/opengeni-personal-github-desktop.png", fullPage: true });
    await assertAccessibleAndContained(page);
  }, 60_000);

  test("stays contained and legible on a narrow screen", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFixture(page, baseUrl);
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: "Disconnect" }).count()).toBe(1);
    expect(await dialog.getByRole("button", { name: "Reconnect" }).count()).toBe(1);
    expect(await dialog.getByRole("button", { name: "Save repositories" }).count()).toBe(1);
    await page.screenshot({ path: "/tmp/opengeni-personal-github-narrow.png", fullPage: true });
    await assertAccessibleAndContained(page);
  }, 60_000);
});

async function openFixture(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: "networkidle" });
  await page.getByRole("dialog").waitFor();
}

async function receipt(page: Page): Promise<Record<string, unknown>> {
  return JSON.parse(
    (await page.getByTestId("personal-github-receipt").textContent()) ?? "{}",
  ) as Record<string, unknown>;
}

async function assertAccessibleAndContained(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(report.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
