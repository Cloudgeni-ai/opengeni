import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("personal resource attachments in Chromium", () => {
  let browser: Browser;
  let browserContext: BrowserContext;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
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
            await fetch(`${baseUrl}/test/personal-resource-attachments.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
    });
    browserContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    page = await browserContext.newPage();
    await page.goto(`${baseUrl}/test/personal-resource-attachments.html`, {
      waitUntil: "networkidle",
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browserContext?.close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("Create, Send, Steer and Continue authorize attached resources without another control", async () => {
    const control = page.locator("[data-personal-resource-attachment]");
    expect(await control.count()).toBe(0);
    expect(await page.getByRole("radio").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Create session" }).isDisabled()).toBe(false);
    await page.getByRole("button", { name: "Create session" }).click();
    expect(JSON.parse((await page.getByTestId("create-receipt").textContent()) ?? "{}")).toEqual({
      mode: "session",
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });

    await page.getByRole("button", { name: "Send" }).click();
    expect(JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}")).toEqual({
      mode: "session",
      expectedAuthorityEpoch: 3,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });
    await page.getByRole("button", { name: "Steer" }).click();
    expect(JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}")).toEqual({
      delivery: "steer",
      mode: "session",
      expectedAuthorityEpoch: 3,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });

    const existing = page.getByRole("region", { name: "Existing session Send and Steer" });
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    expect(JSON.parse((await page.getByTestId("create-receipt").textContent()) ?? "{}").mode).toBe(
      "session",
    );
    expect(await existing.getByTestId("failed-session-banner").textContent()).toContain(
      "matching personal-resource grant required",
    );
    expect(await existing.getByText("The child reports that its reviewed PR merged.").count()).toBe(
      1,
    );
    await existing.getByRole("button", { name: "Continue", exact: true }).click();
    expect(await existing.getByTestId("failed-session-banner").count()).toBe(1);
    expect(await existing.getByText("The child reports that its reviewed PR merged.").count()).toBe(
      1,
    );
    expect(
      JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}"),
    ).toMatchObject({ delivery: "continue", mode: "session", expectedAuthorityEpoch: 3 });
    await existing.getByRole("button", { name: "Send", exact: true }).click();
    expect(JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}").mode).toBe(
      "session",
    );
    await page.screenshot({
      fullPage: true,
      path: `${process.env.TMPDIR ?? "/tmp"}/personal-scope-mobile.png`,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      fullPage: true,
      path: `${process.env.TMPDIR ?? "/tmp"}/personal-scope-desktop.png`,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }, 60_000);

  test("recovery chunk loads only for status and fails without bypassing the submission fence", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    try {
      const loadingPage = await context.newPage();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await loadingPage.route(
        "**/src/components/personal-resource-attachment-control.tsx*",
        async (route) => {
          await held;
          await route.continue();
        },
      );
      await loadingPage.goto(`${baseUrl}/test/personal-resource-attachments.html`, {
        waitUntil: "domcontentloaded",
      });
      await loadingPage.getByRole("button", { name: "Send", exact: true }).waitFor();
      expect(await loadingPage.locator("[data-personal-resource-attachment]").count()).toBe(0);
      await loadingPage.getByRole("button", { name: "Simulate stale epoch" }).click();
      await loadingPage
        .getByRole("status")
        .filter({ hasText: "Loading personal resource options" })
        .first()
        .waitFor();
      expect(await loadingPage.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(
        true,
      );
      expect(await loadingPage.getByTestId("send-receipt").textContent()).toBe("");
      release();
      await loadingPage
        .getByRole("status")
        .filter({ hasText: "Personal resources were reloaded" })
        .first()
        .waitFor();
      expect(await loadingPage.getByRole("radio").count()).toBe(0);
      await loadingPage.close();
      const failedPage = await context.newPage();
      await failedPage.route(
        "**/src/components/personal-resource-attachment-control.tsx*",
        (route) => route.abort("failed"),
      );
      await failedPage.goto(`${baseUrl}/test/personal-resource-attachments.html`, {
        waitUntil: "domcontentloaded",
      });
      await failedPage.getByRole("button", { name: "Simulate stale epoch" }).click();
      await failedPage
        .getByRole("alert")
        .filter({ hasText: "Personal resource options are unavailable" })
        .first()
        .waitFor();
      expect(await failedPage.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(
        true,
      );
      expect(await failedPage.getByTestId("send-receipt").textContent()).toBe("");
      await failedPage.screenshot({
        fullPage: true,
        path: `${process.env.TMPDIR ?? "/tmp"}/personal-scope-fallback.png`,
      });
      await failedPage.getByRole("button", { name: "Truncate authority catalog" }).click();
      expect(await failedPage.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await failedPage.getByRole("alert").first().textContent()).toContain(
        "selected resource is unavailable",
      );
    } finally {
      await context.close();
    }
  }, 60_000);

  test("stale epoch reloads automatically while source loss and principal transition fence state", async () => {
    await page.getByRole("button", { name: "Simulate stale epoch" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Session authority changed" })
      .first()
      .waitFor();
    expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(false);
    expect(
      await page.getByRole("status").filter({ hasText: "Session authority changed" }).count(),
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Send" }).click();
    expect(
      JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}"),
    ).toMatchObject({
      mode: "session",
      expectedAuthorityEpoch: 4,
    });

    await page.getByRole("button", { name: "Lose source access" }).click();
    expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
    expect(
      await page.getByText(/Access to the selected personal resource changed/).count(),
    ).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Truncate authority catalog" }).click();
    const unavailableControl = page.locator("[data-personal-resource-attachment]").first();
    expect(await unavailableControl.count()).toBe(1);
    expect(await unavailableControl.getByRole("alert").textContent()).toContain(
      "selected personal resource is unavailable",
    );
    expect(await unavailableControl.getByRole("button", { name: "Retry" }).count()).toBe(1);
    expect(await unavailableControl.getByRole("status").textContent()).toContain(
      "first 400 personal resources",
    );
    expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);

    await page.getByRole("button", { name: "Switch principal" }).click();
    expect(await page.getByTestId("principal").textContent()).toBe("shared-user");
    expect(await page.locator("[data-personal-resource-attachment]").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(true);
  });
});
