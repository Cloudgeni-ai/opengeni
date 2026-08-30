import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const fixturePath = "/test/ai-gateway-connection.html";
const evidenceDir = new URL("../../.agent/evidence/ai-gateway-connection/", import.meta.url)
  .pathname;

describe("AI Gateway custom model settings in Chromium", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await mkdir(evidenceDir, { recursive: true });
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}${fixturePath}`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = existsSync("/usr/local/bin/chromium")
      ? "/usr/local/bin/chromium"
      : undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([context?.close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("supports exact add/remove flows with a polished desktop layout", async () => {
    await openFixture(page, baseUrl);
    await page.locator("summary").click();
    await page.getByText("2 models", { exact: true }).waitFor();
    expect(await page.getByText("Connected", { exact: true }).count()).toBe(1);
    expect(await page.getByLabel("Vercel AI Gateway model slug").count()).toBe(1);

    const slug = page.getByLabel("Vercel AI Gateway model slug");
    const add = page.getByRole("button", { name: "Add model" });
    await slug.fill("anthropic/claude sonnet");
    expect(await add.isDisabled()).toBe(true);
    await page
      .getByText("Use the exact printable slug with no spaces or |.", { exact: true })
      .waitFor();

    await slug.fill("fixture/fail-add");
    await add.click();
    await expectReceipt(page, {
      action: "create-model-error",
      upstreamModelId: "fixture/fail-add",
    });
    await waitForAriaLabelFocus(page, "Vercel AI Gateway model slug");
    expect(await slug.inputValue()).toBe("fixture/fail-add");

    await slug.fill("xai/grok-4.1-fast");
    expect(await add.isEnabled()).toBe(true);
    await add.click();
    await page.getByText("xai/grok-4.1-fast", { exact: true }).waitFor();
    await expectReceipt(page, { action: "create-model", upstreamModelId: "xai/grok-4.1-fast" });
    await page.getByRole("button", { name: "Remove xai/grok-4.1-fast" }).click();
    const removeDialog = page.getByRole("dialog");
    await removeDialog
      .getByRole("heading", { name: "Remove Gateway model “xai/grok-4.1-fast”?" })
      .waitFor();
    await removeDialog
      .getByText(
        "The model disappears from new selections. Already accepted turns keep their frozen definition so they can finish safely.",
        { exact: true },
      )
      .waitFor();
    await removeDialog.getByRole("button", { name: "Remove model", exact: true }).click();
    await page.getByText("xai/grok-4.1-fast", { exact: true }).waitFor({ state: "detached" });

    await assertAccessibleAndBounded(page);
    await page.screenshot({ path: `${evidenceDir}desktop-1280x900.png`, fullPage: true });
  }, 60_000);

  test("stays readable and bounded at a narrow mobile viewport", async () => {
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const mobilePage = await mobileContext.newPage();
    try {
      await openFixture(mobilePage, baseUrl);
      await mobilePage.locator("summary").click();
      await mobilePage.getByText("Models from your Gateway", { exact: true }).waitFor();

      const slug = mobilePage.getByLabel("Vercel AI Gateway model slug");
      const add = mobilePage.getByRole("button", { name: "Add model" });
      const key = mobilePage.getByLabel("Vercel AI Gateway key");
      const remove = mobilePage.getByRole("button", { name: "Remove deepseek/deepseek-v3.2" });
      expect(await slug.inputValue()).toBe("");
      expect(await slug.evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
      expect((await add.boundingBox())?.width).toBeGreaterThan(100);
      expect((await key.boundingBox())?.width).toBeGreaterThan(300);
      expect((await remove.boundingBox())?.width).toBeGreaterThanOrEqual(44);
      expect((await remove.boundingBox())?.height).toBeGreaterThanOrEqual(44);

      await assertAccessibleAndBounded(mobilePage);
      await mobilePage.screenshot({ path: `${evidenceDir}narrow-390x844.png`, fullPage: true });

      await mobilePage.setViewportSize({ width: 844, height: 390 });
      expect(await slug.evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
      await assertAccessibleAndBounded(mobilePage);

      await mobilePage.setViewportSize({ width: 1024, height: 768 });
      expect(await slug.evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
      await assertAccessibleAndBounded(mobilePage);

      await mobilePage.setViewportSize({ width: 390, height: 844 });
      const maximumSlug = "a".repeat(238);
      await slug.fill(maximumSlug);
      await add.click();
      await expectReceipt(mobilePage, { action: "create-model", upstreamModelId: maximumSlug });
      await mobilePage.getByRole("button", { name: `Remove ${maximumSlug}` }).click();
      const expectedTitle = `Remove Gateway model “${maximumSlug}”?`;
      const dialog = mobilePage.getByRole("dialog", { name: expectedTitle, exact: true });
      await dialog.waitFor();
      await dialog.getByRole("heading", { name: expectedTitle, exact: true }).waitFor();
      await assertDialogBounded(mobilePage, dialog);
      const dialogAxe = await new AxeBuilder({ page: mobilePage })
        .include('[role="dialog"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(dialogAxe.violations).toEqual([]);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await mobileContext.close();
    }
  }, 60_000);
});

async function openFixture(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "AI model connections", exact: true }).waitFor();
  await page.getByText("Bring your own Vercel AI Gateway", { exact: true }).waitFor();
}

async function expectReceipt(page: Page, expected: Record<string, unknown>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let receipt: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    receipt = JSON.parse(
      (await page.getByTestId("operation-receipt").textContent()) ?? "{}",
    ) as Record<string, unknown>;
    if (
      Object.entries(expected).every(
        ([key, value]) => JSON.stringify(receipt[key]) === JSON.stringify(value),
      )
    ) {
      expect(receipt).toMatchObject(expected);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(receipt).toMatchObject(expected);
}

async function waitForAriaLabelFocus(page: Page, ariaLabel: string): Promise<void> {
  await page.waitForFunction(
    (expectedAriaLabel) => document.activeElement?.getAttribute("aria-label") === expectedAriaLabel,
    ariaLabel,
  );
}

async function assertDialogBounded(page: Page, dialog: Locator): Promise<void> {
  const bounds = await dialog.evaluate((dialogElement) => {
    const title = dialogElement.querySelector<HTMLElement>('[data-slot="dialog-title"]');
    const rect = dialogElement.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      dialogClientWidth: dialogElement.clientWidth,
      dialogScrollWidth: dialogElement.scrollWidth,
      titleClientWidth: title?.clientWidth ?? -1,
      titleScrollWidth: title?.scrollWidth ?? -1,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  expect(bounds.documentScrollWidth).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  expect(bounds.dialogScrollWidth).toBeLessThanOrEqual(bounds.dialogClientWidth + 1);
  expect(bounds.titleClientWidth).toBeGreaterThan(0);
  expect(bounds.titleScrollWidth).toBeLessThanOrEqual(bounds.titleClientWidth + 1);
}

async function assertAccessibleAndBounded(page: Page): Promise<void> {
  await page.locator("[data-sonner-toast]").last().waitFor({ state: "detached", timeout: 10_000 });
  const axe = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
}
