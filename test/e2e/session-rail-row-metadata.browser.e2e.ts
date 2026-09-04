import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const longTitle =
  "Now I am testing your workspace rail and this title should use every available pixel";

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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

  test("opens useful session context promptly without a delayed native tooltip", async () => {
    const row = page.locator('[data-row-case="time-only"]');
    const link = row.locator("a");
    expect(await row.getAttribute("title")).toBeNull();
    expect(await link.getAttribute("title")).toBeNull();
    expect(await row.locator("[data-creator-monogram]").getAttribute("title")).toBeNull();

    const hoveredAt = Date.now();
    await link.hover();
    const hoverCard = page.locator('[data-slot="hover-card-content"]');
    await hoverCard.waitFor({ state: "visible", timeout: 600 });
    expect(Date.now() - hoveredAt).toBeLessThan(600);

    const text = await hoverCard.innerText();
    expect(text).toContain(longTitle);
    expect(text).toContain("Created by Bendik Nyheim");
    expect(text).toContain("3 sub-agents");
    expect(text).not.toContain("Idle");
    expect(text).not.toContain("Read");

    const rowBox = await row.boundingBox();
    const cardBox = await hoverCard.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.x).toBeGreaterThan(rowBox!.x + rowBox!.width);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(1280);
  });

  test("reveals direct pin and archive controls on hover and keyboard focus", async () => {
    const row = page.locator('[data-row-case="time-only"]');
    const link = row.locator("a");
    const quickActions = row.locator('[data-session-quick-actions="quick-actions"]');

    await page.mouse.move(1000, 700);
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "0";
    });
    expect(await quickActions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");

    await link.hover();
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "1";
    });
    await row.getByRole("button", { name: "Pin session", exact: true }).waitFor();
    await row.getByRole("button", { name: "Archive session", exact: true }).waitFor();
    await page.screenshot({
      path: "/tmp/opengeni-session-row-quick-actions.png",
      fullPage: true,
    });

    await page.mouse.move(1000, 700);
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "0";
    });
    const pinButton = row.getByRole("button", { name: "Pin session", exact: true });
    await pinButton.focus();
    await page.waitForFunction(() => {
      const actions = document.querySelector('[data-session-quick-actions="quick-actions"]');
      return actions instanceof HTMLElement && getComputedStyle(actions).opacity === "1";
    });
    await pinButton.press("Enter");
    await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
    await row.getByRole("button", { name: "Archive session", exact: true }).click();
    await row.getByRole("button", { name: "Restore session", exact: true }).waitFor();
    expect(await row.getByRole("button", { name: "Pin session" }).count()).toBe(0);
  });
});
