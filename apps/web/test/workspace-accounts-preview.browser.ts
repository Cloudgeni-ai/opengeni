import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// A workspace-connected Codex account as an organization account: the
// organization's list, its page and the access editor (workspaces, the whole
// organization, chosen people), rendered with the production Models page
// against sample data. Serve with:
//   vite --config test/workspace-accounts-preview.vite.config.ts --port 4297
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
const DESIGN_PLAN = "org:codex:00000000-0000-4000-8000-0000000000c2";
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
      await page.screenshot({ path: `${output}/${width}-${name}.png`, fullPage: true });
    };
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // The organization's list: the Design workspace's account is listed once,
    // as an organization account, tagged with where it is available.
    await open("");
    await page.getByText("Design team plan").waitFor();
    assert((await page.getByText("Design team plan").count()) === 1, "listed twice");
    await page.getByText("Design only").waitFor();
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
    await page.getByText("Available in").click();
    await page.getByText("Connected in this workspace, so it can't be removed.").waitFor();
    await noOverflow();
    await shot("3-editor-workspaces");

    // The whole organization: every shared workspace and Personal workspaces.
    await page.getByText("All shared workspaces, including new ones").click();
    await page.getByText("Personal workspaces", { exact: true }).click();
    await shot("4-editor-organization");

    // Chosen people.
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
      JSON.stringify(saved?.policy) ===
        JSON.stringify({
          allowedModels: null,
          allowedWorkspaces: [],
          allowPersonalWorkspaces: false,
          version: 1,
          allowedPeople: [
            "00000000-0000-4000-8000-0000000000e1",
            "00000000-0000-4000-8000-0000000000e2",
          ],
        }),
      `people save shape: ${JSON.stringify(saved)}`,
    );

    // Back on the list, the account now says who can use it.
    await open("reach=people");
    await page.getByText("Selected people").waitFor();
    await page.getByText("Your Personal workspace").waitFor();
    await page.getByText("Sharing work between accounts").waitFor();
    await shot("6-list-after-people");
    await open(`reach=people&account=${DESIGN_PLAN}`);
    await page.getByText("2 people").waitFor();
    await shot("7-former-workspace-account-people");

    // Design's own page lists it once, as Design's own; the organization's other
    // account is set aside there.
    await open("workspace=00000000-0000-4000-8000-0000000000d1");
    await page.getByText("Acme Pro").waitFor();
    assert((await page.getByText("Design team plan").count()) === 1, "listed twice on Design");
    await page.getByText("Set aside while this workspace has its own").waitFor();
    await noOverflow();
    await shot("8-workspace-page");
    assert(errors.length === 0, errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
}
