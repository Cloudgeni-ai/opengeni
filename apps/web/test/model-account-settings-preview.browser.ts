import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Account rules: the organization's rules with locks, every workspace's
// effective rules with their source, and one workspace's rules, rendered with
// real components against a synthetic client.
const base = process.env.OPENGENI_SETTINGS_PREVIEW_URL ?? "http://127.0.0.1:4195";
const output = process.env.OPENGENI_SETTINGS_PREVIEW_OUTPUT ?? "/tmp/opengeni-settings-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_SETTINGS_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_SETTINGS_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const receipts = async (page: Page) =>
  JSON.stringify(
    await page.evaluate(
      () => (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
    ),
  );

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 1800 : 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async (query: string) =>
      await page.goto(
        `${base}/test/fixtures/model-account-settings-preview/?${query}&theme=${width === 390 ? "dark" : "light"}`,
        { waitUntil: "networkidle" },
      );
    const shot = (name: string) =>
      page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // The organization: its rules with locks, then every workspace's rules.
    await open("view=organization");
    await page.getByText("Account rules by workspace").waitFor();
    await page.getByText("Claude Opus 5.5 → Claude Sonnet 5.5 → GPT-6.1 Sol").waitFor();
    await page.getByRole("button", { name: "Locked · Unlock" }).waitFor();
    await page.getByText("Research").waitFor();
    await noOverflow();
    await shot("organization");

    // Locking rotation clears Research's own rotation.
    await page.getByRole("button", { name: "Lock for every workspace" }).first().click();
    await page.getByRole("button", { name: "Locked · Unlock" }).nth(1).waitFor();
    assert(
      (await receipts(page)).includes('"locked":["personalFallbackAllowed","rotation"]'),
      `lock not saved: ${await receipts(page)}`,
    );
    await noOverflow();
    await shot("organization-locked-rotation");

    // A workspace: its own value with a one-step return, and a locked rule.
    await open("view=workspace&workspace=design");
    await page.getByText("This workspace follows Acme unless you change a rule here.").waitFor();
    const fallback = page.getByRole("switch", { name: "Fall back to personal accounts" });
    assert((await fallback.getAttribute("aria-disabled")) === "true", "locked rule is editable");
    await noOverflow();
    await shot("workspace");
    await page.getByRole("button", { name: "Use Acme’s setting" }).click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { settingsReceipts: unknown[] }).settingsReceipts,
      ).includes('"personalConnectionsAllowed":null'),
    );
    await page.getByRole("button", { name: "Use Acme’s setting" }).waitFor({ state: "detached" });

    // A member reads the rules without changing them.
    await open("view=workspace&workspace=research&readonly=1");
    await page.getByText("Primary only").waitFor();
    await page.getByText("Set for this workspace.").first().waitFor();
    assert(
      (await page.getByRole("button", { name: "Use Acme’s setting" }).count()) === 0,
      "member can reset",
    );
    await noOverflow();
    await shot("workspace-member");

    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
