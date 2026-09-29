import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const fixturePath = "/test/organization-workspace-administration.html";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const adaMembershipId = "44444444-4444-4444-8444-444444444444";
const graceMembershipId = "eeeeeeee-4444-4444-8444-444444444444";
const organizationPath = `/workspaces/${workspaceId}/organization`;

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
    await page.getByText("Ada Member", { exact: true }).first().waitFor();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([context?.close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("uses named roles, exact CAS requests, legacy custom access, and destructive confirms", async () => {
    // People: one list, you first, invitations as rows.
    const people = page.getByRole("list", { name: "People in Acme Engineering" });
    await people.getByText("Ada Member", { exact: true }).waitFor();
    // The sole owner has no row actions; their page says why the role is locked.
    expect(
      await people.getByText("Only owner", { exact: true }).filter({ visible: true }).count(),
    ).toBe(1);
    expect(
      await page
        .getByRole("button", { name: "More actions for Morgan Owner", exact: true })
        .count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Morgan Owner", exact: true }).click();
    await page
      .getByText("You're the only owner. Make someone else an owner first.", { exact: true })
      .first()
      .waitFor();
    const ownerRoles = page.getByRole("radiogroup", { name: "Organization role" });
    expect(await ownerRoles.getByRole("radio", { name: /^Admin/ }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await people.waitFor();

    // Delivery outcomes: both unknown outcomes are shown, only the safe one can be resent.
    expect(
      await people
        .getByText("Email may not have been sent", { exact: true })
        .filter({ visible: true })
        .count(),
    ).toBe(2);
    await page
      .getByRole("button", { name: "More actions for Reconcile Member", exact: true })
      .click();
    expect(await page.getByRole("menuitem", { name: "Resend invitation" }).count()).toBe(0);
    expect(await page.getByRole("menuitem", { name: "Revoke invitation…" }).count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.getByText("expired-member@example.test", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "More actions for Retry Member", exact: true }).click();
    await page.getByRole("menuitem", { name: "Resend invitation", exact: true }).click();
    await expectReceipt(page, {
      action: "retry-delivery",
      invitationId: "77777777-7777-4777-8777-777777777777",
    });
    await page
      .getByText("Sent a new invitation to retry-member@example.test", { exact: true })
      .waitFor();
    await people
      .getByText(/^Invited · expires in \d+ days$/)
      .first()
      .waitFor();

    // Revoking an invitation is a destructive confirm with its consequences.
    await page
      .getByRole("button", { name: "More actions for Reconcile Member", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Revoke invitation…", exact: true }).click();
    const revokeDialog = page.getByRole("dialog", {
      name: "Revoke the invitation to reconcile-member@example.test?",
    });
    expect(await revokeDialog.textContent()).toContain(
      "The link in their email stops working right away.",
    );
    await revokeDialog.getByRole("button", { name: "Revoke invitation", exact: true }).click();
    await expectReceipt(page, {
      action: "revoke-invitation",
      invitationId: "aaaaaaaa-7777-4777-8777-777777777777",
      expectedRevision: 1,
    });
    await revokeDialog.waitFor({ state: "detached" });
    expect(await people.getByText("Reconcile Member", { exact: true }).count()).toBe(0);

    // Workspaces: open the workspace page by keyboard.
    await page.getByRole("button", { name: "Workspaces", exact: true }).click();
    const workspaceRow = page.getByRole("button", { name: "Product engineering", exact: true });
    await workspaceRow.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Product engineering", exact: true }).waitFor();
    const access = page.getByRole("list", { name: "People with access to Product engineering" });

    // Named roles from the server's catalog, saved with the grant's CAS token.
    const role = access.getByRole("combobox", { name: "Role for Ada Member: Viewer" });
    await role.focus();
    await page.keyboard.press("Enter");
    const options = page.getByRole("option");
    expect(
      (await options.allTextContents()).map((text) =>
        ["Viewer", "Member", "Workspace admin"].find((label) => text.startsWith(label)),
      ),
    ).toEqual(["Viewer", "Member", "Workspace admin"]);
    await page.getByRole("option", { name: /^Member/ }).click();
    await expectReceipt(page, {
      action: "grant",
      workspaceId,
      organizationMembershipId: adaMembershipId,
      role: "member",
      expectedUpdatedAt: "2026-08-25T10:00:00.000Z",
    });
    await access.getByRole("combobox", { name: "Role for Ada Member: Member" }).waitFor();

    // A hand-picked grant made through the API is shown as such and resets to a named role.
    await access.getByText("Hand-picked permissions", { exact: true }).waitFor();
    await access
      .getByRole("combobox", { name: "Role for Grace Custom: Custom (set via API)" })
      .waitFor();
    const reset = access.getByRole("button", { name: "Reset to Member", exact: true });
    await reset.focus();
    await page.keyboard.press("Enter");
    await expectReceipt(page, {
      action: "grant",
      workspaceId,
      organizationMembershipId: graceMembershipId,
      role: "member",
      expectedUpdatedAt: "2026-08-25T10:00:00.000Z",
    });
    await access.getByRole("combobox", { name: "Role for Grace Custom: Member" }).waitFor();

    // Removing workspace access is reversible: it happens at once, with Undo.
    await access.getByRole("button", { name: "More actions for Ada Member", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace", exact: true }).click();
    const revoke = await expectReceipt(page, {
      action: "revoke",
      workspaceId,
      organizationMembershipId: adaMembershipId,
    });
    expect(typeof revoke.expectedUpdatedAt).toBe("string");
    expect(await access.getByText("Ada Member", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expectReceipt(page, {
      action: "grant",
      organizationMembershipId: adaMembershipId,
      role: "member",
      expectedUpdatedAt: null,
    });
    await access.getByRole("combobox", { name: "Role for Ada Member: Member" }).waitFor();

    // Removing a person from the organization is a typed destructive confirm, and
    // their page states the Personal workspace boundary.
    await page.getByRole("button", { name: "Workspaces", exact: true }).click();
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.getByRole("button", { name: "Ada Member", exact: true }).click();
    await page.getByRole("heading", { name: "Ada Member", exact: true }).waitFor();
    await page
      .getByText("Private to Ada. Nobody else can open it, including owners and admins.", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: "More actions for Ada Member", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove from organization…", exact: true }).click();
    const removeDialog = page.getByRole("dialog", {
      name: "Remove Ada Member from Acme Engineering?",
    });
    const confirmRemove = removeDialog.getByRole("button", {
      name: "Remove from organization",
      exact: true,
    });
    expect(await confirmRemove.isDisabled()).toBe(true);
    await removeDialog.getByRole("textbox").fill("Ada Member");
    await confirmRemove.click();
    await expectReceipt(page, {
      action: "member",
      membershipId: adaMembershipId,
      kind: "offboard",
      expectedAuthorizationRevision: 1,
    });
    await page.getByRole("list", { name: "People in Acme Engineering" }).waitFor();
    expect(await page.getByText("Ada Member", { exact: true }).count()).toBe(0);

    await page.screenshot({
      path: "/tmp/opengeni-organization-administration-desktop.png",
      fullPage: true,
    });
    await assertA11yAndViewport(page);
  }, 90_000);

  test("keeps Personal workspaces out of invitation selection on a narrow keyboard flow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}${fixturePath}#${organizationPath}?section=people`, {
      waitUntil: "networkidle",
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Organization settings", exact: true }).waitFor();
    await page.getByText("Ada Member", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Invite people", exact: true }).click();
    await page.getByRole("heading", { name: "Invite people", exact: true }).waitFor();
    const email = page.getByRole("textbox", { name: "Email addresses" });
    await email.fill("new-member@example.test");
    await email.press("Enter");
    const sharedWorkspace = page.getByRole("checkbox", { name: "Product engineering" });
    await sharedWorkspace.waitFor();
    expect(
      await page.getByText("Everyone also gets a private Personal workspace.").count(),
    ).toBeGreaterThan(0);
    expect(await page.getByRole("checkbox", { name: /Personal/ }).count()).toBe(0);
    expect(await page.getByRole("checkbox").count()).toBe(1);
    await sharedWorkspace.focus();
    await page.keyboard.press("Space");
    expect(await sharedWorkspace.isChecked()).toBe(true);
    const invite = page.getByRole("button", { name: "Send invitation", exact: true });
    await invite.focus();
    await page.keyboard.press("Enter");
    const receipt = await expectReceipt(page, {
      action: "invite",
      email: "new-member@example.test",
      role: "member",
      initialWorkspaceIds: [workspaceId],
    });
    expect(typeof receipt.operationId).toBe("string");
    expect(typeof receipt.expiresAt).toBe("string");
    await page.getByText("Invited new-member@example.test", { exact: true }).waitFor();
    const people = page.getByRole("list", { name: "People in Acme Engineering" });
    await people.getByText("new-member@example.test", { exact: true }).waitFor();
    await people
      .getByText(/^Invited · expires in \d+ days$/)
      .first()
      .waitFor();

    await page.screenshot({
      path: "/tmp/opengeni-organization-administration-narrow.png",
      fullPage: true,
    });
    await assertA11yAndViewport(page);
  }, 60_000);
});

async function expectReceipt(
  page: Page,
  expected: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(receipt).toMatchObject(expected);
  return receipt;
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
