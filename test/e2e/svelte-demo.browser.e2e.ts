import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceRoot = join(repoRoot, ".agent/evidence/framework-ui/development/svelte-demo");

describe("native Svelte Session SDK showcase", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const configuredChromium =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.OPENGENI_BROWSER_BIN;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
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
        cwd: `${repoRoot}/packages/svelte`,
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

  test("desktop showcases the public native Svelte session components", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const diagnostics = captureDiagnostics(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectShowcaseReady(page);

    expect(await page.title()).toBe("OpenGeni Session SDK showcase — Svelte");
    expect(
      await page
        .getByText(/Mission Control|Fleet|Scheduled tasks|Workspace/, { exact: true })
        .count(),
    ).toBe(0);
    expect(await page.getByRole("heading", { name: "Choose the next environment" }).count()).toBe(
      1,
    );
    expect(await page.getByRole("button", { name: "Send", exact: true }).count()).toBe(1);

    expect(await page.getByRole("combobox", { name: "Model" }).isVisible()).toBe(true);

    await page.getByRole("button", { name: "Light" }).click();
    expect(await page.locator(".sdk-demo").getAttribute("data-og-theme")).toBe("light");
    expect(await page.getByText("14 tests passed", { exact: false }).count()).toBe(1);

    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const surface = document.querySelector<HTMLElement>('[data-demo-surface="session"]')!;
      return {
        overflow: root.scrollWidth - root.clientWidth,
        surfaceHeight: surface.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.surfaceHeight).toBeGreaterThan(700);
    expect(geometry.surfaceHeight).toBeLessThan(geometry.viewportHeight);
    await assertAxeClean(page);
    expect(diagnostics).toEqual([]);
    await page.screenshot({ path: join(evidenceRoot, "desktop-light.png"), fullPage: true });
    await context.close();
  }, 60_000);

  test("phone keeps composer, validation, and policy controls accessible", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const diagnostics = captureDiagnostics(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectShowcaseReady(page);

    await page.getByRole("button", { name: "Send answers", exact: true }).click();
    expect(await page.getByRole("alert").allTextContents()).toContain("This question is required.");

    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const composer = document.querySelector<HTMLElement>(".og-composer")!;
      const input = document.querySelector<HTMLElement>(".og-composer__input")!;
      return {
        overflow: root.scrollWidth - root.clientWidth,
        composerOverflow: composer.scrollWidth - composer.clientWidth,
        inputFontSize: getComputedStyle(input).fontSize,
        inputHeight: input.getBoundingClientRect().height,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.composerOverflow).toBeLessThanOrEqual(1);
    expect(geometry.inputFontSize).toBe("16px");
    expect(geometry.inputHeight).toBeGreaterThanOrEqual(44);
    await assertAxeClean(page);
    expect(diagnostics).toEqual([]);
    await page.screenshot({
      path: join(evidenceRoot, "phone-dark-validation.png"),
      fullPage: true,
    });
    await context.close();
  }, 60_000);
});

async function expectShowcaseReady(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "Session SDK showcase" }).waitFor();
  await page.getByRole("region", { name: "Session timeline" }).waitFor();
  await page.getByRole("textbox", { name: "Message" }).waitFor();
}

async function assertAxeClean(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
}

function captureDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      diagnostics.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
  return diagnostics;
}
