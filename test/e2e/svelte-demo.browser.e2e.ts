import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
    const composedStatus = page.locator(
      '[data-og-component="chrome"] [data-og-component="status"]',
    );
    expect(await composedStatus.getAttribute("role")).toBe("status");
    expect(await composedStatus.getAttribute("aria-live")).toBe("polite");
    expect(await composedStatus.getAttribute("aria-atomic")).toBe("true");
    const preservedText = await page.evaluate(() => {
      const user = document.querySelector<HTMLElement>(
        '[data-og-kind="user-message"] [data-og-part="message-text"]',
      )!;
      const agent = document.querySelector<HTMLElement>(
        '[data-og-kind="agent-message"] [data-og-part="message-text"]',
      )!;
      return {
        user: user.textContent,
        agent: agent.textContent,
        userWhiteSpace: getComputedStyle(user).whiteSpace,
        agentWhiteSpace: getComputedStyle(agent).whiteSpace,
      };
    });
    expect(preservedText).toEqual({
      user: "Review the infrastructure rollout.\nPreserve  the operator's spacing.",
      agent:
        "I verified the rollout receipts.\nOne approval  and one operator answer remain before completion.",
      userWhiteSpace: "pre-wrap",
      agentWhiteSpace: "pre-wrap",
    });
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
    const authNeeded = page.locator('[data-og-kind="auth-needed"]');
    await authNeeded.getByRole("button", { name: "Reconnect", exact: true }).click();
    expect(await page.locator("[data-reconnect-request]").textContent()).toContain("github.com");

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

  test("tool-policy changes use the durable versioned session contract", async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const diagnostics = captureDiagnostics(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectMissionControlReady(page);

    const browserTool = page
      .locator(".mission-inspector .og-tool-policy__item")
      .filter({ hasText: "Browser" })
      .locator('input[type="checkbox"]');
    expect(await browserTool.isChecked()).toBe(false);
    expect(await page.locator("[data-tool-policy-version]").textContent()).toContain("Policy v1");
    await browserTool.click();
    await page.getByText("3 enabled · Policy v2", { exact: true }).waitFor();
    expect(await browserTool.isChecked()).toBe(true);

    await assertAxeClean(page);
    expect(diagnostics).toEqual([]);
    await context.close();
  }, 60_000);

  test("failed tool-policy and pause mutations reconcile without silent local state", async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const diagnostics = captureDiagnostics(page);
    await page.goto(`${baseUrl}?toolPolicy=fail&control=fail`, { waitUntil: "networkidle" });
    await expectMissionControlReady(page);

    const browserTool = page
      .locator(".mission-inspector .og-tool-policy__item")
      .filter({ hasText: "Browser" })
      .locator('input[type="checkbox"]');
    await browserTool.click();
    await page
      .locator('[role="alert"]')
      .filter({ hasText: "Could not save session tools. Fixture tool policy update failed." })
      .waitFor();
    expect(await browserTool.isChecked()).toBe(false);
    expect(await page.locator("[data-tool-policy-version]").textContent()).toContain("Policy v1");

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const pauseError = page
      .locator('[role="alert"]')
      .filter({ hasText: "Fixture pause request failed." });
    await pauseError.waitFor();
    expect(await pauseError.count()).toBe(1);

    await assertAxeClean(page);
    expect(diagnostics).toEqual([]);
    await context.close();
  }, 60_000);

  test("definitive and outcome-unknown composer failures remain visible and recoverable", async () => {
    for (const failure of ["definitive", "outcome-unknown"] as const) {
      const context = await browser.newContext({
        viewport: { width: 1200, height: 800 },
        reducedMotion: "reduce",
        colorScheme: "dark",
      });
      const page = await context.newPage();
      const diagnostics = captureDiagnostics(page);
      await page.goto(`${baseUrl}?composer=${failure}`, { waitUntil: "networkidle" });
      await expectMissionControlReady(page);

      const text = `Retain failed ${failure} delivery`;
      const input = page.getByRole("textbox", { name: "Message" });
      await input.fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();

      const row = page
        .locator('[data-og-component="timeline-row"][data-og-kind="user-message"]')
        .filter({ hasText: text });
      await row.getByText("Message not sent", { exact: true }).waitFor();
      expect(await input.inputValue()).toBe("");
      const delivery = row.locator('[role="status"]');
      expect(await delivery.getAttribute("aria-live")).toBe("polite");
      expect(await delivery.getAttribute("aria-atomic")).toBe("true");
      expect(await row.getByRole("button", { name: "Retry", exact: true }).isVisible()).toBe(true);
      expect(await row.getByRole("button", { name: "Remove", exact: true }).isVisible()).toBe(true);

      await row.getByRole("button", { name: "Retry", exact: true }).click();
      await row.getByText("Message not sent", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Remove", exact: true }).click();
      await row.waitFor({ state: "detached" });

      await assertAxeClean(page);
      expect(diagnostics).toEqual([]);
      await context.close();
    }
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
