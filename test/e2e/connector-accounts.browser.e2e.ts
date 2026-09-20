import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("composer connector account controls (local fixture)", () => {
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
            await fetch(`${baseUrl}/test/connector-menu.html`, {
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

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`multiple accounts can be narrowed with keyboard and pointer at ${viewport.width}px`, async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.goto(`${baseUrl}/test/connector-menu.html`);
        await page.getByRole("button", { name: "More composer actions" }).click();
        await page.getByRole("menuitem", { name: /Connectors/ }).click();
        await page.getByRole("menuitem", { name: "Slack account settings" }).click();
        const personal = page.getByRole("menuitemcheckbox", { name: "alex@example.com, Only me" });
        const workspace = page.getByRole("menuitemcheckbox", {
          name: "Support team, This workspace",
        });
        expect(await personal.getAttribute("aria-checked")).toBe("true");
        expect(await workspace.getAttribute("aria-checked")).toBe("true");
        await personal.focus();
        await page.keyboard.press("Space");
        expect(await personal.getAttribute("aria-checked")).toBe("false");
        expect(await workspace.getAttribute("aria-checked")).toBe("true");
        await page.getByRole("button", { name: "Back to connectors" }).click();
        await page.getByRole("menuitem", { name: "Slack account settings" }).click();
        expect(await personal.getAttribute("aria-checked")).toBe("false");
        await workspace.click();
        await page.getByText("Attach an account or turn off this connector.").waitFor();
        await personal.click();
        expect(await personal.getAttribute("aria-checked")).toBe("true");
        expect(await workspace.getAttribute("aria-checked")).toBe("false");
        if (process.env.CONNECTOR_SCREENSHOT_DIR) {
          await page.screenshot({
            path: `${process.env.CONNECTOR_SCREENSHOT_DIR}/connector-accounts-${viewport.width}.png`,
            animations: "disabled",
          });
        }
        const menu = await page.getByRole("menu").boundingBox();
        expect(menu!.x).toBeGreaterThanOrEqual(0);
        expect(menu!.x + menu!.width).toBeLessThanOrEqual(viewport.width);
      } finally {
        await page.close();
      }
    }, 45_000);
  }
});
