import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

import { renderPersonalWorkspaceAccessibilityFixture } from "../../apps/web/test/personal-workspace-accessibility-fixture";

describe("Personal workspace accessibility in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let tenancyPage: Page;
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
    tenancyPage = await browser.newPage();
    await tenancyPage.goto(`${baseUrl}/test/session-tenancy-control.html`, {
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
      name: "Org 11111111. Organization menu",
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
        name: "Org aaaaaaaa. Organization menu",
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

  test("activated private-session controls expose exact state and keyboard actions", async () => {
    const region = tenancyPage.getByRole("region", { name: "Session access", exact: true });
    const trigger = region.getByRole("button", {
      name: "Private session access. Manage session access",
      exact: true,
    });

    for (const viewport of [
      { width: 1100, height: 760 },
      { width: 320, height: 740 },
    ]) {
      await tenancyPage.setViewportSize(viewport);
      await trigger.focus();
      await trigger.press("Enter");
      const menu = tenancyPage.getByRole("menu");
      await menu.waitFor();
      expect(await menu.textContent()).toContain("Private session");
      expect(await menu.textContent()).toContain("Only you can open this session.");
      expect(
        await menu.getByRole("menuitem", { name: "Share this session with workspace…" }).count(),
      ).toBe(1);
      expect(await menu.getByRole("menuitem", { name: "Private copy" }).count()).toBe(0);
      expect(await menu.getByRole("menuitem", { name: /Fork session/ }).count()).toBe(0);
      await tenancyPage.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
    }

    await trigger.press("Enter");
    await tenancyPage.getByRole("menuitem", { name: "Share this session with workspace…" }).click();
    const dialog = tenancyPage.getByRole("dialog", {
      name: "Share this session with Roadmap Personal workspace?",
    });
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: "Share with workspace" }).count()).toBe(1);
    await tenancyPage.keyboard.press("Escape");
    await tenancyPage.waitForFunction(
      (element) => element === document.activeElement,
      await trigger.elementHandle(),
    );
  }, 15_000);

  test("a suspended membership never labels the workspace Personal", async () => {
    const menuitem = page.locator("#suspended-personal-menuitem");
    const snapshot = await menuitem.ariaSnapshot();
    expect(snapshot).toContain("Roadmap Paused");
    expect(snapshot).not.toContain("Personal");
    expect(await menuitem.getByText("Personal", { exact: true }).count()).toBe(0);
  });

  test("resource and session scope choices are explicit, accessible, and responsive", async () => {
    await page.setViewportSize({ width: 320, height: 900 });

    const resources = page.locator("#resource-scope-picker");
    expect(await resources.getByRole("radio", { name: /Organization/ }).count()).toBe(1);
    expect(await resources.getByRole("radio", { name: /Workspace/ }).isChecked()).toBe(true);
    expect(await resources.getByRole("radio", { name: /Only me/ }).count()).toBe(1);

    const sessions = page.locator("#session-visibility-picker");
    expect(await sessions.getByRole("radio", { name: /Workspace/ }).isChecked()).toBe(true);
    expect(await sessions.getByRole("radio", { name: /Only me/ }).isEnabled()).toBe(true);
    expect(await sessions.textContent()).toContain("Only you can open this session.");

    const inactive = page.locator("#inactive-session-visibility-picker");
    expect(await inactive.getByRole("radio").count()).toBe(0);
    expect(await inactive.textContent()).toBe("");

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
