import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

describe("Session rail row metadata in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/test/session-rail-row-metadata.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 900, height: 640 } });
    await page.goto(`${baseUrl}/test/session-rail-row-metadata.html`, { waitUntil: "networkidle" });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("contains every production-width row and keeps titles clear of real metadata", async () => {
    const rail = page.getByTestId("production-session-rail");
    expect((await rail.boundingBox())?.width).toBe(244);
    expect(await rail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    for (const id of [
      "time-only",
      "status-time",
      "schedule-date",
      "no-metadata",
      "selected-child",
      "unselected-child",
    ]) {
      const row = page.locator(`[data-row-case="${id}"]`);
      const link = row.locator("a");
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await link.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await link.getAttribute("aria-label")).toContain(
        "Now I am testing your workspace rail",
      );

      const metadata = row.locator("[data-session-row-metadata]");
      if ((await metadata.count()) === 0) continue;
      const titleBox = await row.locator("[data-session-row-title]").boundingBox();
      const metadataBox = await metadata.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(metadataBox).not.toBeNull();
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(metadataBox!.x + 0.5);
    }
  });

  test("uses more title width whenever status, schedule, or all metadata is absent", async () => {
    const width = async (id: string) =>
      (await page.locator(`[data-row-case="${id}"] [data-session-row-title]`).boundingBox())!.width;

    expect(await width("time-only")).toBeGreaterThan(await width("status-time"));
    expect(await width("no-metadata")).toBeGreaterThan(await width("time-only"));
    expect(await width("selected-child")).toBeLessThan(await width("time-only"));
    expect(await page.locator('[data-row-case="selected-child"]').getAttribute("class")).toContain(
      "bg-surface-3",
    );
  });
});
