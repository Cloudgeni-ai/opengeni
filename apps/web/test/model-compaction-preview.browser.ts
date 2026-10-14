import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const base = process.env.OPENGENI_COMPACTION_PREVIEW_URL ?? "http://127.0.0.1:4193";
const output = process.env.OPENGENI_COMPACTION_PREVIEW_OUTPUT ?? "/tmp/opengeni-compaction-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_COMPACTION_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_COMPACTION_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const receipts = async (page: Page) =>
  JSON.stringify(
    await page.evaluate(
      () => (window as unknown as { compactionReceipts: unknown[] }).compactionReceipts,
    ),
  );
const limit = (page: Page, group: string, model: string) =>
  page
    .getByRole("region", { name: group })
    .getByRole("textbox", { name: `${model} compaction limit in tokens` });

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1400 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `${base}/test/fixtures/model-compaction-preview/?theme=${width === 390 ? "dark" : "light"}`;
    const save = page.getByRole("button", { name: "Save" });
    const shot = (name: string) =>
      page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    const noOverflow = async () =>
      assert(
        !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
        "horizontal overflow",
      );

    // Every usable model is one row; an untouched page offers no Save.
    await page.goto(url, { waitUntil: "networkidle" });
    const opus = limit(page, "Claude subscription", "Claude Opus 5.5");
    const haiku = limit(page, "Claude subscription", "Claude Haiku 5.5");
    await opus.waitFor();
    assert((await opus.getAttribute("placeholder")) === "300,000", "Opus default not shown");
    assert((await opus.inputValue()) === "", "default row holds a value");
    assert(!(await save.isVisible()), "clean page offers Save");
    await noOverflow();
    await shot("default");

    // Out-of-range input explains the range and blocks saving.
    await opus.fill("900000");
    await page.getByText("Use a number from 16,000 to 872,000.").waitFor();
    assert(await save.isDisabled(), "oversized limit can be saved");
    await shot("invalid");

    // "250k" reads as 250,000, shows its default and a way back.
    await opus.fill("250k");
    await opus.blur();
    assert((await opus.inputValue()) === "250,000", "limit not formatted");
    await page.getByText("Default 300,000").waitFor();
    await haiku.fill("90000");
    await page.getByText("2 models changed").waitFor();
    await page.getByRole("button", { name: "Use default for Claude Haiku 5.5" }).click();
    assert((await haiku.inputValue()) === "", "Use default did not clear the limit");
    await page.getByText("1 model changed").waitFor();
    await shot("edited");
    await save.click();
    await page.waitForFunction(() => document.body.dataset.closed === "true");
    assert(
      (await receipts(page)) ===
        JSON.stringify([{ modelCompactionThresholds: { "claude-sub/opus": 250000 } }]),
      "save sent untouched models or lost the edit",
    );

    // Search narrows the list by name or provider.
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("searchbox", { name: "Search models" }).fill("kimi");
    assert((await page.getByRole("textbox").count()) === 1, "search did not narrow the list");

    // Saved limits: one custom, one above the model's current maximum.
    await page.goto(`${url}&state=override`, { waitUntil: "networkidle" });
    assert((await haiku.inputValue()) === "90,000", "saved limit not shown");
    await page.getByText("Default 95,000").waitFor();
    await page.getByText("Above this model’s maximum, so 872,000 is used").waitFor();
    await shot("override");
    await page.getByRole("button", { name: "Use default for Claude Haiku 5.5" }).click();
    await save.click();
    await page.waitForFunction(() => document.body.dataset.closed === "true");
    assert(
      (await receipts(page)) ===
        JSON.stringify([{ modelCompactionThresholds: { "claude-sub/haiku": null } }]),
      "reset did not save the default independently",
    );

    // Read-only: the reason in one line, nothing editable.
    await page.goto(`${url}&role=viewer&state=override`, { waitUntil: "networkidle" });
    await page.getByText("Only workspace admins can change compaction limits.").waitFor();
    assert(await haiku.isDisabled(), "viewer can edit");
    assert(
      (await page.getByRole("button", { name: /Use default/ }).count()) === 0,
      "viewer can reset",
    );
    assert(!(await save.isVisible()), "viewer offered Save");
    await shot("viewer");

    // A failed or superseded save keeps the edit and never claims success.
    for (const state of ["save-error", "stale"]) {
      await page.goto(`${url}&state=${state}`, { waitUntil: "networkidle" });
      await opus.fill("200000");
      await save.click();
      await page.waitForTimeout(200);
      assert(
        (await page.locator("body").getAttribute("data-closed")) !== "true",
        `${state} save claimed success`,
      );
      assert((await opus.inputValue()) === "200,000", `${state} save lost the edit`);
      if (state === "save-error")
        await page.getByText("Couldn’t confirm the save.", { exact: false }).waitFor();
    }

    // Load failure, no connected models, and a server without the setting.
    await page.goto(`${url}&state=error`, { waitUntil: "networkidle" });
    await page.getByText("Couldn’t load this workspace’s models.").waitFor();
    await page.getByRole("button", { name: "Try again" }).waitFor();
    await page.goto(`${url}&state=empty`, { waitUntil: "networkidle" });
    await page.getByText("Connect a subscription or API key to set limits").waitFor();
    await page.goto(`${url}&state=unsupported`, { waitUntil: "networkidle" });
    await page.getByText("Not available on this server yet").waitFor();
    await noOverflow();
    assert(errors.length === 0, errors.join("; "));
    await page.close();
  }
  console.log(
    "Compaction desktop/mobile list, validation, formatting, multi-model edits, reset, search, saved and clamped limits, read-only, failed/stale save and load/empty/unsupported states passed.",
  );
} finally {
  await browser.close();
}
