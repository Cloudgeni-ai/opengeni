import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

describe("Workspace switcher trigger in Chromium", () => {
  let browser: Browser;
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
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/test/workspace-switcher-trigger.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("pointer activation opens every expected workspace and destination", async () => {
    await page.goto(`${baseUrl}/test/workspace-switcher-trigger.html`, {
      waitUntil: "networkidle",
    });
    const trigger = page.locator('button[aria-label$="Switch workspace or organization"]');

    expect(await trigger.getAttribute("aria-label")).toBe(
      "Personal workspace, private to you: Personal workspace, in CloudGeni Product Engineering and Reliability. Switch workspace or organization",
    );
    expect(await trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    await page.mouse.click(
      triggerBox!.x + triggerBox!.width / 2,
      triggerBox!.y + triggerBox!.height / 2,
    );
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");

    for (const label of [
      "Default workspace",
      "Product Testing",
      "New workspace in CloudGeni Product Engineering and Reliability",
      "Organization settings",
      // Another organization is one row that opens its workspace.
      "CloudGeni Research",
      "New organization",
    ]) {
      expect(await page.getByRole("menuitem", { name: label, exact: true }).isVisible()).toBe(true);
    }
    // Only the current organization's workspaces and settings are listed.
    expect(
      await page.getByRole("menuitem", { name: "Research Sandbox", exact: true }).count(),
    ).toBe(0);
    expect(
      await page.getByRole("menuitem", { name: "Organization settings", exact: true }).count(),
    ).toBe(1);
    const personalMenuItem = page.getByRole("menuitem", {
      name: "Personal workspace, your Personal workspace, private to you",
      exact: true,
    });
    expect(await personalMenuItem.isVisible()).toBe(true);
    // Seen as a lock tile in place of the initial.
    expect(await personalMenuItem.locator("svg.lucide-lock").isVisible()).toBe(true);

    const rail = page.getByTestId("production-rail");
    expect(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await trigger.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    // The long organization line truncates inside the trigger instead of widening it.
    const visualOrganizationLine = trigger.locator("span.truncate").nth(1);
    expect(
      await visualOrganizationLine.evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    expect(
      await trigger
        .getByText("Private · CloudGeni Product Engineering and Reliability", { exact: true })
        .isVisible(),
    ).toBe(true);

    await page.getByRole("menuitem", { name: "Product Testing", exact: true }).click();
    expect(await page.getByTestId("last-action").textContent()).toBe("Opened Product Testing");
  }, 15_000);

  test("the combined menu exposes organization creation and settings to pointer and keyboard", async () => {
    await page.goto(`${baseUrl}/test/workspace-switcher-trigger.html`, {
      waitUntil: "networkidle",
    });
    const trigger = page.locator('button[aria-label$="Switch workspace or organization"]');

    await trigger.focus();
    await trigger.press("Enter");
    await page.getByRole("menuitem", { name: "New organization", exact: true }).click();
    expect(await page.getByTestId("last-action").textContent()).toBe("New organization");

    const organizationSettings = page.getByRole("menuitem", {
      name: "Organization settings",
      exact: true,
    });
    // Home, then past the three workspaces and New workspace.
    await page.keyboard.press("Home");
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowDown");
    expect(
      await organizationSettings.evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.getByTestId("route-path").textContent()).toBe(
      "/workspaces/workspace-personal/organization",
    );
  }, 15_000);

  test("the narrow expanded rail contains the same trigger without page overflow", async () => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto(`${baseUrl}/test/workspace-switcher-trigger.html`, {
      waitUntil: "networkidle",
    });
    const trigger = page.locator('button[aria-label$="Switch workspace or organization"]');
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page
        .getByTestId("production-rail")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);

    await page.mouse.click(
      triggerBox!.x + triggerBox!.width / 2,
      triggerBox!.y + triggerBox!.height / 2,
    );
    expect(
      await page.getByRole("menuitem", { name: "Product Testing", exact: true }).isVisible(),
    ).toBe(true);
  }, 15_000);

  test("Enter and Space open the collapsed tooltip-wrapped trigger and Escape restores focus", async () => {
    await page.setViewportSize({ width: 1120, height: 760 });
    await page.goto(`${baseUrl}/test/workspace-switcher-trigger.html?mode=collapsed`, {
      waitUntil: "networkidle",
    });
    const trigger = page.locator('button[aria-label$="Switch workspace or organization"]');

    await trigger.focus();
    await trigger.press("Enter");
    expect(
      await page.getByRole("menuitem", { name: "Product Testing", exact: true }).isVisible(),
    ).toBe(true);
    await page.keyboard.press("Escape");
    // Radix restores focus during deferred close cleanup, not synchronously on Escape.
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector('button[aria-label$="Switch workspace or organization"]'),
      undefined,
      { timeout: 2_000 },
    );
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);

    await trigger.press("Space");
    expect(
      await page.getByRole("menuitem", { name: "Product Testing", exact: true }).isVisible(),
    ).toBe(true);
  }, 15_000);
});
