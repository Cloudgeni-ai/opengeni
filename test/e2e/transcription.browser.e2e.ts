import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir =
  process.env.OPENGENI_TRANSCRIPTION_EVIDENCE_DIR ?? "/tmp/opengeni-transcription-evidence";
const viewports = [
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 768, height: 960 },
  { width: 1440, height: 1000 },
] as const;
const themes = ["dark", "light"] as const;

type MatrixMeasurement = {
  viewport: (typeof viewports)[number];
  theme: (typeof themes)[number];
  documentOverflow: number;
  micCount: number;
  micWidth: number;
  micHeight: number;
  providerConfigurationVisible: boolean;
  colorScheme: string;
  axeViolations: number;
};

describe("provider-agnostic composer transcription browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;
  const measurements: MatrixMeasurement[] = [];

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await mkdir(evidenceDir, { recursive: true });
    const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
      cwd: `${repoRoot}/packages/react`,
      timeoutMs: 60_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(`Transcription demo build failed:\n${build.stdout}\n${build.stderr}`);
    }
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
        "preview",
        "demo",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/transcription.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 90_000);

  afterAll(async () => {
    await writeFile(
      `${evidenceDir}/measurements.json`,
      `${JSON.stringify({ measurements }, null, 2)}\n`,
    );
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  test("one clean mic stays accessible and bounded across responsive light/dark surfaces", async () => {
    for (const viewport of viewports) {
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width <= 768,
          isMobile: viewport.width <= 375,
          colorScheme: theme,
        });
        const page = await context.newPage();
        const failures = observePageFailures(page);
        await page.goto(`${baseUrl}/transcription.html?theme=${theme}`, {
          waitUntil: "networkidle",
        });
        const mic = page.getByRole("button", { name: "Start voice input" });
        await mic.waitFor();
        const violations = await new AxeBuilder({ page }).analyze();
        const measurement = await page.evaluate(() => {
          const surface = document.querySelector<HTMLElement>("[data-transcription-harness]");
          const micButton = document.querySelector<HTMLElement>(
            'button[aria-label="Start voice input"]',
          );
          const rect = micButton?.getBoundingClientRect();
          return {
            documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            micCount: document.querySelectorAll('button[aria-label="Start voice input"]').length,
            micWidth: rect?.width ?? 0,
            micHeight: rect?.height ?? 0,
            providerConfigurationVisible: /fixture-speech|fixture-v1|BYOK|provider ID/i.test(
              document.body.innerText,
            ),
            colorScheme: surface ? getComputedStyle(surface).colorScheme : "",
          };
        });
        measurements.push({
          ...measurement,
          viewport,
          theme,
          axeViolations: violations.violations.length,
        });
        expect(measurement.documentOverflow).toBeLessThanOrEqual(1);
        expect(measurement.micCount).toBe(1);
        expect(measurement.providerConfigurationVisible).toBe(false);
        if (viewport.width <= 768) {
          expect(measurement.micWidth).toBeGreaterThanOrEqual(44);
          expect(measurement.micHeight).toBeGreaterThanOrEqual(44);
        }
        expect(measurement.colorScheme).toContain(theme);
        expect(violations.violations).toEqual([]);
        expect(failures).toEqual([]);

        if (
          (viewport.width === 360 && theme === "dark") ||
          (viewport.width === 1440 && theme === "light")
        ) {
          await mic.click();
          await page.getByRole("button", { name: "Emit partial" }).click();
          await page.screenshot({
            path: `${evidenceDir}/listening-${viewport.width}-${theme}.png`,
            animations: "disabled",
          });
        }
        await context.close();
      }
    }
  }, 90_000);

  test("partials stay ephemeral while one final remains editable and uses ordinary Send", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=light`, { waitUntil: "networkidle" });
    const textarea = page.getByRole("textbox", { name: "Message the agent" });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Emit partial" }).click();
    await page.getByRole("status").filter({ hasText: "This partial stays ephemeral" }).waitFor();
    expect(await textarea.inputValue()).toBe("Existing editable draft");

    await page.getByRole("button", { name: "Emit final" }).click();
    expect(await textarea.inputValue()).toBe(
      "Existing editable draft Final transcript remains editable",
    );
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Message the agent",
    );
    await textarea.fill("Edited final transcript");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("Sent: Edited final transcript", { exact: true }).waitFor();
    await page.screenshot({
      path: `${evidenceDir}/editable-final-and-send.png`,
      animations: "disabled",
    });
    await context.close();
  });

  test("permission denial and provider failure preserve the draft and expose retryable errors", async () => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      hasTouch: true,
    });
    const denied = await context.newPage();
    await denied.goto(`${baseUrl}/transcription.html?theme=dark&mode=denied`, {
      waitUntil: "networkidle",
    });
    await denied.getByRole("button", { name: "Start voice input" }).click();
    await denied
      .getByRole("alert")
      .filter({ hasText: "Microphone permission was denied. Your draft was not changed." })
      .waitFor();
    expect(await denied.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
      "Existing editable draft",
    );
    expect(await denied.getByRole("button", { name: "Retry voice input" }).count()).toBe(1);
    expect((await new AxeBuilder({ page: denied }).analyze()).violations).toEqual([]);
    await denied.screenshot({
      path: `${evidenceDir}/permission-denied-375-dark.png`,
      animations: "disabled",
    });

    const failed = await context.newPage();
    await failed.goto(`${baseUrl}/transcription.html?theme=light`, { waitUntil: "networkidle" });
    await failed.getByRole("button", { name: "Start voice input" }).click();
    await failed.getByRole("button", { name: "Fail stream" }).click();
    const providerAlert = failed
      .getByRole("alert")
      .filter({ hasText: "The transcription service could not continue." });
    await providerAlert.waitFor();
    expect(await failed.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
      "Existing editable draft",
    );
    expect(await providerAlert.innerText()).not.toMatch(
      /FixtureProvider|fixture-secret|opaque-token|Bearer/i,
    );
    expect(await failed.locator("body").innerText()).not.toMatch(
      /FixtureProvider|fixture-secret|opaque-token|Bearer/i,
    );
    await context.close();
  });

  test("secret-bearing start failures render only controlled local copy", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    const failures = observePageFailures(page);
    await page.goto(`${baseUrl}/transcription.html?theme=dark&mode=start-secret`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Start voice input" }).click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Voice input could not start. Try again." });
    await alert.waitFor();
    expect(await alert.innerText()).not.toMatch(
      /FixtureProvider|fixture-secret|opaque-token|Bearer|sk-fixture/i,
    );
    expect(await page.locator("body").innerText()).not.toMatch(
      /FixtureProvider|fixture-secret|opaque-token|Bearer|sk-fixture/i,
    );
    expect(await page.getByRole("button", { name: "Retry voice input" }).count()).toBe(1);
    expect(failures).toEqual([]);
    await context.close();
  });

  test("empty finals remain correctable and the same accepted correction inserts once", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=light`, { waitUntil: "networkidle" });
    const textarea = page.getByRole("textbox", { name: "Message the agent" });
    await page.getByRole("button", { name: "Start voice input" }).click();
    const correction = page.getByRole("button", { name: "Emit empty then corrected final" });
    await correction.click();
    expect(await textarea.inputValue()).toBe(
      "Existing editable draft Corrected final is inserted once",
    );
    await correction.click();
    expect(await textarea.inputValue()).toBe(
      "Existing editable draft Corrected final is inserted once",
    );
    await context.close();
  });

  test("a hanging start is aborted at the local deadline and becomes retryable", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=dark&mode=hanging`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Voice input took too long to start. Try again." })
      .waitFor();
    expect(
      await page.evaluate(() => document.documentElement.dataset.transcriptionStartAborted),
    ).toBe("true");
    expect(await page.getByRole("button", { name: "Retry voice input" }).count()).toBe(1);
    await context.close();
  });

  test("Escape restores idle focus while hanging cancel and close run independently", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=light&mode=cleanup-hangs`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Stop voice input" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voice input" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Message the agent",
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.transcriptionCancelInvoked),
    ).toBe("true");
    expect(
      await page.evaluate(() => document.documentElement.dataset.transcriptionCloseInvoked),
    ).toBe("true");
    await context.close();
  });

  test("reconnect clears partials; keyboard Escape cancels and returns focus", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=dark`, { waitUntil: "networkidle" });
    const textarea = page.getByRole("textbox", { name: "Message the agent" });
    const mic = page.getByRole("button", { name: "Start voice input" });
    await mic.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Emit partial" }).click();
    await page.getByRole("button", { name: "Interrupt stream" }).click();
    await page.getByRole("status").filter({ hasText: "Reconnecting voice input…" }).waitFor();
    expect(await page.getByText("This partial stays ephemeral", { exact: true }).count()).toBe(0);
    expect(await textarea.inputValue()).toBe("Existing editable draft");
    await page.getByRole("button", { name: "Restore stream" }).click();
    await page.getByRole("button", { name: "Stop voice input" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voice input" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Message the agent",
    );
    await context.close();
  });

  test("reduced motion removes lifecycle spinner animation", async () => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=dark`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Interrupt stream" }).click();
    const animationName = await page
      .locator('[data-transcription-status="reconnecting"] svg')
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(animationName).toBe("none");
    await context.close();
  });
});

function observePageFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  return failures;
}
