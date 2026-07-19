import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = `${repoRoot}/docs/design/evidence/transcription`;
const captureEvidence = process.env.OPE11_CAPTURE_EVIDENCE === "1";

function systemChromium(): string | undefined {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/local/bin/chromium",
    "/usr/bin/chromium",
  ].find((path): path is string => Boolean(path && existsSync(path)));
}

type Case = {
  view: string;
  theme: "light" | "dark";
  width: 360 | 375 | 768 | 1440;
  expectedLabel: string;
  focus?: boolean;
};

const cases: Case[] = [
  { view: "partial", theme: "dark", width: 360, expectedLabel: "Stop voice dictation" },
  { view: "permission", theme: "light", width: 360, expectedLabel: "Retry voice dictation" },
  { view: "cancelled", theme: "dark", width: 375, expectedLabel: "Start voice dictation" },
  { view: "error", theme: "light", width: 375, expectedLabel: "Retry voice dictation" },
  { view: "reconnecting", theme: "dark", width: 768, expectedLabel: "Cancel voice dictation" },
  { view: "final", theme: "light", width: 768, expectedLabel: "Start voice dictation" },
  {
    view: "listening",
    theme: "dark",
    width: 1440,
    expectedLabel: "Stop voice dictation",
    focus: true,
  },
  {
    view: "disabled",
    theme: "light",
    width: 1440,
    expectedLabel: "Voice dictation unavailable",
  },
  { view: "requesting", theme: "dark", width: 375, expectedLabel: "Cancel voice dictation" },
  { view: "idle", theme: "light", width: 1440, expectedLabel: "Start voice dictation" },
];

describe("voice dictation browser evidence", () => {
  let server: StartedProcess;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "demo",
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
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
    const executablePath = systemChromium();
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), server?.stop()]);
  });

  test("covers responsive themes, states, focus, screen-reader semantics, and local-only fixtures", async () => {
    if (captureEvidence) await Bun.$`mkdir -p ${evidenceDir}`;

    for (const current of cases) {
      const context = await browser.newContext({
        viewport: { width: current.width, height: current.width < 500 ? 780 : 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const requests: string[] = [];
      const pageErrors: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const query = new URLSearchParams({
        view: current.view,
        theme: current.theme,
        ...(current.focus ? { focus: "mic" } : {}),
      });
      await page.goto(`${baseUrl}/transcription.html?${query}`);
      await page.waitForFunction(() => globalThis.__ogReady === true);

      const dictation = page.getByRole("button", { name: current.expectedLabel });
      await dictation.waitFor();
      expect(pageErrors).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(requests.every((url) => new URL(url).origin === new URL(baseUrl).origin)).toBe(true);

      if (current.focus) {
        expect(await dictation.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
      }
      if (current.view === "disabled") expect(await dictation.isDisabled()).toBe(true);
      if (current.view === "partial") {
        await page.getByText("Schedule the production readiness review", { exact: true }).waitFor();
        expect(await page.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
          "Add this to the release note:",
        );
      }
      if (current.view === "permission") {
        await page
          .getByRole("alert")
          .getByText(/Microphone permission was denied/)
          .waitFor();
      }
      if (current.view === "cancelled") {
        await page.getByText("Dictation cancelled", { exact: true }).waitFor();
        expect(await page.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
          "Add this to the release note:",
        );
      }
      if (current.view === "error") {
        await page
          .getByRole("alert")
          .getByText(/temporarily unavailable/)
          .waitFor();
      }
      if (current.view === "reconnecting") {
        await page.getByText("Reconnecting in 2s…", { exact: true }).waitFor();
      }
      if (current.view === "final") {
        expect(await page.getByRole("textbox", { name: "Message the agent" }).inputValue()).toBe(
          "Add this to the release note: Schedule the production readiness review for tomorrow morning.",
        );
      }
      if (current.view === "requesting") {
        await page.getByText("Allow microphone access…", { exact: true }).waitFor();
      }

      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          targets: violation.nodes.map((node) => node.target),
        })),
      ).toEqual([]);

      if (captureEvidence) {
        await page.screenshot({
          path: `${evidenceDir}/${current.width}-${current.theme}-${current.view}.png`,
          animations: "disabled",
        });
      }
      await context.close();
    }
  }, 120_000);

  test("final transcript remains editable and sends through the ordinary composer", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 900 } });
    const page = await context.newPage();
    const requests: string[] = [];
    const pageErrors: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/transcription.html?view=final&theme=light`);
    await page.waitForFunction(() => globalThis.__ogReady === true);
    const composer = page.getByRole("textbox", { name: "Message the agent" });
    await composer.fill(`${await composer.inputValue()} Edited after dictation.`);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("Draft sent from the deterministic harness.", { exact: true }).waitFor();
    expect(await composer.inputValue()).toBe("");
    expect(pageErrors).toEqual([]);
    expect(requests.every((url) => new URL(url).origin === new URL(baseUrl).origin)).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (captureEvidence) {
      await page.screenshot({
        path: `${evidenceDir}/768-light-final-edited-and-sent.png`,
        animations: "disabled",
      });
    }
    await context.close();
  });
});

declare global {
  var __ogReady: boolean | undefined;
}
