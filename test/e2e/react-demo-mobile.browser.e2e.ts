import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDirectory =
  process.env.OPENGENI_REACT_DEMO_MOBILE_EVIDENCE_DIR ?? "/tmp/opengeni-react-demo-mobile-evidence";

const VIEWPORTS = [
  { name: "320", width: 320, height: 700, compact: true },
  { name: "360", width: 360, height: 800, compact: true },
  { name: "375", width: 375, height: 812, compact: true },
  { name: "390", width: 390, height: 844, compact: true },
  { name: "430", width: 430, height: 932, compact: true },
  { name: "768", width: 768, height: 1024, compact: true },
  { name: "1024", width: 1024, height: 768, compact: false },
  { name: "1440", width: 1440, height: 1000, compact: false },
] as const;

describe("public React demo mobile product acceptance", () => {
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

  test("session-first information architecture stays bounded and accessible at every supported width", async () => {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.compact,
        isMobile: viewport.width <= 430,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const failures = observePageFailures(page);
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "OpenGeni React demo" }).waitFor();
      await page.getByRole("heading", { name: "Staging operations" }).waitFor();

      expect(await page.title()).toBe("OpenGeni React demo — durable agent sessions");
      expect(await page.locator('meta[name="viewport"]').getAttribute("content")).toContain(
        "viewport-fit=cover",
      );
      await expectNoHorizontalOverflow(page);
      expect(
        await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      ).toBe(true);

      if (viewport.compact) {
        const navigation = page.getByRole("navigation", { name: "Demo views" });
        expect(await navigation.getByRole("button").count()).toBe(4);
        expect(await visibleWorkspaceDialog(page).count()).toBe(0);
        await expectCriticalTouchTargets(page);

        await navigation.getByRole("button", { name: "Fleet", exact: true }).click();
        await page.getByRole("heading", { name: "Fleet", exact: true }).waitFor();
        expect(new URL(page.url()).hash).toBe("#fleet");

        await navigation.getByRole("button", { name: "Schedules", exact: true }).click();
        await page.getByRole("heading", { name: "Scheduled tasks" }).waitFor();
        expect(new URL(page.url()).hash).toBe("#schedules");

        await navigation.getByRole("button", { name: "Workspace", exact: true }).click();
        await visibleWorkspaceDialog(page).waitFor();
        expect(
          await page.getByRole("tab", { name: /^Changes/ }).getAttribute("aria-selected"),
        ).toBe("true");
        await page.getByRole("button", { name: "Close workspace" }).click();
        await visibleWorkspaceDialog(page).waitFor({ state: "hidden" });
      } else {
        expect(await page.getByRole("navigation", { name: "Demo views" }).count()).toBe(0);
        expect(await page.getByRole("heading", { name: "Fleet", exact: true }).count()).toBe(1);
        expect(await page.getByRole("heading", { name: "Scheduled tasks" }).count()).toBe(1);
        expect(await page.locator("[data-workspace-surface]").count()).toBeGreaterThan(0);
      }

      await expectAxeClean(page);
      await capture(page, `${viewport.name}-responsive.png`);
      expect(failures).toEqual([]);
      await context.close();
    }
  }, 150_000);

  test("phone interaction preserves session state, confirmations, focus, browser history, orientation, and offline-after-load use", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const failures = observePageFailures(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Staging operations" }).waitFor();

    const root = page.locator(".og-root").first();
    await page.getByRole("button", { name: "Use light theme" }).click();
    expect(await root.getAttribute("data-og-theme")).toBe("light");

    const model = page.getByRole("combobox", { name: "Model" });
    await model.selectOption("accounts/fireworks/models/glm-5p2");
    expect(await model.inputValue()).toBe("accounts/fireworks/models/glm-5p2");

    const textbox = page.getByRole("textbox", { name: "Message the agent" });
    const submittedPrompt = "Summarize the rollout risk in one sentence.";
    await textbox.fill(submittedPrompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page
      .locator('[id^="og-user-message-"]')
      .getByText(submittedPrompt, { exact: true })
      .waitFor({ timeout: 15_000 });
    await waitForBodyText(page, 'Got it — "Summarize the rollout risk', 15_000);
    expect(await textbox.inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "Send message" }).isDisabled()).toBe(true);
    await capture(page, "390-after-send.png");

    const keyboardPrompt = "Confirm the keyboard send clears this draft.";
    await textbox.fill(keyboardPrompt);
    await textbox.press("Enter");
    await page
      .locator('[id^="og-user-message-"]')
      .getByText(keyboardPrompt, { exact: true })
      .waitFor({ timeout: 15_000 });
    expect(await textbox.inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "Send message" }).isDisabled()).toBe(true);

    await openClearConfirmation(page, textbox);
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.getByRole("button", { name: "Run /clear" }).count()).toBe(0);
    await openClearConfirmation(page, textbox);
    await page.getByRole("button", { name: "Run /clear" }).click();
    await page.getByRole("status").filter({ hasText: "Context cleared." }).waitFor();

    const navigation = page.getByRole("navigation", { name: "Demo views" });
    const workspaceButton = navigation.getByRole("button", { name: "Workspace", exact: true });
    await workspaceButton.click();
    const workspace = visibleWorkspaceDialog(page);
    await workspace.waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("tab");
    await page.keyboard.press("ArrowRight");
    expect(
      await page.getByRole("tab", { name: "Files", exact: true }).getAttribute("aria-selected"),
    ).toBe("true");
    await expectAxeClean(page);
    await capture(page, "390-workspace-files.png");

    await page.keyboard.press("Escape");
    await workspace.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Workspace");
    expect(await workspaceButton.getAttribute("aria-expanded")).toBe("false");
    await page.goForward();
    await workspace.waitFor();
    await page.goBack();
    await workspace.waitFor({ state: "hidden" });

    await workspaceButton.click();
    await workspace.waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await workspace.waitFor();
    await page.keyboard.press("Escape");
    await workspace.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Workspace");
    expect(await workspaceButton.getAttribute("aria-expanded")).toBe("false");

    await navigation.getByRole("button", { name: "Fleet", exact: true }).click();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Fleet", exact: true }).waitFor();
    expect(new URL(page.url()).hash).toBe("#fleet");
    await page.goBack();
    await page.getByRole("heading", { name: "Staging operations" }).waitFor();

    await page.setViewportSize({ width: 844, height: 390 });
    await expectNoHorizontalOverflow(page);
    expect(await page.getByRole("navigation", { name: "Demo views" }).count()).toBe(1);
    expect(
      await root.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    ).toBe(390);
    await capture(page, "390-landscape.png");
    await page.setViewportSize({ width: 390, height: 844 });

    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await navigation.getByRole("button", { name: "Fleet", exact: true }).click();
    await page.getByRole("heading", { name: "Fleet", exact: true }).waitFor();
    await navigation.getByRole("button", { name: "Schedules", exact: true }).click();
    await page.getByRole("heading", { name: "Scheduled tasks" }).waitFor();
    await navigation.getByRole("button", { name: "Session", exact: true }).click();
    await page.getByRole("heading", { name: "Staging operations" }).waitFor();
    await textbox.fill("Keep the loaded scripted demo usable offline.");
    expect(await textbox.inputValue()).toBe("Keep the loaded scripted demo usable offline.");
    await expectNoHorizontalOverflow(page);
    await context.setOffline(false);

    await expectAxeClean(page);
    expect(failures).toEqual([]);
    await context.close();
  }, 90_000);

  test("withheld script delivery shows a stable, accessible boot state before hydration", async () => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const html = await (await fetch(baseUrl)).text();
    const bootOnlyHtml = html.replace('<script type="module" src="/main.tsx"></script>', "");
    expect(bootOnlyHtml).not.toBe(html);
    await page.setContent(bootOnlyHtml, { waitUntil: "domcontentloaded" });
    await page.getByRole("main", { name: "Loading OpenGeni React demo" }).waitFor();
    expect(await page.getByText("Loading the scripted manager session…").count()).toBe(1);
    expect(
      await page
        .getByRole("main", { name: "Loading OpenGeni React demo" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    await expectNoHorizontalOverflow(page);
    await expectAxeClean(page);
    await capture(page, "360-slow-boot.png");

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Staging operations" }).waitFor();
    expect(await page.getByRole("main", { name: "Loading OpenGeni React demo" }).count()).toBe(0);
    await expectNoHorizontalOverflow(page);
    await context.close();
  }, 45_000);
});

async function openClearConfirmation(page: Page, textbox: Locator): Promise<void> {
  await textbox.fill("/");
  const listbox = page.getByRole("listbox", { name: "Slash commands" });
  await listbox.waitFor();
  await listbox.getByRole("option").filter({ hasText: "/clear" }).last().click();
  await page.getByRole("button", { name: "Run /clear" }).waitFor();
}

function visibleWorkspaceDialog(page: Page): Locator {
  return page.locator('[role="dialog"][aria-label="Workspace"]:not([hidden])');
}

async function expectCriticalTouchTargets(page: Page): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Demo views" });
  const targets: Locator[] = [
    page.getByRole("button", { name: /Use (light|dark) theme/ }),
    ...Array.from({ length: 4 }, (_, index) => navigation.getByRole("button").nth(index)),
    page.getByRole("button", { name: "Copy message" }).first(),
    page.getByRole("button", { name: /^(Thinking|Thought)/ }).first(),
    page.getByRole("textbox", { name: "Message the agent" }),
    page.getByRole("combobox", { name: "Model" }),
    page.getByRole("button", { name: "Pause this workstream" }),
    page.getByRole("button", { name: "Send message" }),
  ];

  for (const target of targets) {
    await target.waitFor();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(43.5);
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function waitForBodyText(page: Page, expected: string, timeout = 8_000): Promise<void> {
  await page.waitForFunction((text) => document.body.innerText.includes(text), expected, {
    timeout,
  });
}

async function expectAxeClean(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
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
  page.on("requestfailed", (request) => {
    if (!request.url().startsWith("ws:")) failures.push(`request:${request.url()}`);
  });
  return failures;
}
