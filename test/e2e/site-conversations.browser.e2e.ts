import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

describe("Site conversation navigation", () => {
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
          (await fetch(`${baseUrl}/test/site-conversations.html`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  for (const theme of ["light", "dark"])
    test(`${theme}: linked origin, group disclosure, paginated/searchable host sheet`, async () => {
      const errors: string[] = [];
      const onError = (error: Error) => errors.push(error.message);
      page.on("pageerror", onError);
      try {
        await page.goto(`${baseUrl}/test/site-conversations.html`, { waitUntil: "networkidle" });
        await page.evaluate((selectedTheme) => {
          document.documentElement.dataset.ogTheme = selectedTheme;
          document.documentElement.style.colorScheme = selectedTheme;
        }, theme);
        const originLinks = page.getByRole("link", {
          name: "Created through Product analytics. Open Site",
        });
        expect(await originLinks.count()).toBe(2);
        expect(await originLinks.first().getAttribute("href")).toContain(
          "/artifacts/22222222-2222-4222-8222-222222222222",
        );
        const disclosure = page.getByRole("button", {
          name: "Expand conversations from Product analytics",
        });
        await disclosure.focus();
        await page.keyboard.press("Enter");
        expect(
          await page
            .getByRole("button", { name: "Collapse conversations from Product analytics" })
            .getAttribute("aria-expanded"),
        ).toBe("true");
        await page.getByRole("button", { name: "Conversations", exact: true }).click();
        await page.getByRole("link", { name: "Review conversion trends" }).waitFor();
        await page.getByRole("button", { name: "Load older conversations" }).click();
        await page.getByRole("link", { name: "Investigate onboarding drop-off" }).waitFor();
        await page.getByRole("textbox", { name: "Search Site conversations" }).fill("conversion");
        await page
          .getByRole("link", { name: "Explain last week’s activity" })
          .waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Archived", exact: true }).click();
        await page.getByText("No matching conversations.").waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        expect(errors).toEqual([]);
      } finally {
        page.off("pageerror", onError);
      }
    }, 30_000);
});
