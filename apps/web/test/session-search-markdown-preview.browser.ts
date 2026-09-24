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
  await page.waitForFunction(() => CSS.highlights.size > 0);
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

  await page.setViewportSize({ width: 1054, height: 766 });
  await page.goto("http://127.0.0.1:4329/test/session-search-markdown-preview.html?repeat");
  await page.waitForFunction(() => CSS.highlights.size > 0);
  assert(
    await page.evaluate(() => {
      const highlight = CSS.highlights.values().next().value;
      const range = highlight?.values().next().value as Range | undefined;
      return Boolean(range?.startContainer.parentElement?.closest("table"));
    }),
    "the selected second occurrence should highlight the table cell, not the earlier mention",
  );

  let remoteImages = 0;
  await page.route("https://example.invalid/**", (route) => {
    remoteImages++;
    void route.abort();
  });
  await page.goto("http://127.0.0.1:4329/test/session-search-markdown-preview.html?image");
  await page.getByText("tracking (preview unavailable)").waitFor({ state: "attached" });
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(remoteImages, 0);

  await page.goto("http://127.0.0.1:4329/test/session-search-markdown-preview.html?imagehit");
  await page.getByText("Match in message source:", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => CSS.highlights.size), 0);
  assert(await page.locator("mark").filter({ hasText: "preview" }).count());

  await page.goto("http://127.0.0.1:4329/test/session-search-markdown-preview.html?code");
  await page.waitForFunction(() => CSS.highlights.size > 0);
  assert(
    await page.locator('pre[tabindex="0"]').evaluate((element) => element.scrollLeft > 0),
    "the selected hit on a long code line should scroll into view",
  );

  const fallback = await browser.newPage({ viewport: { width: 1054, height: 766 } });
  await fallback.addInitScript(() => {
    Object.defineProperty(globalThis, "Highlight", { value: undefined, configurable: true });
  });
  await fallback.goto("http://127.0.0.1:4329/test/session-search-markdown-preview.html");
  await fallback.getByText("Assistant · Matching passage").waitFor();
  assert.equal(await fallback.getByRole("table").count(), 1);
  assert(await fallback.getByText("Match in message source:", { exact: false }).count());
  assert(await fallback.locator("mark").count());
  await fallback.close();

  assert.deepEqual(errors, []);
  console.log(
    "Preview verified: real table, bold text, search highlight, mobile layout, no browser errors.",
  );
} finally {
  await browser.close();
}
