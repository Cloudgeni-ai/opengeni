import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser } from "playwright";

describe("completed machine setup in the shared conversation", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  const errors: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      ["bun", "run", "vite", ".", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: new URL("../../packages/react/demo", import.meta.url).pathname,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      "/opt/google/chrome/chrome",
      "/usr/local/bin/chromium",
    ].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }, 60_000);

  afterAll(async () => {
    try {
      expect(errors).toEqual([]);
    } finally {
      await Promise.allSettled([browser?.close(), web?.stop()]);
    }
  });

  for (const width of [320, 390, 1280]) {
    for (const theme of ["light", "dark"]) {
      test(`Allow collapses setup and navigation stays outside content at ${width}px ${theme}`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 560 },
          isMobile: width < 500,
          hasTouch: width < 500,
        });
        try {
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${baseUrl}/machine-card.html?state=requested&theme=${theme}`);
          await page.getByRole("button", { name: "Allow", exact: true }).click();
          const summary = page.locator("[data-machine-confirmation]");
          await summary.waitFor();
          expect(await summary.innerText()).toContain("Using Studio desktop");
          expect(await page.locator("[data-machine-setup]").isVisible()).toBe(false);
          expect(await page.getByRole("button", { name: "Connect another computer" }).count()).toBe(
            0,
          );

          const settings = page.getByRole("button", { name: "Machine settings", exact: true });
          await settings.focus();
          await settings.press("Enter");
          expect(await settings.getAttribute("aria-expanded")).toBe("true");
          expect(await page.locator("[data-machine-setup]").isVisible()).toBe(true);
          expect(await page.getByRole("button", { name: "Connect another computer" }).count()).toBe(
            1,
          );
          await page.locator("[data-og-timeline-scroller]").evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            element.dispatchEvent(new Event("scroll"));
          });
          await page.locator("[data-og-question-nav]").waitFor({ timeout: 5_000 });
          const layout = await page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
            const content = scroller.getBoundingClientRect();
            const arrows = [
              ...document.querySelectorAll<HTMLElement>("[data-og-timeline-nav] button"),
            ];
            return {
              arrows: arrows.length,
              outside: arrows.every(
                (arrow) => arrow.getBoundingClientRect().left - 6 >= content.right,
              ),
              overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
          });
          expect(layout.arrows).toBeGreaterThan(0);
          expect(layout.outside).toBe(true);
          expect(layout.overflow).toBe(false);
          await settings.press("Enter");
          expect(await page.locator("[data-machine-setup]").isVisible()).toBe(false);
        } finally {
          await context.close();
        }
      }, 30_000);
    }
  }
});
