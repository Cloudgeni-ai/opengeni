import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
  type ChromiumBrowser,
  type FirefoxBrowser,
  type Page,
  type WebKitBrowser,
} from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

type EngineId = "chromium" | "firefox" | "webkit";
type Engine = readonly [
  EngineId,
  string,
  BrowserType<ChromiumBrowser | FirefoxBrowser | WebKitBrowser>,
];

const repoRoot = new URL("../..", import.meta.url).pathname;
const availableEngines: readonly Engine[] = [
  ["chromium", "Chromium", chromium],
  ["firefox", "Firefox", firefox],
  ["webkit", "WebKit", webkit],
];
const requestedEngine = process.env.OPENGENI_FRAMEWORK_UI_BROWSER_ENGINE ?? "chromium";
const selected = availableEngines.find(([engineId]) => engineId === requestedEngine);
if (!selected) throw new TypeError(`Unsupported framework UI browser engine: ${requestedEngine}`);
const [engineId, engineName, engine] = selected;
const evidenceRoot = join(repoRoot, ".agent/evidence/framework-ui/development/browser", engineId);

describe(`framework UI parity in ${engineName}`, () => {
  let browser: Browser;
  let reactDemo: StartedProcess;
  let svelteDemo: StartedProcess;
  let reactBaseUrl: string;
  let svelteBaseUrl: string;

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    const [reactPort, sveltePort] = await Promise.all([freePort(), freePort()]);
    reactBaseUrl = `http://127.0.0.1:${reactPort}`;
    svelteBaseUrl = `http://127.0.0.1:${sveltePort}`;
    const configuredChromium =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.OPENGENI_BROWSER_BIN;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      engineId === "chromium"
        ? (configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined))
        : undefined;
    browser = await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    [reactDemo, svelteDemo] = await Promise.all([
      startDemo("react", reactPort, reactBaseUrl),
      startDemo("svelte", sveltePort, svelteBaseUrl),
    ]);
    await writeFile(
      join(evidenceRoot, "environment.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          engine: engineId,
          browserVersion: browser.version(),
          playwright: "1.62.1",
          platform: `${process.platform}-${process.arch}`,
          bun: Bun.version,
        },
        null,
        2,
      )}\n`,
    );
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([reactDemo?.stop(), svelteDemo?.stop(), browser?.close()]);
  }, 45_000);

  test("React SDK showcase preserves the shared mobile session contract", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    try {
      const page = await context.newPage();
      const diagnostics = captureDiagnostics(page);
      await page.goto(reactBaseUrl, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Session SDK showcase" }).waitFor();
      expect(await page.getByText("React", { exact: true }).count()).toBe(1);
      expect(await page.getByText(/Fleet|Scheduled tasks|Workspace/, { exact: true }).count()).toBe(
        0,
      );
      expect(await page.locator('[id^="og-user-message-"]').count()).toBeGreaterThan(0);
      await page.getByRole("heading", { name: "Choose the next environment" }).waitFor();
      expect(await page.getByRole("radio", { name: /Other/ }).count()).toBe(0);

      const textbox = page.getByRole("textbox", { name: "Message the agent" });
      const prompt = `${engineName} verifies the shared composer.`;
      await textbox.fill(prompt);
      await textbox.press("Enter");
      await page
        .locator('[id^="og-user-message-"]')
        .getByText(prompt, { exact: true })
        .waitFor({ timeout: 15_000 });
      expect(await textbox.inputValue()).toBe("");

      await page.getByRole("radio", { name: /Staging/ }).check();
      await page.getByRole("button", { name: "Send answers", exact: true }).click();
      await page.getByRole("heading", { name: "Choose the next environment" }).waitFor({
        state: "detached",
      });
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor({
        state: "detached",
      });
      await expectRecordedActions(page, [
        "composer.submit",
        "human-input.respond",
        "approval.respond",
      ]);

      const geometry = await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>(
          'textarea[aria-label="Message the agent"]',
        )!;
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          inputFontSize: getComputedStyle(input).fontSize,
          inputHeight: input.getBoundingClientRect().height,
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.inputFontSize).toBe("16px");
      expect(geometry.inputHeight).toBeGreaterThanOrEqual(44);
      await assertReactTurnSummaryNames(page);
      await assertAxeClean(page);
      assertExpectedDiagnostics(diagnostics, { reducedMotionWarning: false });
      await page.screenshot({
        path: join(evidenceRoot, "react-phone-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Svelte SDK showcase preserves the shared mobile session contract", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    try {
      const page = await context.newPage();
      const diagnostics = captureDiagnostics(page);
      await page.goto(svelteBaseUrl, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Session SDK showcase" }).waitFor();
      expect(await page.getByText("Svelte", { exact: true }).count()).toBe(1);
      expect(
        await page
          .getByText(/Mission Control|Fleet|Scheduled tasks|Workspace/, { exact: true })
          .count(),
      ).toBe(0);
      await page.getByRole("region", { name: "Session timeline" }).waitFor();
      expect(
        await page.locator('[data-og-component="timeline-row"]').count(),
      ).toBeGreaterThanOrEqual(7);
      expect(await page.getByText("14 tests passed", { exact: false }).count()).toBe(1);
      expect(await page.getByRole("radio", { name: /Other/ }).count()).toBe(0);

      const textbox = page.getByRole("textbox", { name: "Message" });
      const prompt = `${engineName} verifies the shared composer.`;
      await textbox.fill(prompt);
      await textbox.press("Enter");
      await page.getByText(prompt, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await textbox.inputValue()).toBe("");

      await page.getByRole("button", { name: "Send answers", exact: true }).click();
      expect(await page.getByRole("alert").allTextContents()).toContain(
        "This question is required.",
      );
      await page.getByRole("radio", { name: /Staging/ }).check();
      await page.getByRole("button", { name: "Send answers", exact: true }).click();
      await page.getByRole("heading", { name: "Choose the next environment" }).waitFor({
        state: "detached",
      });
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor({
        state: "detached",
      });
      await expectRecordedActions(page, [
        "composer.submit",
        "human-input.respond",
        "approval.respond",
      ]);

      const geometry = await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>('textarea[aria-label="Message"]')!;
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          composerOverflow:
            document.querySelector<HTMLElement>(".og-composer")!.scrollWidth -
            document.querySelector<HTMLElement>(".og-composer")!.clientWidth,
          inputFontSize: getComputedStyle(input).fontSize,
          inputHeight: input.getBoundingClientRect().height,
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.composerOverflow).toBeLessThanOrEqual(1);
      expect(geometry.inputFontSize).toBe("16px");
      expect(geometry.inputHeight).toBeGreaterThanOrEqual(44);
      await assertAxeClean(page);
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("region", { name: "Session timeline" }).waitFor();
      const controls = page.locator('[data-og-component="session"] > [data-og-part="controls"]');
      await controls.evaluate((element) => {
        element.scrollTop = 0;
      });
      expect(await controls.evaluate((element) => element.scrollTop)).toBe(0);
      assertExpectedDiagnostics(diagnostics, { reducedMotionWarning: false });
      await page.screenshot({
        path: join(evidenceRoot, "svelte-phone-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("React and Svelte expose the same desktop showcase frame", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    try {
      const [reactPage, sveltePage] = await Promise.all([context.newPage(), context.newPage()]);
      await Promise.all([
        reactPage.goto(reactBaseUrl, { waitUntil: "networkidle" }),
        sveltePage.goto(svelteBaseUrl, { waitUntil: "networkidle" }),
      ]);
      const measure = async (page: Page) =>
        await page.evaluate(() => {
          const header = document
            .querySelector<HTMLElement>(".sdk-demo__header")!
            .getBoundingClientRect();
          const surface = document
            .querySelector<HTMLElement>('[data-demo-surface="session"]')!
            .getBoundingClientRect();
          return {
            headerHeight: header.height,
            surfaceX: surface.x,
            surfaceY: surface.y,
            surfaceWidth: surface.width,
            surfaceHeight: surface.height,
          };
        });
      const [reactFrame, svelteFrame] = await Promise.all([
        measure(reactPage),
        measure(sveltePage),
      ]);
      for (const key of Object.keys(reactFrame) as Array<keyof typeof reactFrame>) {
        expect(Math.abs(reactFrame[key] - svelteFrame[key])).toBeLessThanOrEqual(2);
      }
      await Promise.all([
        reactPage.screenshot({
          path: join(evidenceRoot, "react-desktop-dark.png"),
          fullPage: true,
          animations: "disabled",
        }),
        sveltePage.screenshot({
          path: join(evidenceRoot, "svelte-desktop-dark.png"),
          fullPage: true,
          animations: "disabled",
        }),
      ]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

async function startDemo(
  framework: "react" | "svelte",
  port: number,
  baseUrl: string,
): Promise<StartedProcess> {
  return await startProcess(
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
      cwd: `${repoRoot}/packages/${framework}`,
      ready: async () =>
        (
          await fetch(baseUrl, {
            signal: AbortSignal.timeout(2_000),
          }).catch(() => null)
        )?.ok === true,
      timeoutMs: 45_000,
    },
  );
}

async function assertAxeClean(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
}

async function expectRecordedActions(page: Page, expected: readonly string[]): Promise<void> {
  const actions = await page.evaluate(() =>
    (
      window as typeof window & {
        __OPENGENI_DEMO_REQUESTS__?: Array<{ action: string }>;
      }
    ).__OPENGENI_DEMO_REQUESTS__?.map(({ action }) => action),
  );
  expect(actions).toEqual(expected);
}

async function assertReactTurnSummaryNames(page: Page): Promise<void> {
  const disclosures = await page.locator("[data-og-turn-summary-trigger]").evaluateAll((elements) =>
    elements.map((element) => ({
      expanded: element.getAttribute("aria-expanded"),
      label: element.getAttribute("aria-label"),
    })),
  );
  expect(disclosures.length).toBeGreaterThan(0);
  expect(
    disclosures.every(({ expanded, label }) =>
      expanded === "true" ? label === "Hide turn steps" : label === "Show turn steps",
    ),
  ).toBe(true);
}

function captureDiagnostics(page: Page): string[] {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      diagnostics.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (!request.url().startsWith("ws:")) diagnostics.push(`request: ${request.url()}`);
  });
  return diagnostics;
}

function isExpectedReducedMotionWarning(diagnostic: string): boolean {
  return diagnostic.startsWith(
    "console.warning: You have Reduced Motion enabled on your device. Animations may not appear as expected.",
  );
}

function isExpectedFirefoxHarnessWarning(diagnostic: string): boolean {
  return (
    diagnostic.includes("Layout was forced before the page was fully loaded") &&
    diagnostic.includes('file: "chrome://juggler/content/content/main.js"')
  );
}

function isExpectedWebKitTerminalTaskQueueWarning(diagnostic: string): boolean {
  return (
    engineId === "webkit" &&
    /^console\.warning: task queue exceeded allotted deadline by \d+ms$/u.test(diagnostic)
  );
}

function assertExpectedDiagnostics(
  diagnostics: readonly string[],
  options: { reducedMotionWarning: boolean },
): void {
  expect(diagnostics.filter(isExpectedReducedMotionWarning)).toHaveLength(
    options.reducedMotionWarning ? 1 : 0,
  );
  expect(diagnostics.filter(isExpectedFirefoxHarnessWarning)).toHaveLength(
    engineId === "firefox" ? 1 : 0,
  );
  expect(diagnostics.filter(isExpectedWebKitTerminalTaskQueueWarning).length).toBeLessThanOrEqual(
    1,
  );
  expect(
    diagnostics.filter(
      (diagnostic) =>
        !isExpectedReducedMotionWarning(diagnostic) &&
        !isExpectedFirefoxHarnessWarning(diagnostic) &&
        !isExpectedWebKitTerminalTaskQueueWarning(diagnostic),
    ),
  ).toEqual([]);
}
