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

describe("native composer voice-input browser acceptance", () => {
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
            providerConfigurationVisible:
              /gpt-transcribe|api key|BYOK|provider ID|azure-openai/i.test(document.body.innerText),
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
        await context.close();
      }
    }
  }, 90_000);

  test("stop immediately transcribes into an editable draft and ordinary Send still sends", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=light`, { waitUntil: "networkidle" });
    const textarea = page.getByRole("textbox", { name: "Message the agent" });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Stop and transcribe" }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.transcriptionUpload === "completed",
    );
    expect(await textarea.inputValue()).toBe("Existing editable draft fixture transcript");
    await textarea.fill("Edited final transcript");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("Sent: Edited final transcript", { exact: true }).waitFor();
    await page.screenshot({
      path: `${evidenceDir}/editable-final-and-send.png`,
      animations: "disabled",
    });
    await context.close();
  });

  test("mobile recording keeps Cancel and Stop visible in a crowded composer", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=dark&chrome=crowded`, {
      waitUntil: "networkidle",
    });

    await page.getByRole("button", { name: "Start voice input" }).click();
    const stop = page.getByRole("button", { name: "Stop and transcribe" });
    const cancel = page.getByRole("button", { name: "Stop without transcribing" });
    await stop.waitFor();

    const audit = await page.locator(".og-composer-footer").evaluate((footer) => {
      const button = (label: string) =>
        footer.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      const stopButton = button("Stop and transcribe");
      const cancelButton = button("Stop without transcribing");
      const stopRect = stopButton?.getBoundingClientRect();
      const cancelRect = cancelButton?.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const transcriptionRect = footer
        .querySelector<HTMLElement>("[data-transcription-capturing]")
        ?.getBoundingClientRect();
      const visible = (label: string) => {
        const element = footer.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
        return element?.checkVisibility() ?? null;
      };
      return {
        overflow: footer.scrollWidth - footer.clientWidth,
        stop: stopRect
          ? {
              width: stopButton?.offsetWidth ?? 0,
              height: stopButton?.offsetHeight ?? 0,
              fullyVisible:
                stopRect.left >= footerRect.left &&
                stopRect.right <= footerRect.right &&
                transcriptionRect !== undefined &&
                stopRect.left >= transcriptionRect.left &&
                stopRect.right <= transcriptionRect.right,
            }
          : null,
        cancel: cancelRect
          ? {
              width: cancelButton?.offsetWidth ?? 0,
              height: cancelButton?.offsetHeight ?? 0,
              fullyVisible:
                cancelRect.left >= footerRect.left &&
                cancelRect.right <= footerRect.right &&
                transcriptionRect !== undefined &&
                cancelRect.left >= transcriptionRect.left &&
                cancelRect.right <= transcriptionRect.right,
            }
          : null,
        toolsVisible: visible("Open composer tools"),
        modelVisible: visible("Model and effort"),
        realtimeVisible: visible("Start realtime voice"),
        pauseVisible: visible("Pause this workstream"),
        sendVisible: visible("Send message"),
      };
    });

    expect(audit.overflow).toBeLessThanOrEqual(1);
    expect(audit.stop?.fullyVisible).toBe(true);
    expect(audit.cancel?.fullyVisible).toBe(true);
    expect(Math.min(audit.stop?.width ?? 0, audit.stop?.height ?? 0)).toBeGreaterThanOrEqual(44);
    expect(Math.min(audit.cancel?.width ?? 0, audit.cancel?.height ?? 0)).toBeGreaterThanOrEqual(
      44,
    );
    expect(audit.toolsVisible).toBe(false);
    expect(audit.modelVisible).toBe(false);
    expect(audit.realtimeVisible).toBe(false);
    expect(audit.pauseVisible).toBe(false);
    expect(audit.sendVisible).toBe(false);

    await cancel.click();
    await page.getByRole("button", { name: "Start voice input" }).waitFor();
    expect(await page.getByRole("button", { name: "Open composer tools" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Model and effort" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Start realtime voice" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Pause this workstream" }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("button", { name: "Send message" }).isVisible()).toBe(true);
    await context.close();
  });

  test("embedded container composer keeps a saved recording readable at phone width", async () => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=light&chrome=crowded&basis=container`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Stop and transcribe" }).waitFor();
    // Longer than an accidental start: Escape keeps the dictation.
    await page.waitForTimeout(3_500);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Transcribe saved recording" }).waitFor();
    const audit = await page.locator(".og-composer-footer").evaluate((footer) => {
      const label = footer.querySelector<HTMLElement>(".og-transcription-recovered-label");
      const send = footer.querySelector<HTMLElement>('button[aria-label="Send message"]');
      const footerRect = footer.getBoundingClientRect();
      const inside = (element: HTMLElement | null) => {
        const rect = element?.getBoundingClientRect();
        return Boolean(
          rect &&
          rect.width > 0 &&
          rect.left >= footerRect.left - 1 &&
          rect.right <= footerRect.right + 1,
        );
      };
      return {
        text: label?.textContent ?? null,
        truncated: label ? label.scrollHeight > label.clientHeight + 1 : true,
        labelInside: inside(label),
        sendInside: inside(send),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(audit.text).toBe("Recording saved on this device.");
    expect(audit.truncated).toBe(false);
    expect(audit.labelInside).toBe(true);
    expect(audit.sendInside).toBe(true);
    expect(audit.overflow).toBeLessThanOrEqual(1);
    await context.close();
  });

  test("reload recovers a timesliced recording without reopening the microphone", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=dark`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.transcriptionChunkEmitted === "true",
    );
    expect(await page.evaluate(() => document.documentElement.dataset.transcriptionTimeslice)).toBe(
      "5000",
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.transcriptionMicRequests),
    ).toBe("1");

    await page.reload({ waitUntil: "networkidle" });
    // The interrupted capture transcribes automatically but is never appended
    // behind the user's back: it waits for an explicit insert.
    const insert = page.getByRole("button", { name: "Insert saved transcript" });
    await insert.waitFor();
    expect(
      await page.evaluate(() => document.documentElement.dataset.transcriptionMicRequests),
    ).toBeUndefined();
    expect(
      await page.getByText("Transcript saved. Insert it into your draft?").count(),
    ).toBeGreaterThan(0);
    await insert.click();
    expect(await page.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
      "Existing editable draft fixture transcript",
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.transcriptionMicRequests),
    ).toBeUndefined();
    await context.close();
  });

  test("permission denial preserves the draft and Escape retains a hanging upload", async () => {
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
      .filter({ hasText: "Microphone access is blocked. Allow it in site settings, then try again." })
      .waitFor();
    expect(await denied.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
      "Existing editable draft",
    );
    expect(await denied.getByRole("button", { name: "Retry voice input" }).count()).toBe(1);

    const hanging = await context.newPage();
    await hanging.goto(`${baseUrl}/transcription.html?theme=light&mode=hanging`, {
      waitUntil: "networkidle",
    });
    await hanging.getByRole("button", { name: "Start voice input" }).click();
    await hanging.getByRole("button", { name: "Stop and transcribe" }).click();
    await hanging.waitForFunction(
      () => document.documentElement.dataset.transcriptionUpload === "started",
    );
    await hanging.keyboard.press("Escape");
    await hanging.getByRole("button", { name: "Transcribe saved recording" }).waitFor();
    expect(await hanging.getByRole("button", { name: "Discard saved recording" }).count()).toBe(1);
    expect(await hanging.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
      "Existing editable draft",
    );
    await context.close();
  });

  test("reduced motion removes lifecycle spinner animation while recording", async () => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/transcription.html?theme=dark`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Start voice input" }).click();
    await page.getByRole("button", { name: "Stop and transcribe" }).waitFor();
    // Recording chrome uses stop/cancel icons, not a spinner; assert no forced spin remains.
    const animationName = await page
      .locator(
        '[data-transcription-status="recording"] button[aria-label="Stop and transcribe"] svg',
      )
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(animationName === "none" || animationName === "").toBe(true);
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
