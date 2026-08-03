import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDirectory =
  process.env.OPENGENI_REALTIME_DEMO_EVIDENCE_DIR ?? "/tmp/opengeni-realtime-demo-evidence";

describe("public realtime React demo browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    await mkdir(evidenceDirectory, { recursive: true });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
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
          (
            await fetch(`${baseUrl}/realtime.html?mode=mock`, {
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

  test("selection, start, mute, diagnostics, reconnect, stop, error, and realtime-first creation preserve the public contract", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const failures = observePageFailures(page);
    await page.goto(`${baseUrl}/realtime.html?mode=mock`, { waitUntil: "networkidle" });

    const existing = page.locator("[data-realtime-existing-composer]");
    const next = page.locator("[data-realtime-new-composer]");
    const primary = existing.getByTestId("realtime-primary-action");
    await expectLabel(primary, "Start voice with Codex Live");
    expect(
      await existing.locator('[aria-label="Realtime voice"]').getAttribute("data-picker-side"),
    ).toBe("top");
    expect(
      await next.locator('[aria-label="Realtime voice"]').getAttribute("data-picker-side"),
    ).toBe("bottom");
    await capture(page, "01-idle-desktop.png");

    await openPicker(existing);
    await page.getByTestId("model-picker-back").click();
    await page.getByTestId("realtime-model-provider-opengeni_credits").click();
    await page
      .getByTestId("realtime-model-choice-opengeni-gateway/openai/gpt-realtime-2.1")
      .waitFor();
    await capture(page, "02-picker-desktop-menu-up.png");
    await page
      .getByTestId("realtime-model-choice-opengeni-gateway/openai/gpt-realtime-2.1")
      .click();
    await expectLabel(primary, "Start voice with GPT Realtime 2.1");

    await primary.click();
    await expectPhase(primary, "connecting");
    await capture(page, "03-starting-desktop.png");
    await expectLabel(primary, "End voice conversation");
    await expectPhase(primary, "listening");
    expect(await existing.getByTestId("realtime-mute-controls").count()).toBe(1);
    await capture(page, "04-active-desktop.png");

    const microphone = existing.getByRole("button", { name: "Mute microphone" });
    const output = existing.getByRole("button", { name: "Mute voice audio" });
    await microphone.click();
    await output.click();
    expect(
      await existing
        .getByRole("button", { name: "Unmute microphone" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      await existing
        .getByRole("button", { name: "Unmute voice audio" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await capture(page, "05-muted-desktop.png");

    await openPicker(existing);
    const diagnostics = page.getByText("Realtime diagnostics", { exact: true });
    await diagnostics.hover();
    await page.getByText("controller", { exact: true }).last().waitFor();
    expect(await page.getByText("active", { exact: true }).last().count()).toBe(1);
    await capture(page, "06-diagnostics-desktop.png");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Simulate reconnect" }).click();
    await expectLabel(primary, "Retry voice connection");
    await expectPhase(primary, "reconnecting");
    await capture(page, "07-reconnecting-desktop.png");
    await primary.click();
    await expectLabel(primary, "End voice conversation");

    await primary.click();
    await expectPhase(primary, "stopping");
    await expectLabel(primary, "Start voice with GPT Realtime 2.1");
    await page.getByRole("button", { name: "Simulate error" }).click();
    await expectPhase(primary, "error");
    expect(await existing.getByRole("alert").textContent()).toContain(
      "The deterministic demo rejected the connection.",
    );
    await capture(page, "08-error-desktop.png");

    await openPicker(next);
    await page.getByTestId("model-picker-back").click();
    await page.getByTestId("realtime-model-provider-byok").click();
    await page
      .getByTestId("realtime-model-choice-workspace-gateway/openai/gpt-realtime-mini")
      .click();
    await next.getByRole("button", { name: "Start voice with GPT Realtime Mini" }).click();
    await page.getByTestId("realtime-first-count").filter({ hasText: "1" }).waitFor();
    const createdSessionId = await page.getByTestId("current-session-id").textContent();
    expect(createdSessionId).not.toBeNull();
    expect(createdSessionId).not.toBe("3f6e1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b");
    await expectLabel(
      page.locator("[data-realtime-existing-composer]").getByTestId("realtime-primary-action"),
      "End voice conversation",
    );
    await capture(page, "09-realtime-first-created-desktop.png");

    const contract = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Realtime voice"]')).map(
        (region) => ({
          pickerSide: region.dataset.pickerSide,
          primaryLabel:
            region
              .querySelector<HTMLElement>('[data-testid="realtime-primary-action"]')
              ?.getAttribute("aria-label") ?? null,
          primaryPhase:
            region.querySelector<HTMLElement>('[data-testid="realtime-primary-action"]')?.dataset
              .phase ?? null,
          primaryClass:
            region.querySelector<HTMLElement>('[data-testid="realtime-primary-action"]')
              ?.className ?? null,
          optionsLabel:
            region
              .querySelector<HTMLElement>('button[aria-label="Choose voice model and options"]')
              ?.getAttribute("aria-label") ?? null,
          liveText: region.querySelector<HTMLElement>('[role="status"]')?.textContent ?? null,
        }),
      ),
    );
    await writeFile(
      `${evidenceDirectory}/dom-copy-aria-class-contract.json`,
      `${JSON.stringify(contract, null, 2)}\n`,
    );
    expect(contract).toHaveLength(2);
    expect(contract[0]?.pickerSide).toBe("top");
    expect(contract[1]?.pickerSide).toBe("bottom");
    expect(contract.every((entry) => entry.optionsLabel === "Choose voice model and options")).toBe(
      true,
    );
    expect(contract.every((entry) => entry.primaryClass?.includes("rounded-l-og-md"))).toBe(true);
    expect(failures).toEqual([]);
    await context.close();
  }, 90_000);

  test("mobile keeps both composer controls bounded and preserves menu-up/menu-down placement", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const failures = observePageFailures(page);
    await page.goto(`${baseUrl}/realtime.html?mode=mock`, { waitUntil: "networkidle" });
    const existing = page.locator("[data-realtime-existing-composer]");
    const next = page.locator("[data-realtime-new-composer]");
    const audit = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      regions: document.querySelectorAll('[aria-label="Realtime voice"]').length,
      minimumPrimarySize: Math.min(
        ...Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="realtime-primary-action"]'),
          (element) =>
            Math.min(element.getBoundingClientRect().width, element.getBoundingClientRect().height),
        ),
      ),
    }));
    expect(audit.overflow).toBeLessThanOrEqual(1);
    expect(audit.regions).toBe(2);
    expect(audit.minimumPrimarySize).toBeGreaterThanOrEqual(44);

    await openPicker(existing);
    await capture(page, "10-picker-mobile-menu-up.png");
    await page.keyboard.press("Escape");
    await openPicker(next);
    await capture(page, "11-picker-mobile-menu-down.png");
    await page.keyboard.press("Escape");
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(failures).toEqual([]);
    await context.close();
  }, 60_000);
});

async function openPicker(surface: Locator): Promise<void> {
  await surface.getByRole("button", { name: "Choose voice model and options" }).click();
  await surface.page().getByTestId("realtime-model-picker-menu").waitFor();
}

async function expectLabel(button: Locator, label: string): Promise<void> {
  await button.waitFor();
  await button
    .page()
    .waitForFunction(
      ({ expected, testId }) =>
        document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-label") ===
        expected,
      { expected: label, testId: "realtime-primary-action" },
    );
  expect(await button.getAttribute("aria-label")).toBe(label);
}

async function expectPhase(button: Locator, phase: string): Promise<void> {
  await button
    .page()
    .waitForFunction(
      ({ expected, testId }) =>
        document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-phase") ===
        expected,
      { expected: phase, testId: "realtime-primary-action" },
    );
  expect(await button.getAttribute("data-phase")).toBe(phase);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${evidenceDirectory}/${name}`,
    fullPage: true,
    animations: "disabled",
  });
}

function observePageFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console:${message.text()}`);
  });
  page.on("requestfailed", (request) => failures.push(`request:${request.url()}`));
  return failures;
}
