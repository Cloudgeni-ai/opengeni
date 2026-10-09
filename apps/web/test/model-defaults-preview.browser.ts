import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Organization model defaults and a workspace that follows or changes them,
// rendered with real components against a synthetic client.
const base = process.env.OPENGENI_DEFAULTS_PREVIEW_URL ?? "http://127.0.0.1:4194";
const output = process.env.OPENGENI_DEFAULTS_PREVIEW_OUTPUT ?? "/tmp/opengeni-defaults-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_DEFAULTS_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_DEFAULTS_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const receipts = async (page: Page) =>
  JSON.stringify(
    await page.evaluate(
      () => (window as unknown as { defaultsReceipts: unknown[] }).defaultsReceipts,
    ),
  );

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async (query: string) =>
      await page.goto(
        `${base}/test/fixtures/model-defaults-preview/?${query}&theme=${width === 390 ? "dark" : "light"}`,
        {
          waitUntil: "networkidle",
        },
      );
    const shot = (name: string) =>
      page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // A workspace that follows Acme says so on every row.
    await open("view=workspace");
    await page
      .getByText("This workspace uses Acme’s defaults unless you change them here.")
      .waitFor();
    await page.getByText("Following Acme.", { exact: false }).first().waitFor();
    await page.getByText("Acme’s limits").waitFor();
    await noOverflow();
    await shot("workspace-following");

    // A workspace with its own values says so, and can go back to Acme's default model.
    await open("view=workspace&own=1");
    await page.getByText("Changed for this workspace.", { exact: false }).first().waitFor();
    await page.getByText("1 custom limit").waitFor();
    await shot("workspace-own");
    await page.getByRole("button", { name: "Use Acme’s default" }).click();
    await page.waitForFunction(() =>
      JSON.stringify(
        (window as unknown as { defaultsReceipts: unknown[] }).defaultsReceipts,
      ).includes('"sessionDefaults":null'),
    );

    // The organization's own defaults.
    await open("view=organization");
    await page.getByText("Defaults for every workspace").waitFor();
    await page.getByText("3 models").waitFor();
    await page.getByText("1 limit").waitFor();
    await page.getByRole("button", { name: "Make automatic" }).waitFor();
    await noOverflow();
    await shot("organization");

    // Allowed models: a following workspace shows Acme's list read-only, and
    // turning the switch off lets it choose its own.
    await open("view=workspace-allowed");
    const follow = page.getByRole("switch", { name: "Use Acme’s allowed models" });
    await follow.waitFor();
    assert((await follow.getAttribute("aria-checked")) === "true", "following not shown");
    assert(
      await page.getByRole("checkbox", { name: "Claude Opus 5.5" }).isDisabled(),
      "following list is editable",
    );
    await shot("workspace-allowed-following");
    await follow.click();
    await page.getByRole("checkbox", { name: "GPT-6.1 Sol" }).click();
    await shot("workspace-allowed-own");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => document.body.dataset.closed === "true");
    assert(
      (await receipts(page)) ===
        JSON.stringify([
          {
            put: {
              allowedProviders: null,
              allowedModels: [
                "claude-sub/haiku",
                "claude-sub/opus",
                "claude-sub/sonnet",
                "codex/sol",
              ],
            },
          },
        ]),
      `own list not saved: ${await receipts(page)}`,
    );

    // A workspace with its own list goes back to following Acme.
    await open("view=workspace-allowed&own=1");
    const ownFollow = page.getByRole("switch", { name: "Use Acme’s allowed models" });
    await ownFollow.waitFor();
    assert(
      (await ownFollow.getAttribute("aria-checked")) === "false",
      "own list shown as following",
    );
    await ownFollow.click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => document.body.dataset.closed === "true");
    assert((await receipts(page)) === JSON.stringify([{ delete: true }]), "follow did not delete");

    // Compaction in a workspace: Acme's limit is the placeholder and the reset target.
    await open("view=workspace-compaction&own=1");
    const sonnet = page.getByRole("textbox", {
      name: "Claude Sonnet 5.5 compaction limit in tokens",
    });
    await sonnet.waitFor();
    assert((await sonnet.getAttribute("placeholder")) === "400,000", "Acme's limit not shown");
    await page.getByText("Acme’s limit").first().waitFor();
    await page.getByText("Default 95,000").waitFor();
    await sonnet.fill("200000");
    await sonnet.blur();
    await page.getByRole("button", { name: "Use Acme’s for Claude Sonnet 5.5" }).waitFor();
    await noOverflow();
    await shot("workspace-compaction");

    // Compaction for the organization saves Acme's limits.
    await open("view=organization-compaction");
    const opus = page.getByRole("textbox", { name: "Claude Opus 5.5 compaction limit in tokens" });
    await opus.waitFor();
    assert((await opus.getAttribute("placeholder")) === "300,000", "model default not shown");
    await opus.fill("250k");
    await opus.blur();
    await shot("organization-compaction");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => document.body.dataset.closed === "true");
    assert(
      (await receipts(page)) ===
        JSON.stringify([
          { organization: { modelCompactionThresholds: { "claude-sub/opus": 250000 } } },
        ]),
      `organization limits not saved: ${await receipts(page)}`,
    );

    // Allowed models for the organization has no follow switch.
    await open("view=organization-allowed");
    await page
      .getByText("Choose which models people can pick in every workspace.", { exact: false })
      .waitFor();
    assert(
      (await page.getByRole("switch", { name: /Use Acme/ }).count()) === 0,
      "org page offers follow",
    );
    await shot("organization-allowed");

    assert(errors.length === 0, errors.join("; "));
    await page.close();
  }
  console.log(
    "Organization defaults and workspace follow/own states passed on desktop and mobile.",
  );
} finally {
  await browser.close();
}
