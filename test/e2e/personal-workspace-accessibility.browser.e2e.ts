import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

import { renderPersonalWorkspaceAccessibilityFixture } from "../../apps/web/test/personal-workspace-accessibility-fixture";

describe("Personal workspace accessibility in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let switcherPage: Page;
  let web: StartedProcess;

  beforeAll(async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
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
            await fetch(`${baseUrl}/test/active-organization-switcher.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(renderPersonalWorkspaceAccessibilityFixture());
    switcherPage = await browser.newPage();
    await switcherPage.goto(`${baseUrl}/test/active-organization-switcher.html`, {
      waitUntil: "networkidle",
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("unnamed organizations stay identifiable when expanded, collapsed, and switched", async () => {
    const expanded = switcherPage.getByRole("region", {
      name: "Expanded organization switcher",
    });
    const collapsed = switcherPage.getByRole("region", {
      name: "Collapsed organization switcher",
    });

    const firstTrigger = expanded.getByRole("button", {
      name: "Org 11111111. Switch organization",
      exact: true,
    });
    expect(await firstTrigger.isVisible()).toBe(true);
    expect(await firstTrigger.textContent()).toContain("Org 11111111");
    expect(
      await collapsed
        .getByRole("button", {
          name: "Org 11111111. Workspace: Atlas. Switch workspace",
          exact: true,
        })
        .count(),
    ).toBe(1);

    await firstTrigger.click();
    const firstItem = switcherPage.getByRole("menuitem", { name: "Org 11111111", exact: true });
    const secondItem = switcherPage.getByRole("menuitem", { name: "Org aaaaaaaa", exact: true });
    expect(await firstItem.getAttribute("aria-current")).toBe("true");
    expect(await secondItem.getAttribute("aria-current")).toBeNull();

    await secondItem.click();
    await expanded
      .getByRole("button", {
        name: "Org aaaaaaaa. Switch organization",
        exact: true,
      })
      .waitFor();
    expect(await expanded.textContent()).toContain("Org aaaaaaaa");
    expect(
      await collapsed
        .getByRole("button", {
          name: "Org aaaaaaaa. Workspace: Beacon. Switch workspace",
          exact: true,
        })
        .count(),
    ).toBe(1);
    expect(await switcherPage.getByTestId("active-account-id").textContent()).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
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
