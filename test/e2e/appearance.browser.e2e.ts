import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

describe("Appearance in Chromium", () => {
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
            await fetch(`${baseUrl}/test/appearance.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1120, height: 760 } });
    page = await context.newPage();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  async function openAppearance() {
    const trigger = page.getByRole("button", {
      name: "Example user",
      exact: true,
      includeHidden: true,
    });
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await page.getByRole("menuitemradio", { name: "Light", exact: true }).waitFor();
  }

  async function theme(value: string) {
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.ogTheme === expected,
      value,
    );
    expect(await page.locator("html").evaluate((el) => el.classList.contains("dark"))).toBe(
      value === "dark",
    );
  }

  test("saved choices, live system changes, keyboard and cross-tab synchronization", async () => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${baseUrl}/test/appearance.html`);
    await theme("light");
    await openAppearance();
    expect(
      await page
        .getByRole("menuitemradio", { name: "System", exact: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
    await theme("dark");
    await page.reload();
    await theme("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await theme("dark");
    await openAppearance();
    await page.getByRole("menuitemradio", { name: "Light", exact: true }).focus();
    await page.keyboard.press("Enter");
    await theme("light");
    await openAppearance();
    await page.getByRole("menuitemradio", { name: "System", exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await theme("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await theme("light");
    const other = await page.context().newPage();
    await other.goto(`${baseUrl}/test/appearance.html`);
    await other.evaluate(() => localStorage.setItem("opengeni.appearance", "dark"));
    await theme("dark");
    await other.evaluate(() => localStorage.clear());
    await theme("light");
    await other.close();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Show notification" }).click();
    expect(await page.locator("[data-sonner-toaster]").getAttribute("data-sonner-theme")).toBe(
      "light",
    );
  });

  test("desktop and narrow menus fit the viewport in both palettes", async () => {
    for (const width of [1120, 390]) {
      await page.setViewportSize({ width, height: 760 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.goto(`${baseUrl}/test/appearance.html`);
        const accessibility = await new AxeBuilder({ page })
          .withRules(["color-contrast"])
          .analyze();
        expect(accessibility.violations).toEqual([]);
        await openAppearance();
        const menu = page.getByRole("menuitemradio", { name: "System", exact: true });
        const box = (await menu.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: `/tmp/opengeni-appearance-${width}-${colorScheme}.png` });
      }
    }
  });
});
