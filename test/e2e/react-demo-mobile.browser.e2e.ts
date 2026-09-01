import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("React Session SDK showcase", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
    demo = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "demo",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
        "--force",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  test("phone exposes only the public session SDK workflow", async () => {
    const page = await openPage({ width: 390, height: 844, mobile: true });
    expect(await page.title()).toBe("OpenGeni Session SDK showcase — React");
    expect(await page.getByText(/Fleet|Scheduled tasks|Workspace/, { exact: true }).count()).toBe(
      0,
    );
    await page.getByRole("heading", { name: "Choose the next environment" }).waitFor();
    expect(await page.getByRole("radio", { name: /Other/ }).count()).toBe(0);

    const input = page.getByRole("textbox", { name: "Message the agent" });
    const prompt = "Phone verifies the shared composer.";
    await input.fill(prompt);
    await input.press("Enter");
    await page.getByText(prompt, { exact: true }).waitFor({ timeout: 15_000 });
    expect(await input.inputValue()).toBe("");

    const measured = await page.evaluate(() => {
      const textarea = document.querySelector<HTMLElement>(
        'textarea[aria-label="Message the agent"]',
      )!;
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        inputHeight: textarea.getBoundingClientRect().height,
        inputFontSize: getComputedStyle(textarea).fontSize,
      };
    });
    expect(measured.overflow).toBeLessThanOrEqual(1);
    expect(measured.inputHeight).toBeGreaterThanOrEqual(44);
    expect(measured.inputFontSize).toBe("16px");
    await assertAxeClean(page);
    await page.context().close();
  }, 45_000);

  test("desktop theme and attachment control remain accessible", async () => {
    const page = await openPage({ width: 1440, height: 900, mobile: false });
    expect(await page.getByRole("button", { name: "Attach files" }).count()).toBe(1);
    await page.getByRole("button", { name: "Use light theme" }).click();
    expect(await page.locator(".sdk-demo").getAttribute("data-og-theme")).toBe("light");
    await assertAxeClean(page);
    await page.context().close();
  }, 45_000);

  async function openPage(options: {
    width: number;
    height: number;
    mobile: boolean;
  }): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      reducedMotion: "reduce",
      colorScheme: "dark",
      ...(options.mobile ? { hasTouch: true, isMobile: true } : {}),
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Session SDK showcase" }).waitFor();
    return page;
  }
});

async function assertAxeClean(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
}
