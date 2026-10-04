import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = process.env.PREVIEW_OUTPUT ?? "/workspace/model-quota-preview-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = "http://127.0.0.1:4331/test/model-quota-preview.html";
try {
  for (const [state, headline] of [
    ["recovering", "High demand right now"],
    ["unavailable", "This model is temporarily unavailable"],
    ["rate-limit", "This model is throttled due to high demand. Choose another model"],
    ["quota", "The model provider's usage quota for this model is used up"],
    ["daily", "This model's daily limit has been reached"],
    ["credits", "This workspace is out of Opengeni credits"],
  ]) {
    await page.goto(`${base}?state=${state}`);
    await page.getByText(headline!, { exact: false }).waitFor();
    assert.equal((await page.getByText("GPT-6 Luna", { exact: false }).count()) > 0, true);
    await page.screenshot({ path: `${output}/${state}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${state}-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 1200, height: 800 });
    console.log(`PASS ${state}: desktop and phone`);
  }
  await page.goto(`${base}?state=recovering`);
  await page.getByText("Your message is saved", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page.getByTestId("model-picker-choice-gpt-6-sol").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pause preview", exact: true }).click();
  assert.equal(await page.locator("[data-model-recovery-notice]").count(), 0);
  await page.getByRole("button", { name: "Unpause preview", exact: true }).click();
  await page.locator("[data-model-recovery-notice]").waitFor();
  await page.getByRole("button", { name: "Resume preview", exact: true }).click();
  assert.equal(await page.locator("[data-model-recovery-notice]").count(), 0);
  console.log("PASS recovery: no duplicate retry, hides on pause and resume");

  await page.goto(`${base}?state=quota&light`);
  const banner = page.locator('[data-testid="failed-session-banner"]');
  await banner.waitFor();
  assert(await banner.textContent().then((text) => text?.includes("Choose another model below.")));
  assert.equal(await banner.locator("details").getAttribute("open"), null);
  await banner.locator("summary").click();
  assert.equal(await banner.locator("details p").textContent(), "429 insufficient_quota");
  await page.screenshot({ path: `${output}/quota-light-details.png`, fullPage: true });
  await page.getByRole("button", { name: "Model and effort", exact: true }).click();
  await page.getByTestId("model-picker-choice-gpt-6-sol").click();
  await page.keyboard.press("Escape");
  assert(await banner.textContent().then((text) => !text?.includes("Choose another model below.")));
  assert.equal((await page.getByText("GPT-6 Sol", { exact: false }).count()) > 0, true);
  await page.getByRole("textbox").fill("Unsent follow-up");
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
  await page.getByRole("textbox").fill("");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal(await page.locator('[data-testid="failed-session-banner"]').count(), 0);
  console.log("PASS quota: folded evidence, model switch, draft guard and explicit recovery");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
