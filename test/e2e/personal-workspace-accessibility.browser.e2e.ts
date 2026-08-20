import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

import { renderPersonalWorkspaceAccessibilityFixture } from "../../apps/web/test/personal-workspace-accessibility-fixture";

describe("Personal workspace accessibility in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(renderPersonalWorkspaceAccessibilityFixture());
  });

  afterAll(async () => {
    await browser?.close();
  });

  test("the generic badge exposes Personal workspace through the accessibility tree", async () => {
    const snapshot = await page.locator("#personal-badge").ariaSnapshot();
    expect(snapshot).toContain("Personal workspace");
    expect(snapshot).not.toContain("- text: Personal\n");
  });

  test("a paused Personal menu item preserves identity and dynamic status in its name", async () => {
    const snapshot = await page.locator("#personal-menuitem").ariaSnapshot();
    expect(snapshot).toContain("Roadmap Personal workspace Paused");
    const menuitem = page.getByRole("menuitem", {
      name: "Roadmap Personal workspace Paused",
      exact: true,
    });
    expect(await menuitem.count()).toBe(1);
    expect(await menuitem.isVisible()).toBe(true);
    expect(await page.locator("#personal-menuitem").getAttribute("aria-label")).toBeNull();
  });

  test("activated private-session controls expose exact state and keyboard actions", async () => {
    const surface = page.locator("#personal-session-tenancy");
    const region = surface.getByRole("region", { name: "Session access", exact: true });
    const snapshot = await region.ariaSnapshot();

    expect(snapshot).toContain("Access");
    expect(snapshot).toContain("Private");
    expect(snapshot).toContain("Only you can open this session.");
    expect(snapshot).toContain('button "Share with workspace"');
    expect(snapshot).toContain('button "Private fork"');

    await page.setViewportSize({ width: 320, height: 740 });
    expect(await region.getAttribute("class")).toContain("flex-wrap");
    expect(await surface.getByRole("button", { name: "Share with workspace" }).count()).toBe(1);
    expect(await surface.getByRole("button", { name: "Private fork" }).count()).toBe(1);

    await page.locator("body").press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
      "Share with workspace",
    );
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
      "Private fork",
    );
  });
});
