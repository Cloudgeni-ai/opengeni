import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = "/workspace/previews";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const errors: string[] = [];
const verified: string[] = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:4330/test/session-discovery-preview.html?theme=${theme}`);
      const recent = page.getByRole("heading", { name: "Recent sessions" }).locator("..");
      await recent.waitFor();
      assert.equal(await recent.getByRole("link").count(), 6);
      assert.equal(await recent.getByText("Release CI review").count(), 0);
      assert.equal(await recent.getByText("Release browser checks").count(), 0);
      assert(
        await page.evaluate(() => {
          const evidence = (window as any).discoveryEvidence;
          return evidence.titles.some(
            (request: any) => request.limit === 12 && request.parentSessionId === null,
          );
        }),
      );
      await recent.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/recent-parents-${theme}-${width}.png` });
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("searchbox").fill("release");
      await page.waitForFunction(
        () => document.querySelectorAll("[data-search-result]").length === 3,
      );
      await dialog
        .getByText("Assistant · Matching passage", { exact: true })
        .waitFor({ state: "attached" });
      assert.equal(
        await dialog
          .getByRole("radio", { name: "Parent sessions", exact: true })
          .getAttribute("aria-checked"),
        "true",
      );
      assert(
        await page.evaluate(() => {
          const evidence = (window as any).discoveryEvidence;
          return evidence.messages.some(
            (request: any) => !request.sessionId && request.parentSessionId === null,
          );
        }),
      );
      await page.screenshot({ path: `${output}/search-parents-${theme}-${width}.png` });
      await dialog.getByRole("radio", { name: "All sessions", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-search-result]").length === 5,
      );
      assert(await dialog.getByText("Release CI review").isVisible());
      assert(
        await page.evaluate(() => {
          const evidence = (window as any).discoveryEvidence;
          return evidence.messages.some(
            (request: any) => !request.sessionId && !("parentSessionId" in request),
          );
        }),
      );
      await page.screenshot({ path: `${output}/search-all-${theme}-${width}.png` });
      await dialog.getByRole("radio", { name: "Parent sessions", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-search-result]").length === 3,
      );
      await dialog.getByRole("radio", { name: "Parent sessions", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.activeElement?.textContent === "All sessions");
      await page.keyboard.press("Space");
      await page.waitForFunction(
        () => document.querySelectorAll("[data-search-result]").length === 5,
      );
      const bounds = await dialog.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width < 768) {
        await dialog.locator("[data-search-result]").first().click();
        await dialog.getByRole("button", { name: "Open here", exact: true }).waitFor();
        await page.screenshot({ path: `${output}/search-context-${theme}-${width}.png` });
        await dialog.getByRole("button", { name: "Back to search results" }).click();
        assert(await dialog.locator("[data-search-result]").first().isVisible());
      }
      verified.push(
        `${theme} ${width}px: roots-only Recent; default parent search; all-session toggle; keyboard; no overflow; mobile context`,
      );
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified, errors, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
