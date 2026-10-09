import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

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
try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `${base}/test/fixtures/model-compaction-preview/?theme=${width === 390 ? "dark" : "light"}`;
    await page.goto(url, { waitUntil: "networkidle" });
    const input = page.getByRole("textbox", { name: "Compact after" });
    const save = page.getByRole("button", { name: "Save changes" });
    await input.waitFor();
    assert(await save.isDisabled(), "clean form must not save");
    await page.screenshot({ path: `${output}/default-${width}.png`, fullPage: true });
    await input.fill("900000");
    assert(await save.isDisabled(), "oversized threshold accepted");
    await page.getByText("Enter a whole number from 16,000 to 872,000.").waitFor();
    await page.screenshot({ path: `${output}/invalid-${width}.png`, fullPage: true });
    await input.fill("90000");
    await page.getByRole("combobox").selectOption("synthetic/deep");
    await input.fill("250000");
    await page.getByRole("combobox").selectOption("synthetic/fast");
    assert((await input.inputValue()) === "90000", "switch lost unsaved model draft");
    await page.getByRole("button", { name: "Use model default" }).click();
    assert((await input.inputValue()) === "", "reset did not restore inheritance");
    await save.click();
    const receipt = await page.evaluate(
      () => (window as unknown as { compactionReceipts: unknown[] }).compactionReceipts,
    );
    assert(
      JSON.stringify(receipt) ===
        JSON.stringify([{ modelCompactionThresholds: { "synthetic/deep": 250000 } }]),
      "save included untouched model or lost edit",
    );
    assert(
      (await page.locator("body").getAttribute("data-closed")) === "true",
      "successful save did not close",
    );
    await page.goto(`${url}&role=viewer`, { waitUntil: "networkidle" });
    assert(await input.isDisabled(), "viewer can edit");
    assert(await save.isDisabled(), "viewer can save");
    await page.screenshot({ path: `${output}/viewer-${width}.png`, fullPage: true });
    await page.goto(`${url}&state=override`, { waitUntil: "networkidle" });
    assert((await input.inputValue()) === "90000", "saved override not shown");
    await page.getByRole("button", { name: "Use model default" }).click();
    await input.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.dataset.closed === "true");
    const reset = await page.evaluate(
      () => (window as unknown as { compactionReceipts: unknown[] }).compactionReceipts,
    );
    assert(
      JSON.stringify(reset) ===
        JSON.stringify([{ modelCompactionThresholds: { "synthetic/fast": null } }]),
      "saved override did not reset independently",
    );
    for (const state of ["save-error", "stale"]) {
      await page.goto(`${url}&state=${state}`, { waitUntil: "networkidle" });
      await input.fill("90000");
      await save.click();
      assert(
        (await page.locator("body").getAttribute("data-closed")) !== "true",
        "failed/stale save claimed success",
      );
      assert((await input.inputValue()) === "90000", "failed save lost draft");
      if (state === "save-error")
        await page.getByText("Couldn’t confirm the save.", { exact: false }).waitFor();
    }
    await page.goto(`${url}&state=error`, { waitUntil: "networkidle" });
    await page.getByText("Couldn’t load model preferences.").waitFor();
    assert(await save.isDisabled(), "catalog failure enabled saving");
    await page.getByRole("button", { name: "Try again" }).waitFor();
    assert(
      !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
      "horizontal overflow",
    );
    assert(errors.length === 0, errors.join("; "));
    await page.close();
  }
  console.log(
    "Compaction desktop/mobile default, validation, multi-model draft, reset, save, read-only and stale/error acceptance passed.",
  );
} finally {
  await browser.close();
}
