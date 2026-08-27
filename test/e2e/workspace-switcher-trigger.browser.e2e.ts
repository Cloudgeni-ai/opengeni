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
    const trigger = page.locator('button[aria-label$="Switch workspace"]');

    expect(await trigger.getAttribute("aria-label")).toBe(
      "CloudGeni Product Engineering and Reliability. Personal workspace: Personal workspace. Switch workspace",
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
      "Research Sandbox",
      "New workspace…",
    ]) {
      expect(await page.getByRole("menuitem", { name: label, exact: true }).isVisible()).toBe(true);
    }
    expect(await page.getByRole("menuitem", { name: "Settings", exact: true }).count()).toBe(0);
    const personalMenuItem = page.getByRole("menuitem", {
      name: "Personal workspace Personal workspace",
      exact: true,
    });
    expect(await personalMenuItem.isVisible()).toBe(true);
    expect(await personalMenuItem.getByText("Personal", { exact: true }).isVisible()).toBe(true);

    const rail = page.getByTestId("production-rail");
    expect(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await trigger.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const visualWorkspaceLabel = trigger.locator("span.truncate");
    expect(
      await visualWorkspaceLabel.evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    expect(await trigger.getByText("Personal", { exact: true }).isVisible()).toBe(true);

    await page.getByRole("menuitem", { name: "Product Testing", exact: true }).click();
    expect(await page.getByTestId("last-action").textContent()).toBe("Opened Product Testing");
  });

  test("the narrow expanded rail contains the same trigger without page overflow", async () => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto(`${baseUrl}/test/workspace-switcher-trigger.html`, {
      waitUntil: "networkidle",
    });
    const trigger = page.locator('button[aria-label$="Switch workspace"]');
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
  });

  test("Enter and Space open the collapsed tooltip-wrapped trigger and Escape restores focus", async () => {
    await page.setViewportSize({ width: 1120, height: 760 });
    await page.goto(`${baseUrl}/test/workspace-switcher-trigger.html?mode=collapsed`, {
      waitUntil: "networkidle",
    });
    const trigger = page.locator('button[aria-label$="Switch workspace"]');

    await trigger.focus();
    await trigger.press("Enter");
    expect(
      await page.getByRole("menuitem", { name: "Product Testing", exact: true }).isVisible(),
    ).toBe(true);
    await page.keyboard.press("Escape");
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);

    await trigger.press("Space");
    expect(
      await page.getByRole("menuitem", { name: "Product Testing", exact: true }).isVisible(),
    ).toBe(true);
  });
});
