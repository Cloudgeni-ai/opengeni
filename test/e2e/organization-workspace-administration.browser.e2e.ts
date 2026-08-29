import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const fixturePath = "/test/organization-workspace-administration.html";

describe("organization workspace administration in Chromium", () => {
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
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Organization settings", exact: true }).waitFor();
    await page.getByText("Product engineering", { exact: true }).first().waitFor();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([context?.close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("uses named roles, exact CAS requests, explicit custom access, and destructive revoke", async () => {
    const soleOwnerActions = page.getByRole("button", {
      name: "No actions available for Morgan Owner (you)",
      exact: true,
    });
    expect(await soleOwnerActions.isDisabled()).toBe(true);
    expect(await page.getByText(/Assign another active owner before changing/).count()).toBe(1);
    expect(
      await page
        .getByText("Provider outcome unknown — safe retry available · 1 attempt", { exact: true })
        .count(),
    ).toBe(1);
    expect(
      await page
        .getByText("Provider outcome requires reconciliation — do not resend · 1 attempt", {
          exact: true,
        })
        .count(),
    ).toBe(1);
    await page
      .getByRole("button", {
        name: "More actions for invitation to reconcile-member@example.test",
        exact: true,
      })
      .click();
    expect(
      await page
        .getByRole("menuitem", {
          name: "Retry delivery to reconcile-member@example.test",
          exact: true,
        })
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.getByText("expired-member@example.test", { exact: true }).count()).toBe(0);
    await page
      .getByRole("button", {
        name: "More actions for invitation to retry-member@example.test",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", {
        name: "Retry delivery to retry-member@example.test",
        exact: true,
      })
      .click();
    await expectReceipt(page, {
      action: "retry-delivery",
      invitationId: "77777777-7777-4777-8777-777777777777",
    });
    await page
      .getByText(/Member · Sent · Expires/)
      .first()
      .waitFor();

    const workspaceSummary = page.locator("summary").filter({ hasText: "Product engineering" });
    await workspaceSummary.focus();
    await page.keyboard.press("Enter");

    const role = page.getByRole("combobox", { name: "Workspace access for Ada Member" });
    expect(await role.locator("option").allTextContents()).toEqual([
      "Viewer",
      "Member",
      "Workspace admin",
    ]);
    await role.selectOption("member");
    await expectReceipt(page, { action: "grant", role: "member" });

    await page
      .getByRole("button", { name: "Fine-tune permissions for Ada Member", exact: true })
      .click();
    const customRegion = page.getByRole("dialog", { name: "Fine-tune workspace access" });
    const filesWrite = customRegion.getByRole("checkbox", { name: "files:write" });
    await filesWrite.focus();
    await page.keyboard.press("Space");
    await customRegion.getByRole("button", { name: "Save custom access" }).click();
    await expectReceipt(page, {
      action: "grant",
      role: "custom",
      permissions: [
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "files:read",
        "files:write",
      ],
    });

    const remove = page.getByRole("button", { name: "Remove access" });
    await remove.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    expect(await dialog.textContent()).toContain("Personal workspace access is unchanged");
    await dialog.getByRole("button", { name: "Remove workspace access" }).click();
    await expectReceipt(page, { action: "revoke" });
    expect(await page.getByText("No direct workspace access.").count()).toBe(1);

    await page.screenshot({
      path: "/tmp/opengeni-organization-administration-desktop.png",
      fullPage: true,
    });
    await assertA11yAndViewport(page);
  }, 60_000);

  test("keeps Personal workspaces out of invitation selection on a narrow keyboard flow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("Product engineering", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Invite person", exact: true }).click();
    const email = page.getByLabel("Email address");
    await email.fill("new-member@example.test");
    await page.getByLabel("Name", { exact: true }).fill("New Member");
    await page.getByText("Workspace access", { exact: true }).click();
    const sharedWorkspace = page.getByRole("checkbox", { name: "Product engineering" });
    expect(await page.getByText("Personal workspace", { exact: false }).count()).toBeGreaterThan(0);
    expect(await page.getByRole("checkbox", { name: /Personal/ }).count()).toBe(0);
    await sharedWorkspace.focus();
    await page.keyboard.press("Space");
    expect(await sharedWorkspace.isChecked()).toBe(true);
    const invite = page.getByRole("button", { name: "Send invitation", exact: true });
    await invite.focus();
    await page.keyboard.press("Enter");
    await expectReceipt(page, {
      action: "invite",
      email: "new-member@example.test",
      name: "New Member",
      initialWorkspaceIds: ["22222222-2222-4222-8222-222222222222"],
    });
    await page
      .getByText("Invitation sent to new-member@example.test.", {
        exact: true,
      })
      .waitFor();
    await page.getByText("New Member", { exact: true }).waitFor();
    await page.getByText("new-member@example.test", { exact: true }).waitFor();
    await page
      .getByText(/Member · Sent · Expires/)
      .last()
      .waitFor();

    await page.screenshot({
      path: "/tmp/opengeni-organization-administration-narrow.png",
      fullPage: true,
    });
    await assertA11yAndViewport(page);
  }, 60_000);
});

async function expectReceipt(page: Page, expected: Record<string, unknown>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let receipt: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    receipt = JSON.parse(
      (await page.getByTestId("operation-receipt").textContent()) ?? "{}",
    ) as Record<string, unknown>;
    if (
      Object.entries(expected).every(
        ([key, value]) => JSON.stringify(receipt[key]) === JSON.stringify(value),
      )
    ) {
      expect(receipt).toMatchObject(expected);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(receipt).toMatchObject(expected);
}

async function assertA11yAndViewport(page: Page): Promise<void> {
  await page.locator("[data-sonner-toast]").last().waitFor({ state: "detached", timeout: 10_000 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  const geometry = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const isInsideContainedHorizontalScroller = (element: HTMLElement): boolean => {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const overflowX = getComputedStyle(ancestor).overflowX;
        if (
          (overflowX === "auto" || overflowX === "scroll") &&
          ancestor.scrollWidth > ancestor.clientWidth
        ) {
          const box = ancestor.getBoundingClientRect();
          return box.left >= -1 && box.right <= clientWidth + 1;
        }
      }
      return false;
    };
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: Array.from(document.body.querySelectorAll<HTMLElement>("*"))
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            text: (element.textContent ?? "").trim().slice(0, 80),
            left: Math.round(box.left),
            right: Math.round(box.right),
            width: Math.round(box.width),
            contained: isInsideContainedHorizontalScroller(element),
          };
        })
        .filter(
          ({ contained, left, right, width }) =>
            !contained && width > 0 && (left < -1 || right > clientWidth + 1),
        )
        .map(({ contained: _contained, ...item }) => item)
        .slice(0, 20),
    };
  });
  expect(geometry).toEqual({
    clientWidth: await page.evaluate(() => innerWidth),
    scrollWidth: geometry.clientWidth,
    overflow: [],
  });
}
