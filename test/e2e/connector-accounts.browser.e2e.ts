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

  test("connector controls load on demand and preserve Back while loading", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10_000);
    let release!: () => void;
    const moduleReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let moduleRequests = 0;
    await page.route(
      /\/src\/components\/session-connectors-menu-body\.tsx(?:\?|$)/,
      async (route) => {
        moduleRequests++;
        await moduleReady;
        await route.continue();
      },
    );
    try {
      await page.goto(`${baseUrl}/test/connector-menu.html`);
      const trigger = page.getByRole("button", { name: "More composer actions" });
      await trigger.waitFor();
      expect(moduleRequests).toBe(0);
      await trigger.click();
      await page.getByRole("menuitem", { name: /Connectors/ }).click();
      await page.getByText("Loading connectors…", { exact: true }).waitFor();
      expect(moduleRequests).toBe(1);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("menuitem", { name: /Connectors/ }).waitFor();
      release();
      await page.getByRole("menuitem", { name: /Connectors/ }).click();
      await page.getByRole("menuitem", { name: "Slack account settings" }).waitFor();
      expect(await page.getByText("Loading connectors…", { exact: true }).count()).toBe(0);
    } finally {
      release();
      await page.close();
    }
  }, 45_000);

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`Customize removes a disconnected connector without reconnecting at ${viewport.width}px`, async () => {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(15_000);
      try {
        await page.goto(`${baseUrl}/test/connector-menu.html`);
        await page.getByRole("button", { name: "More composer actions" }).click();
        await page.getByRole("menuitem", { name: /Connectors/ }).click();
        await page.getByRole("switch", { name: "Customize connectors" }).click();
        const connector = page.getByRole("menuitemcheckbox", { name: "Linear", exact: true });
        expect(await connector.getAttribute("aria-checked")).toBe("true");
        if (process.env.CONNECTOR_SCREENSHOT_DIR) {
          await page.screenshot({
            path: `${process.env.CONNECTOR_SCREENSHOT_DIR}/connector-unavailable-${viewport.width}.png`,
            animations: "disabled",
          });
        }
        await connector.focus();
        await page.keyboard.press("Space");
        await page.getByRole("menuitem", { name: "Reconnect Linear" }).waitFor();
        expect(await connector.count()).toBe(0);
        expect(await page.getByRole("status", { includeHidden: true }).textContent()).toBe(
          "Preview connections use sample data.",
        );
        expect(
          await page
            .getByRole("menuitemcheckbox", { name: "Slack", exact: true })
            .getAttribute("aria-checked"),
        ).toBe("true");
      } finally {
        await page.close();
      }
    }, 45_000);
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
        await page.getByRole("menuitem", { name: "Connect another account" }).click();
        await page.getByText("Account setup opened (simulated).").waitFor();
      } finally {
        await page.close();
      }
    }, 45_000);
  }
});
