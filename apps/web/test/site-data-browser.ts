// Run with: bun apps/web/test/site-data-browser.ts
// Captures the production Site page Data tab with sample data at desktop and narrow widths.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { freePort, startProcess } from "@opengeni/testing";

const port = Number(process.env.OPENGENI_SITE_DATA_PORT) || (await freePort());
const baseUrl = `http://127.0.0.1:${port}`;
const output = process.env.OPENGENI_SITE_DATA_SCREENSHOTS ?? "/workspace/.agent/site-data";
await mkdir(output, { recursive: true });
const web = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "dev",
    ".",
    "--config",
    "test/site-data.vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () =>
      (await fetch(`${baseUrl}/test/site-data.html`).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
});
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/test/site-data.html`, { waitUntil: "networkidle" });
    // The first load pays Vite's cold transforms, slow on a busy machine.
    const tab = page.getByRole("tab", { name: "Data", exact: true });
    await tab.waitFor({ timeout: 90_000 }).catch(async (error: unknown) => {
      await page.screenshot({ path: `${output}/failure-${width}.png`, animations: "disabled" });
      console.error(errors, (await page.locator("body").innerText()).slice(0, 2000));
      throw error;
    });
    await tab.click();
    const contacts = page.getByRole("button", { name: /contacts/ });
    await contacts.first().waitFor();
    await page.getByRole("switch", { name: "SQL database" }).waitFor();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(await overflow(), false, "overview has no horizontal overflow");
    await page.screenshot({ path: `${output}/data-overview-${width}.png`, animations: "disabled" });
    await contacts.first().click();
    await page.getByRole("button", { name: "Load more records", exact: true }).waitFor();
    await page.screenshot({
      path: `${output}/data-collection-${width}.png`,
      animations: "disabled",
    });
    await page.locator("[data-slot=list-row]").first().getByRole("button").first().click();
    await page.locator("pre").first().waitFor();
    assert.equal(await overflow(), false, "record view has no horizontal overflow");
    await page.screenshot({ path: `${output}/data-record-${width}.png`, animations: "disabled" });
    assert.deepEqual(errors, [], "page renders without errors");
    await context.close();
  }
} finally {
  await browser.close();
  await web.stop();
}
