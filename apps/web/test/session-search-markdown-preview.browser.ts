import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = "/workspace/previews";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1054, height: 766 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto("http://127.0.0.1:4329/test/session-search-markdown-preview.html");
  await page.getByRole("table").waitFor();
  assert.equal(await page.getByRole("table").locator("tbody tr").count(), 3);
  assert.equal(await page.locator("strong").filter({ hasText: "multi-day activity" }).count(), 1);
  await page.waitForFunction(() => CSS.highlights.has("session-search-preview-hit"));
  await page.screenshot({ path: `${output}/session-search-markdown-desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Production activity review/ }).click();
  await page.getByRole("table").waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/session-search-markdown-mobile.png` });
  const tableScroller = page.getByRole("table").locator("..");
  assert(
    await tableScroller.evaluate((element) => element.scrollWidth > element.clientWidth),
    "wide table should scroll horizontally inside the mobile preview",
  );
  await tableScroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await page.screenshot({ path: `${output}/session-search-markdown-mobile-table.png` });
  assert.deepEqual(errors, []);
  console.log(
    "Preview verified: real table, bold text, search highlight, mobile layout, no browser errors.",
  );
} finally {
  await browser.close();
}
