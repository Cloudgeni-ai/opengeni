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
import { isExpectedFirefoxWebGLUnavailableWarning } from "../../scripts/framework-ui-browser-diagnostics";
import { startFrameworkUiDemos } from "../../scripts/framework-ui-demo-processes";

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
    [reactDemo, svelteDemo] = await startFrameworkUiDemos(
      async () => await startDemo("react", reactPort, reactBaseUrl),
      async () => await startDemo("svelte", sveltePort, svelteBaseUrl),
    );
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

  test("React preserves mobile composer, timeline, vertical tabs, focus, and Axe semantics", async () => {
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
      await page.getByRole("heading", { name: "Staging operations" }).waitFor();
      expect(await page.locator('[id^="og-user-message-"]').count()).toBeGreaterThan(0);

      const textbox = page.getByRole("textbox", { name: "Message the agent" });
      const prompt = `${engineName} verifies the shared React composer.`;
      await textbox.fill(prompt);
      await textbox.press("Enter");
      await page
        .locator('[id^="og-user-message-"]')
        .getByText(prompt, { exact: true })
        .waitFor({ timeout: 15_000 });
      expect(await textbox.inputValue()).toBe("");

      const navigation = page.getByRole("navigation", { name: "Demo views" });
      const workspaceTrigger = navigation.getByRole("button", {
        name: "Workspace",
        exact: true,
      });
      await workspaceTrigger.click();
      const workspace = page.locator('[role="dialog"][aria-label="Workspace"]:not([hidden])');
      await workspace.waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("tab");
      expect(
        await page.getByRole("tab", { name: "Files", exact: true }).getAttribute("aria-selected"),
      ).toBe("true");
      await page.keyboard.press("ArrowDown");
      expect(
        await page
          .getByRole("tab", { name: "Terminal", exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      await page.keyboard.press("Escape");
      await workspace.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Workspace");

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
      assertExpectedDiagnostics(diagnostics, { reducedMotionWarning: true });
      await page.screenshot({
        path: join(evidenceRoot, "react-phone-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Svelte preserves native timeline, composer, drawers, validation, and Axe semantics", async () => {
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
      await page.getByRole("heading", { name: /Mission Control/ }).waitFor();
      await page.getByRole("region", { name: "Session timeline" }).waitFor();
      expect(await page.locator('[data-og-component="timeline-row"]').count()).toBeGreaterThan(12);
      expect(
        await page.getByText("No React runtime crossed the native Svelte boundary.").count(),
      ).toBe(1);

      const textbox = page.getByRole("textbox", { name: "Message" });
      await textbox.fill(`${engineName} verifies the native Svelte composer.`);
      await textbox.press("Enter");
      await page.waitForFunction(
        () =>
          (document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value ??
            "pending") === "",
      );
      expect(await textbox.inputValue()).toBe("");

      const sessions = page.getByRole("button", { name: "Sessions" });
      await sessions.click();
      expect(await sessions.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      expect(await sessions.getAttribute("aria-expanded")).toBe("false");
      expect(await sessions.evaluate((element) => document.activeElement === element)).toBe(true);

      await page.getByRole("button", { name: "Send answers", exact: true }).click();
      expect(await page.getByRole("alert").allTextContents()).toContain(
        "This question is required.",
      );

      const configure = page.getByRole("button", { name: "Configure" });
      await configure.click();
      expect(await configure.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      expect(await configure.getAttribute("aria-expanded")).toBe("false");

      const geometry = await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>('textarea[aria-label="Message"]')!;
        const actions = [...document.querySelectorAll<HTMLElement>(".mission-mobile-action")];
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          composerOverflow:
            document.querySelector<HTMLElement>(".og-composer")!.scrollWidth -
            document.querySelector<HTMLElement>(".og-composer")!.clientWidth,
          inputFontSize: getComputedStyle(input).fontSize,
          actionHeight: Math.min(
            ...actions.map((element) => element.getBoundingClientRect().height),
          ),
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.composerOverflow).toBeLessThanOrEqual(1);
      expect(geometry.inputFontSize).toBe("16px");
      expect(geometry.actionHeight).toBeGreaterThanOrEqual(44);
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
  expect(diagnostics.filter(isExpectedFirefoxWebGLUnavailableWarning).length).toBeLessThanOrEqual(
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
        !isExpectedFirefoxWebGLUnavailableWarning(diagnostic) &&
        !isExpectedWebKitTerminalTaskQueueWarning(diagnostic),
    ),
  ).toEqual([]);
}
