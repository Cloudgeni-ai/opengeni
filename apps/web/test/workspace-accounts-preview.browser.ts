import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// A workspace-connected Codex account as an organization account: the
// organization's list, its page and the access editor (workspaces, the whole
// organization; chosen people for an account no workspace manages), rendered
// with the production Models page against sample data. Serve with:
//   ./node_modules/.bin/vite --config test/workspace-accounts-preview.vite.config.ts --port 4297
const base = process.env.OPENGENI_WORKSPACE_ACCOUNTS_PREVIEW_URL ?? "http://127.0.0.1:4297";
const output =
  process.env.OPENGENI_WORKSPACE_ACCOUNTS_PREVIEW_OUTPUT ?? "/tmp/opengeni-workspace-accounts";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_WORKSPACE_ACCOUNTS_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_WORKSPACE_ACCOUNTS_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const ACME_PRO = "org:codex:00000000-0000-4000-8000-0000000000c1";
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const receipts = async (page: Page) =>
  JSON.stringify(
    await page.evaluate(() => (window as unknown as { accessReceipts: unknown[] }).accessReceipts),
  );

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1600 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async (query: string) => {
      await page.goto(`${base}/test/fixtures/workspace-accounts-preview/?${query}`, {
        waitUntil: "networkidle",
      });
      await page.getByText("PREVIEW WITH SAMPLE DATA").waitFor({ timeout: 60_000 });
    };
    const shot = async (name: string) => {
      await page.waitForTimeout(1000); // let checkbox, card and section transitions settle
      const viewport = page.viewportSize()!;
      const height = await page.evaluate(() =>
        Math.max(
          document.documentElement.scrollHeight,
          document.querySelector("main")?.scrollHeight ?? 0,
        ),
      );
      await page.setViewportSize({ width, height: Math.max(height, viewport.height) });
      await page.evaluate(async () => {
        for (const element of document.querySelectorAll("*"))
          if (element.scrollTop) element.scrollTop = 0;
        window.scrollTo({ top: 0, behavior: "instant" });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await page.screenshot({ path: `${output}/${width}-${name}.png`, animations: "disabled" });
      await page.setViewportSize(viewport);
    };
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // SUB-OWN-06: the owner's actual Personal account page opens the same
    // organization access form, but requires explicit sharing and chosen reach.
    await open(
      "sharing=personal&workspace=00000000-0000-4000-8000-0000000000d4&account=codex:00000000-0000-4000-8000-0000000000c4",
    );
    await page.getByRole("button", { name: "Share account", exact: true }).click();
    await page
      .getByText("Sharing makes this an organization-managed account.", { exact: false })
      .waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Alex's personal account", { exact: true }).click();
    await page.getByRole("button", { name: "Share account", exact: true }).click();
    await page
      .getByText("Sharing makes this an organization-managed account.", { exact: false })
      .waitFor();
    assert(
      await page.getByRole("button", { name: "Share account", exact: true }).isDisabled(),
      "sharing without a reach",
    );
    await page.getByRole("checkbox", { name: "Design", exact: true }).check();
    await noOverflow();
    await shot("0-personal-sharing");
    await page.getByRole("button", { name: "Share account", exact: true }).click();
    await page.waitForFunction(() =>
      (
        window as unknown as { accessReceipts: { policy?: { sharePersonal?: boolean } }[] }
      ).accessReceipts.some((receipt) => receipt.policy?.sharePersonal === true),
    );
    await page
      .getByText("Share your personal account", { exact: true })
      .waitFor({ state: "detached" });
    assert(
      (await page.getByText("This account isn't connected here", { exact: true }).count()) === 0,
      "sharing returned to a nonexistent account page",
    );

    // The organization's list: the Design workspace's account is listed once,
    // as an organization account, tagged with where it is available.
    await open("");
    await page.getByText("Design team plan").waitFor();
    assert((await page.getByText("Design team plan").count()) === 1, "listed twice");
    await page.getByText("Design only").waitFor();
    // Research's own account too: once, tagged with its workspace.
    assert((await page.getByText("Research team plan").count()) === 1, "Research listed twice");
    await page.getByText("Research only").waitFor();
    await page.getByText("Your Personal workspace").waitFor();
    await page.getByText("Sharing work between accounts").waitFor();
    await noOverflow();
    await shot("1-list");

    // Its page: organization settings, no organization primary.
    await page.getByText("Design team plan").click();
    await page.getByText("Available in").waitFor();
    assert((await page.getByText("Primary account").count()) === 0, "primary offered");
    await noOverflow();
    await shot("2-former-workspace-account");

    // The access editor opens on its current reach: Design, which connected it.
    // Workspaces only: limiting it to people would hide it from Design's admins.
    await page.getByText("Available in").click();
    await page.getByText("Connected in this workspace, so it's always included.").waitFor();
    assert((await page.getByText("Only selected people").count()) === 0, "people offered");
    await noOverflow();
    await shot("3-editor-workspaces");

    // The whole organization: every shared workspace and Personal workspaces.
    await page.getByText("All shared workspaces, including new ones").click();
    await page.getByText("Personal workspaces", { exact: true }).click();
    await shot("4-editor-organization");

    // Chosen people, for an organization account no workspace manages.
    await open(`account=${ACME_PRO}`);
    await page.getByText("Available in").click();
    await page.getByText("Only selected people").click();
    await page.getByText("Alex Morgan").click();
    await page.getByText("Sam Rivera").click();
    for (const name of ["Alex Morgan", "Sam Rivera"]) {
      const box = page.getByRole("checkbox", { name: new RegExp(name) });
      for (let tries = 0; !(await box.isChecked()) && tries < 50; tries += 1) {
        await page.waitForTimeout(100);
      }
      assert(await box.isChecked(), `${name} not chosen`);
    }
    await noOverflow();
    await shot("5-editor-people");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() =>
      (window as unknown as { accessReceipts: { access?: string }[] }).accessReceipts.some(
        (receipt) => receipt.access,
      ),
    );
    const saved = (
      JSON.parse(await receipts(page)) as { access?: string; policy?: unknown }[]
    ).find((receipt) => receipt.access);
    assert(
      JSON.stringify(saved) ===
        JSON.stringify({
          access: "00000000-0000-4000-8000-0000000000c1",
          policy: {
            allowedModels: null,
            allowedWorkspaces: [],
            allowPersonalWorkspaces: false,
            version: 1,
            allowedPeople: [
              "00000000-0000-4000-8000-0000000000e1",
              "00000000-0000-4000-8000-0000000000e2",
            ],
          },
        }),
      `people save shape: ${JSON.stringify(saved)}`,
    );

    // On the list, the account now says who can use it.
    await open("reach=people");
    await page.getByText("Selected people").waitFor();
    await page.getByText("Design only").waitFor();
    await page.getByText("Sharing work between accounts").waitFor();
    await shot("6-list-after-people");
    await open(`reach=people&account=${ACME_PRO}`);
    await page.getByText("2 people").waitFor();
    await shot("7-account-people");

    // Design's own page (automatic: both pools listed) lists it once, as Design's own.
    await open("workspace=00000000-0000-4000-8000-0000000000d1");
    await page.getByText("Acme Pro").waitFor();
    await page.getByText("Design team plan").waitFor();
    assert((await page.getByText("Design team plan").count()) === 1, "listed twice on Design");
    // Research's own account doesn't reach Design: not available, nothing set aside, no menu.
    const research = page.locator("[data-slot=list-row]", { hasText: "Research team plan" });
    await research.getByText("Not available here").waitFor();
    assert(
      (await research.getByText("Set aside", { exact: true }).count()) === 0,
      "another workspace's account shown as set aside",
    );
    assert(
      (await research.locator('[aria-label^="More actions"]').count()) === 0,
      "menu on an account that doesn't reach Design",
    );
    await noOverflow();
    await shot("8-workspace-page");

    // Design set to the organization's accounts: its own is only in the set-aside row.
    await open("workspace=00000000-0000-4000-8000-0000000000d1&designSource=organization");
    await page.getByText("This workspace's Codex accounts", { exact: true }).waitFor();
    await page.getByText("Acme Pro").waitFor();
    assert((await page.getByText("Design team plan").count()) === 0, "listed twice on Design");
    await noOverflow();
    await shot("9-workspace-page-organization-source");

    // Shared with every workspace too: in use here through the organization's
    // pool, listed once with its real reach, nothing of Design's set aside.
    await open(
      "reach=all&workspace=00000000-0000-4000-8000-0000000000d1&designSource=organization",
    );
    await page.getByText("Design team plan").waitFor();
    assert((await page.getByText("Design team plan").count()) === 1, "listed twice on Design");
    await page.getByText("Selected workspaces").first().waitFor();
    assert((await page.getByText("Design only").count()) === 0, "stale reach tag");
    assert(
      (await page.getByText("This workspace's Codex accounts", { exact: true }).count()) === 0,
      "own account shown as set aside",
    );
    await noOverflow();
    await shot("10-workspace-page-shared-everywhere");

    // An organization account a workspace also keeps as its own (an older merge):
    // choosing people says that workspace follows the choice too.
    await open(`kept=research&account=${ACME_PRO}`);
    await page.getByText("Available in").click();
    await page.getByText("Only selected people").click();
    await page.getByText("Alex Morgan").click();
    await page.getByText("In Research too, only these people can use it.").waitFor();
    await noOverflow();
    await shot("11-editor-people-kept");

    // Research keeps Acme Pro, now limited to chosen people, and uses only its
    // own accounts: the row is in use for them, and the notice says so.
    await open(
      "reach=people&kept=research&researchSource=workspace&workspace=00000000-0000-4000-8000-0000000000d3",
    );
    await page
      .getByText("Acme Pro, kept as this workspace's own, serves only the people chosen for it.")
      .waitFor();
    const kept = page.locator("[data-slot=list-row]", { hasText: "Acme Pro" });
    await kept.getByText("Selected people").waitFor();
    assert(
      (await kept.getByText("Set aside", { exact: true }).count()) === 0,
      "kept people-limited account shown as set aside",
    );
    await noOverflow();
    await shot("12-workspace-page-kept-for-people");
    assert(errors.length === 0, errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
}
