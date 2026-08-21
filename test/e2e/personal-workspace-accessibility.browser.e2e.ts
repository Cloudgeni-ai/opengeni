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

  test("activated private-session controls expose exact state and keyboard actions", async () => {
    const surface = page.locator("#personal-session-tenancy");
    const region = surface.getByRole("region", { name: "Session access", exact: true });
    const snapshot = await region.ariaSnapshot();

    expect(snapshot).toContain("Only me");
    expect(snapshot).toContain("Only you can open this session.");
    expect(snapshot).toContain('button "Share with workspace"');
    expect(snapshot).not.toContain("Private copy");

    await page.setViewportSize({ width: 320, height: 740 });
    expect(await region.getAttribute("class")).toContain("flex-wrap");
    expect(await surface.getByRole("button", { name: "Share with workspace" }).count()).toBe(1);
    expect(await surface.getByRole("button", { name: "Private copy" }).count()).toBe(0);

    await page.locator("body").press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Share");
  });

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
    expect(await inactive.getByRole("radio", { name: /Only me/ }).isDisabled()).toBe(true);
    expect(await inactive.textContent()).toContain(
      "Private sessions are not enabled for this organization yet.",
    );

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
