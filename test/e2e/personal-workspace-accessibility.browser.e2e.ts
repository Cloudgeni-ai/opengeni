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

  test("a suspended membership never labels the workspace Personal", async () => {
    const menuitem = page.locator("#suspended-personal-menuitem");
    const snapshot = await menuitem.ariaSnapshot();
    expect(snapshot).toContain("Roadmap Paused");
    expect(snapshot).not.toContain("Personal");
    expect(await menuitem.getByText("Personal", { exact: true }).count()).toBe(0);
  });

  test("scope navigation is screen-reader legible and keyboard operable", async () => {
    const disclosure = page.locator("#desktop-scope-navigation details");
    const summary = disclosure.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    expect(await disclosure.getAttribute("open")).not.toBeNull();

    const snapshot = await disclosure.ariaSnapshot();
    expect(snapshot).toContain("Scope & access");
    expect(snapshot).toContain("Personal workspace inside this organization");
    expect(snapshot).toContain("Northstar Organization administration");
    expect(snapshot).toContain("Variable sets Organization, Workspace, or Only me");

    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Northstar");
  });

  test("the mobile scope list remains usable at phone width", async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    const navigation = page.locator("#mobile-scope-navigation");
    expect(await navigation.getByRole("navigation", { name: "Scope and access" }).count()).toBe(1);
    expect(await navigation.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    for (const link of await navigation.getByRole("link").all()) {
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
    }
  });
});
