import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceRoot = join(repoRoot, ".agent/evidence/framework-ui/development/svelte-demo");

describe("native Svelte Mission Control demo", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium", headless: true });
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
          (
            await fetch(baseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  test("desktop keeps timeline primary with visible navigation and policy rails", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const diagnostics = captureDiagnostics(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectMissionControlReady(page);

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const root = document.documentElement;
      return {
        navigation: rect(".mission-navigation").width,
        main: rect(".mission-main").width,
        inspector: rect(".mission-inspector").width,
        sessionHeight: rect(".mission-main .og-session").height,
        viewportHeight: window.innerHeight,
        overflow: root.scrollWidth - root.clientWidth,
      };
    });
    expect(geometry.navigation).toBeGreaterThan(180);
    expect(geometry.inspector).toBeGreaterThan(220);
    expect(geometry.main).toBeGreaterThan(500);
    expect(geometry.sessionHeight).toBeGreaterThan(700);
    expect(geometry.sessionHeight).toBeLessThan(geometry.viewportHeight);
    expect(geometry.overflow).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Light" }).click();
    await page.getByRole("button", { name: "Compact" }).click();
    expect(await page.locator(".mission-shell").getAttribute("data-og-theme")).toBe("light");
    expect(await page.locator(".mission-shell").getAttribute("data-og-density")).toBe("compact");
    expect(await page.getByRole("heading", { name: "Session configuration" }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("textbox", { name: "Message" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Send", exact: true }).isVisible()).toBe(true);
    for (const kind of [
      "worker",
      "worker-completion",
      "sandbox",
      "startup-phase",
      "memory",
      "fleet-decision",
      "session-status",
      "goal",
      "context-compaction",
      "auth-needed",
    ]) {
      expect(
        await page.locator(`[data-og-component="timeline-row"][data-og-kind="${kind}"]`).count(),
      ).toBe(1);
    }
    expect(
      await page.getByText("No React runtime crossed the native Svelte boundary.").count(),
    ).toBe(1);
    expect(await page.getByText("Estimated history tokens:", { exact: false }).count()).toBe(1);

    await assertAxeClean(page);
    expect(diagnostics).toEqual([]);
    await page.screenshot({
      path: join(evidenceRoot, "desktop-light-compact.png"),
      fullPage: true,
    });
    await context.close();
  }, 60_000);

  test("phone drawers, Escape dismissal, touch targets, and validation remain accessible", async () => {
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
    await expectMissionControlReady(page);

    const sessions = page.getByRole("button", { name: "Sessions" });
    await sessions.click();
    expect(await sessions.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByRole("navigation", { name: "OpenGeni sessions" }).isVisible()).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    expect(await sessions.getAttribute("aria-expanded")).toBe("false");

    const configure = page.getByRole("button", { name: "Configure" });
    await configure.click();
    expect(await configure.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByRole("heading", { name: "Session configuration" }).isVisible()).toBe(
      true,
    );
    expect(
      await page
        .locator(".mission-inspector .og-tool-policy__item")
        .filter({ hasText: "GitHub" })
        .locator('input[type="checkbox"]')
        .isChecked(),
    ).toBe(true);
    await page.getByRole("button", { name: "Close session configuration" }).click();
    expect(await configure.getAttribute("aria-expanded")).toBe("false");

    await page.getByRole("button", { name: "Send answers", exact: true }).click();
    expect(await page.getByRole("alert").allTextContents()).toContain("This question is required.");

    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const actionHeights = [
        ...document.querySelectorAll<HTMLElement>(".mission-mobile-action"),
      ].map((element) => element.getBoundingClientRect().height);
      const composer = document.querySelector<HTMLElement>(".og-composer")!;
      return {
        overflow: root.scrollWidth - root.clientWidth,
        composerOverflow: composer.scrollWidth - composer.clientWidth,
        actionHeights,
        inputFontSize: getComputedStyle(document.querySelector<HTMLElement>(".og-composer__input")!)
          .fontSize,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.composerOverflow).toBeLessThanOrEqual(1);
    expect(Math.min(...geometry.actionHeights)).toBeGreaterThanOrEqual(44);
    expect(geometry.inputFontSize).toBe("16px");

    await assertAxeClean(page);
    expect(diagnostics).toEqual([]);
    await page.screenshot({
      path: join(evidenceRoot, "phone-dark-validation.png"),
      fullPage: true,
    });
    await context.close();
  }, 60_000);
});

async function expectMissionControlReady(page: Page): Promise<void> {
  await page.getByRole("heading", { name: /Mission Control/ }).waitFor();
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
