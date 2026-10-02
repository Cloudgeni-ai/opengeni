import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

describe("Developer settings in Chromium", () => {
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
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/test/developer-settings.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  async function open(
    width: number,
    theme: "light" | "dark",
    search = "",
  ): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/test/developer-settings.html${search}`, {
      waitUntil: "networkidle",
    });
    return {
      page,
      close: async () => {
        expect(errors).toEqual([]);
        await context.close();
      },
    };
  }

  async function expectAccessibleAndUnclipped(page: Page) {
    await page.evaluate(async () => {
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      );
    });
    const axe = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
  }

  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      test(`list, a failing webhook test and a provider test at ${width}px (${theme})`, async () => {
        const { page, close } = await open(width, theme);
        const main = page.locator("main");
        await main
          .getByText("Retrying", { exact: true })
          .filter({ visible: true })
          .first()
          .waitFor();
        expect(await main.getByText("An organization webhook also gets").isVisible()).toBe(true);
        expect(await main.getByText("Developer guide").isVisible()).toBe(true);
        await expectAccessibleAndUnclipped(page);

        await main.getByText("staging.product.example/opengeni/events").click();
        await main.getByRole("heading", { name: "Deliveries" }).waitFor();
        expect(await main.getByText("gave up after 12 attempts").isVisible()).toBe(true);
        expect(await main.getByText(/attempt 3 of 12 · next try in \d+ min/).isVisible()).toBe(
          true,
        );
        await main.getByRole("button", { name: "Send test event" }).click();
        await main.getByText("Test event not delivered").waitFor();
        expect(
          await main
            .getByText(/signing secret/)
            .first()
            .isVisible(),
        ).toBe(true);
        await main.getByText("Request and response").click();
        expect(await main.locator('pre[aria-label="Response body"]').textContent()).toContain(
          "invalid signature",
        );
        await expectAccessibleAndUnclipped(page);

        await main.getByRole("button", { name: "Developer" }).first().click();
        await main.getByText("product.example/opengeni/credentials").click();
        await main.getByRole("button", { name: "Test connection" }).click();
        await main.getByText("Connected", { exact: true }).waitFor();
        expect(await main.getByText("GITHUB_TOKEN", { exact: false }).isVisible()).toBe(true);
        const result = await main.locator("[data-slot=endpoint-test-result]").innerText();
        expect(result).toMatch(/They expire in \d+ min/);
        // Names only: the fixture's provider never returns values to the page.
        expect(result).not.toContain("ghs_");
        await expectAccessibleAndUnclipped(page);
        await close();
      }, 60_000);
    }
  }

  test("adding a webhook shows its signing secret once, then opens its page", async () => {
    const { page, close } = await open(1280, "light", "?view=new-webhook");
    const main = page.locator("main");
    await main.getByLabel("Endpoint URL").fill("https://new.example/opengeni/events");
    expect(await main.getByRole("checkbox", { name: /Needs approval/ }).isChecked()).toBe(true);
    await main.getByRole("checkbox", { name: /Usage used up/ }).check();
    await main.getByRole("button", { name: "Add webhook" }).click();
    await main.getByText("Webhook added").waitFor();
    expect(await main.getByText("whsec_fixture_shown_once").isVisible()).toBe(true);
    await expectAccessibleAndUnclipped(page);
    await main.getByRole("button", { name: "I've saved it" }).click();
    await main.getByRole("heading", { name: "new.example/opengeni/events" }).waitFor();
    expect(await main.getByText("whsec_fixture_shown_once").count()).toBe(0);
    await close();
  }, 60_000);
});
