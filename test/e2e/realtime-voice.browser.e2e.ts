import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";

import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir =
  process.env.OPENGENI_REALTIME_VOICE_EVIDENCE_DIR ?? "/tmp/opengeni-realtime-voice-evidence";
const variants = [
  { name: "mobile-dark", viewport: { width: 390, height: 844 }, theme: "dark", mobile: true },
  {
    name: "mobile-light",
    viewport: { width: 390, height: 844 },
    theme: "light",
    mobile: true,
  },
  {
    name: "desktop-dark",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
    mobile: false,
  },
  {
    name: "desktop-light",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    mobile: false,
  },
] as const;

type Measurement = {
  variant: (typeof variants)[number]["name"];
  documentOverflow: number;
  overlayContained: boolean;
  axeViolations: number;
  consoleFailures: string[];
};

describe("persistent realtime voice browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;
  const measurements: Measurement[] = [];

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await mkdir(evidenceDir, { recursive: true });
    const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
      cwd: `${repoRoot}/packages/react`,
      timeoutMs: 60_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(`Realtime voice demo build failed:\n${build.stdout}\n${build.stderr}`);
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
            await fetch(`${baseUrl}/realtime-voice.html`, {
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
      `${JSON.stringify({ fixture: "not-live-provider-proof", measurements }, null, 2)}\n`,
    );
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  test("both exact target modes stay accessible and bounded across responsive light/dark surfaces", async () => {
    for (const variant of variants) {
      const context = await browser.newContext({
        viewport: variant.viewport,
        colorScheme: variant.theme,
        hasTouch: variant.mobile,
        isMobile: variant.mobile,
      });
      const page = await context.newPage();
      const consoleFailures = observePageFailures(page);
      await page.goto(
        `${baseUrl}/realtime-voice.html?theme=${variant.theme}&layout=${variant.mobile ? "mobile" : "desktop"}`,
        { waitUntil: "networkidle" },
      );
      await page.waitForFunction(() => (globalThis as Record<string, unknown>).__ogReady === true);

      const overlay = page.locator("[data-persistent-voice-control]");
      const targetGroup = overlay.getByRole("group", { name: "Voice target" });
      const thisSession = targetGroup.getByRole("button", { name: "This session" });
      const workspaceMain = targetGroup.getByRole("button", { name: "Workspace main" });
      await expectPressed(thisSession, true);
      await expectPressed(workspaceMain, false);
      expect(
        await overlay
          .getByRole("button", {
            name: "Start realtime voice for This session — Production rollout audit",
          })
          .count(),
      ).toBe(1);

      await workspaceMain.focus();
      await page.keyboard.press("Enter");
      await expectPressed(thisSession, false);
      await expectPressed(workspaceMain, true);
      expect(
        await overlay
          .getByRole("button", {
            name: "Start realtime voice for Workspace main — OpenGeni Main Orchestrator",
          })
          .count(),
      ).toBe(1);
      expect(
        await overlay.locator('[title^="Workspace main — OpenGeni Main Orchestrator ("]').count(),
      ).toBe(1);
      expect(
        await page.getByText("Deterministic UI fixture · not live provider proof").count(),
      ).toBe(1);

      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const geometry = await page.evaluate(() => {
        const control = document.querySelector<HTMLElement>("[data-persistent-voice-control]");
        const rect = control?.getBoundingClientRect();
        return {
          documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          overlayContained:
            rect !== undefined &&
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight,
        };
      });
      measurements.push({
        variant: variant.name,
        ...geometry,
        axeViolations: axe.violations.length,
        consoleFailures,
      });
      expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(geometry.overlayContained).toBe(true);
      expect(axe.violations).toEqual([]);
      expect(consoleFailures).toEqual([]);

      if (variant.mobile) {
        await expectTouchTarget(thisSession);
        await expectTouchTarget(workspaceMain);
        await expectTouchTarget(
          overlay.getByRole("button", {
            name: "Start realtime voice for Workspace main — OpenGeni Main Orchestrator",
          }),
        );
        await expectTouchTarget(overlay.getByRole("button", { name: "Use text composer instead" }));
      }

      await page.screenshot({
        path: `${evidenceDir}/${variant.name}-workspace-main.png`,
        animations: "disabled",
      });
      await thisSession.click();
      await page.screenshot({
        path: `${evidenceDir}/${variant.name}-this-session.png`,
        animations: "disabled",
      });
      await context.close();
    }
  }, 120_000);

  test("fail-closed, reconnect, interruption, and text fallback states preserve ordinary session truth", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    const page = await context.newPage();
    const consoleFailures = observePageFailures(page);
    await page.goto(`${baseUrl}/realtime-voice.html?theme=dark&layout=desktop`, {
      waitUntil: "networkidle",
    });

    const unavailable = page.locator('[data-fixture-status="unavailable"]');
    expect(await unavailable.getByText("Protocol unavailable", { exact: true }).count()).toBe(1);
    expect(
      await unavailable.getByText("Experimental Codex audio protocol is not yet verified").count(),
    ).toBeGreaterThan(0);
    expect(
      await unavailable.getByRole("button", { name: /Start realtime voice/ }).isDisabled(),
    ).toBe(true);

    const overlay = page.locator("[data-persistent-voice-control]");
    await overlay.getByRole("button", { name: /Start realtime voice for This session/ }).click();
    expect(await overlay.locator('[data-realtime-voice-status="listening"]').count()).toBe(1);

    await page.getByRole("button", { name: "speaking", exact: true }).click();
    const interrupt = overlay.getByRole("button", { name: "Interrupt voice playback" });
    await interrupt.focus();
    await page.keyboard.press("Enter");
    expect(await overlay.locator('[data-realtime-voice-status="listening"]').count()).toBe(1);

    await page.getByRole("button", { name: "reconnecting", exact: true }).click();
    expect(await overlay.getByText("Reconnecting voice…").count()).toBeGreaterThan(0);
    await overlay.getByRole("button", { name: "Use text composer instead" }).click();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");

    const statusAnnouncement = overlay.getByRole("status");
    expect(await statusAnnouncement.innerText()).toContain(
      "Realtime voice for This session — Production rollout audit",
    );
    expect(await statusAnnouncement.innerText()).toContain("Reconnecting voice");
    expect(consoleFailures).toEqual([]);
    await page.screenshot({
      path: `${evidenceDir}/desktop-dark-reconnecting-text-fallback.png`,
      animations: "disabled",
    });
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

async function expectPressed(locator: Locator, expected: boolean): Promise<void> {
  expect(await locator.getAttribute("aria-pressed")).toBe(String(expected));
}

async function expectTouchTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
