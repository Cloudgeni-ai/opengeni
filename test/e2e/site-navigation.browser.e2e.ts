import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser, type Page } from "playwright";

// Real Artifacts page, Site view and workspace panel (apps/web/test/site-navigation-fixture.tsx);
// only the API is answered in memory.
const workspaceId = "11111111-1111-4111-8111-111111111111";
const pricingSiteId = "00000000-0000-4000-a000-000000000003";
const sessionPath = `/workspaces/${workspaceId}/sessions/00000000-0000-4000-9000-000000000901`;

describe("Site navigation", () => {
  let browser: Browser;
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
        "--config",
        "test/session-sidebar-preview.vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        ready: async () =>
          (await fetch(`${baseUrl}/test/site-navigation.html`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  async function open(page: Page, entry: string, query = "") {
    await page.goto(
      `${baseUrl}/test/site-navigation.html?scenario=sites&publish=1&${query}&entry=${encodeURIComponent(entry)}`,
    );
  }
  /** The Artifacts page's scroll position: its scrolling ancestor of the cards. */
  const listScroll = (page: Page) =>
    page
      .getByText("Launch checklist", { exact: true })
      .first()
      .evaluate((card) => {
        let element: HTMLElement | null = card as HTMLElement;
        while (
          element &&
          !(
            element.scrollHeight > element.clientHeight + 1 &&
            /auto|scroll/u.test(getComputedStyle(element).overflowY)
          )
        )
          element = element.parentElement;
        return element?.scrollTop ?? -1;
      });

  test("a Site opened from the Artifacts page goes back to it as it was", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 560 } });
    try {
      await open(page, `/workspaces/${workspaceId}/artifacts?sort=title`);
      const card = page.getByText("Pricing calculator", { exact: true }).first();
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const scrolled = await listScroll(page);
      expect(scrolled).toBeGreaterThan(0);

      // Opening a Site keeps the page's query in the Site view's address...
      await card.click();
      await page.waitForURL(new RegExp(`/sites/${pricingSiteId}\\?`, "u"));
      expect(new URL(page.url()).searchParams.get("sort")).toBe("title");
      // ...and the Site's toolbar starts with Back to it, a real link.
      const back = page.getByRole("link", { name: "Back to Artifacts" });
      await back.waitFor();
      expect(await back.getAttribute("href")).toBe(
        `/workspaces/${workspaceId}/artifacts?sort=title`,
      );
      await page.frameLocator("iframe").first().locator("body").waitFor();

      // Back returns to the page with its sort and its scroll.
      await back.click();
      await page.waitForURL(/\/artifacts\?sort=title$/u);
      await page.getByText("Pricing calculator", { exact: true }).first().waitFor();
      let restored = -1;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        restored = await listScroll(page);
        if (Math.abs(restored - scrolled) <= 2) break;
        await page.waitForTimeout(100);
      }
      expect(Math.abs(restored - scrolled)).toBeLessThanOrEqual(2);

      // The browser's (and the desktop app's) Back goes there too.
      await page.getByText("Pricing calculator", { exact: true }).first().click();
      await page.waitForURL(/\/sites\//u);
      await page.goBack();
      await page.waitForURL(/\/artifacts\?sort=title$/u);
      await page.getByText("Pricing calculator", { exact: true }).first().waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a Site opened another way has no Back to Artifacts", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await open(page, `/workspaces/${workspaceId}/sites/${pricingSiteId}`);
      await page.frameLocator("iframe").first().locator("body").waitFor();
      expect(await page.getByRole("link", { name: "Back to Artifacts" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a Site in the workspace panel has one expand, and it opens the Site's full window", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const expands = () =>
      page.locator("button").evaluateAll((buttons) =>
        buttons
          .filter((button) => button.getClientRects().length > 0)
          .map((button) => button.getAttribute("aria-label") ?? "")
          .filter((label) => /maximi[sz]e|expand|full/iu.test(label)),
      );
    try {
      await open(page, sessionPath);
      await page.frameLocator("iframe").first().locator("body").waitFor();
      expect(await expands()).toEqual(["Expand Site to full window"]);
      const expand = page.getByRole("button", { name: "Expand Site to full window" });
      expect(await expand.getAttribute("title")).toBe("Expand Site to full window");

      // It fills the window with the Site; Esc comes back.
      await expand.click();
      const site = page.locator("dialog[data-artifact-fullscreen]");
      await site.waitFor();
      const box = await site.boundingBox();
      expect(box?.width).toBe(1440);
      await page.keyboard.press("Escape");
      await site.waitFor({ state: "detached" });

      // The other panels keep the dock's own Maximize.
      await page.getByRole("tab", { name: "Files" }).click();
      expect(await expands()).toEqual(["Maximize dock"]);
      await page.getByRole("tab", { name: "Artifacts" }).click();
      expect(await expands()).toEqual(["Expand Site to full window"]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
