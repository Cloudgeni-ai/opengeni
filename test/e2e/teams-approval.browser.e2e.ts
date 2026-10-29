import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("Microsoft approval dialog (local fixture)", () => {
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
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        env: { VITE_API_BASE_URL: "" },
        ready: async () =>
          (
            await fetch(`${baseUrl}/test/teams-approval.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("approval is concise, copies the safe link, retries fresh and fits mobile", async () => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await page.goto(baseUrl + "/test/teams-approval.html");
      await page.getByRole("button", { name: "Connect Teams", exact: true }).click();
      await page.getByRole("button", { name: "Copy approval link" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=fixture&scope=offline_access",
      );
      await page.getByRole("button", { name: "Try signing in again" }).click();
      await page.waitForFunction(() => document.body.dataset.begins === "2");
      expect(await page.locator("body").getAttribute("data-idempotency-key")).not.toBe("fixture");
      for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        expect(
          await page.evaluate(() =>
            document.querySelector('[role="dialog"]')?.contains(document.activeElement),
          ),
        ).toBe(true);
      }
      expect(await page.getByText("Personal connection", { exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .locator('[role="dialog"] img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth > 0),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.body.dataset.closed === "true");
      await page.waitForFunction(() => document.activeElement?.textContent === "Connect Teams");
      await page.goto(baseUrl + "/test/teams-approval.html?required=false");
      await page.getByRole("button", { name: "Connect Teams", exact: true }).click();
      await page.getByText("Microsoft didn't grant access.", { exact: false }).waitFor();
      expect(await page.getByText("If it asked for admin approval", { exact: false }).count()).toBe(
        1,
      );
    } finally {
      await context.close();
    }
  }, 30_000);
});
