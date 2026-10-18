import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// Serve the real components with test/workspace-commands-preview.vite.config.ts.
const base =
  process.env.PREVIEW_URL ?? "http://127.0.0.1:3189/test/workspace-commands-preview.html";
const output = process.env.PREVIEW_OUTPUT;
if (!output) throw new Error("Set PREVIEW_OUTPUT to the screenshot output directory");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.PREVIEW_CHROMIUM ? { executablePath: process.env.PREVIEW_CHROMIUM } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height },
      isMobile: name === "mobile",
      hasTouch: name === "mobile",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const region = page.getByRole("region", { name: "Running commands" });
    await region.getByRole("link", { name: "Preview the customer portal", exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: /^Stop / }).count(), 3);
    assert(
      (
        await region
          .getByRole("link", { name: "Preview the customer portal", exact: true })
          .getAttribute("href")
      )?.includes("/sessions/33333333-3333-4333-8333-333333333330"),
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    await region.locator("summary").nth(1).click();
    await region
      .getByRole("button", { name: "Stop bun run start --host 0.0.0.0", exact: true })
      .click();
    await region.getByText("Stopping…", { exact: true }).waitFor();
    assert(
      await region
        .getByRole("button", { name: "Stop bun run start --host 0.0.0.0", exact: true })
        .isDisabled(),
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(`${base}?state=readonly`);
    await region
      .getByText("You can view commands, but do not have permission to stop them.")
      .waitFor();
    assert.equal(await region.getByRole("button", { name: /^Stop / }).count(), 0);
    await page.goto(`${base}?state=empty`);
    await region.getByText("No background commands running.", { exact: true }).waitFor();
    await page.goto(`${base}?state=loading`);
    await region.getByText("Loading commands…", { exact: true }).waitFor();
    await page.goto(`${base}?state=error`);
    await region.getByText("Commands unavailable.", { exact: true }).waitFor();
    await region.getByRole("button", { name: "Retry", exact: true }).click();
    await region.getByRole("link", { name: "Preview the customer portal", exact: true }).waitFor();
    await page.goto(`${base}?state=stop-error`);
    await region
      .getByRole("button", { name: "Stop bun run start --host 0.0.0.0", exact: true })
      .click();
    await region.getByRole("alert").waitFor();
    assert.equal(await region.getByRole("button", { name: /^Stop / }).count(), 3);
    assert.equal(
      await region
        .getByRole("button", { name: "Stop bun run start --host 0.0.0.0", exact: true })
        .isDisabled(),
      false,
    );
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `${name}: layout, command disclosure, chat link, stop, read-only, empty, loading, retry and stop failure passed`,
    );
  }
} finally {
  await browser.close();
}
