import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const output = process.env.PREVIEW_OUTPUT ?? "/workspace/ope557-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = "http://127.0.0.1:4317/test/retained-text-preview.html";
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  await check("actual route and highlighted patch with real SDK checksum", async () => {
    await page.goto(base);
    await page.getByText("Read-only source").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector("diffs-container")
        ?.shadowRoot?.textContent?.includes("+Read the proposed changes"),
    );
    await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  });
  await check("plain text preserves exact patch and keyboard focus", async () => {
    await page.getByRole("button", { name: "Plain text", exact: true }).click();
    assert(
      (await page.getByLabel("File contents").textContent())?.includes(
        "-Download the artifact to read the proposed changes.\n+Read the proposed changes in the artifact panel.",
      ),
    );
    await page.getByLabel("File contents").focus();
    assert(await page.getByLabel("File contents").evaluate((el) => el === document.activeElement));
  });
  await check("Download remains usable", async () => {
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), "ope551-integration-docs.patch");
    assert.equal(await download.failure(), null);
  });
  await check("390px responsive plain text without page overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/narrow.png`, fullPage: true });
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  for (const [state, message] of [
    ["loading", "Loading preview…"],
    ["large", "256 KiB limit"],
    ["binary", "binary or control data"],
    ["encoding", "not UTF-8 text"],
    ["unsupported", "Preview is not available"],
    ["checksum", "Preview could not be loaded"],
  ]) {
    await check(`${state} state`, async () => {
      await page.goto(`${base}?state=${state}`);
      await page.getByText(message!, { exact: false }).waitFor();
      if (state === "large" || state === "unsupported")
        assert.equal(
          await page.evaluate(() =>
            (window as unknown as { previewCalls: () => number }).previewCalls(),
          ),
          0,
        );
      await page.screenshot({ path: `${output}/${state}.png`, fullPage: true });
    });
  }
  await check("403 error and retry recovery", async () => {
    await page.goto(`${base}?state=error`);
    await page.getByText("Preview could not be loaded.", { exact: false }).waitFor();
    await page.screenshot({ path: `${output}/error.png`, fullPage: true });
    await page.getByRole("button", { name: "Retry preview" }).click();
    await page.getByText("Read-only source").waitFor();
  });
  await check("inert HTML source", async () => {
    let dialogs = 0;
    page.on("dialog", async (dialog) => {
      dialogs++;
      await dialog.dismiss();
    });
    await page.goto(`${base}?state=html`);
    await page.getByRole("button", { name: "Plain text", exact: true }).click();
    assert((await page.getByLabel("File contents").textContent())?.startsWith("<script>"));
    assert.equal(await page.locator("h1").filter({ hasText: "This is source" }).count(), 0);
    assert.equal(dialogs, 0);
  });
  for (const scope of ["chat", "standalone"])
    await check(`${scope} remains download-only`, async () => {
      await page.goto(`${base}?${scope}`);
      await page.getByText("Preview is not available", { exact: false }).waitFor();
      assert.equal(await page.getByText("Read-only source").count(), 0);
      assert.equal(
        await page.evaluate(() =>
          (window as unknown as { previewCalls: () => number }).previewCalls(),
        ),
        0,
      );
    });
  await check("light theme and forced-colors keyboard access", async () => {
    await page.goto(`${base}?light`);
    await page.locator("[data-opengeni-pierre-file] diffs-container").waitFor();
    await page.screenshot({ path: `${output}/light.png`, fullPage: true });
    await page.emulateMedia({ forcedColors: "active" });
    await page.getByRole("button", { name: "Plain text", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("File contents").waitFor();
    await page.screenshot({ path: `${output}/forced-colors.png`, fullPage: true });
  });
  await check("actual workbench container desktop and narrow", async () => {
    await page.emulateMedia({ forcedColors: "none" });
    await page.goto(`${base}?workbench`);
    await page
      .getByRole("link", { name: "Open ope551-integration-docs.patch full-page" })
      .waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector("diffs-container")
        ?.shadowRoot?.textContent?.includes("+Read the proposed changes"),
    );
    await page.screenshot({ path: `${output}/workbench-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Plain text", exact: true }).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/workbench-narrow.png`, fullPage: true });
  });
  assert.deepEqual(errors, []);
  console.log(`${passed} browser groups passed; zero page errors`);
} finally {
  await browser.close();
}
