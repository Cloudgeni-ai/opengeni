import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await browserContext.newPage();
    await page.goto(`${baseUrl}/test/personal-resource-attachments.html`, {
      waitUntil: "networkidle",
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browserContext?.close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("create and Send/Steer use automatic message-only authority plus exact shared warning", async () => {
    const control = page.locator("[data-personal-resource-attachment]");
    expect(await control.first().ariaSnapshot()).toContain("Private deploy keys");
    expect(await control.first().locator("fieldset").count()).toBe(0);
    expect(await control.first().getByText("Your resource access").count()).toBe(0);
    expect(await control.first().getByRole("radiogroup").count()).toBe(0);
    expect(await control.first().getByRole("radio").count()).toBe(0);
    expect(await control.first().getByRole("checkbox").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Create session" }).isDisabled()).toBe(false);
    expect(await control.first().textContent()).toContain("used only for messages you send");
    expect(await control.first().textContent()).toContain("cannot use your credential");
    await page.getByRole("button", { name: "Create session" }).click();
    expect(JSON.parse((await page.getByTestId("create-receipt").textContent()) ?? "{}")).toEqual({
      mode: "once",
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });

    await page.getByRole("button", { name: "Send" }).click();
    expect(JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}")).toEqual({
      mode: "once",
      expectedAuthorityEpoch: 3,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });
    await page.getByRole("button", { name: "Steer" }).click();
    expect(JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}")).toEqual({
      delivery: "steer",
      mode: "once",
      expectedAuthorityEpoch: 3,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }, 60_000);

  test("stale epoch reloads automatically while source loss and principal transition fence state", async () => {
    await page.getByRole("button", { name: "Simulate stale epoch" }).click();
    expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(false);
    expect(
      await page.getByRole("status").filter({ hasText: "Session authority changed" }).count(),
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Send" }).click();
    expect(
      JSON.parse((await page.getByTestId("send-receipt").textContent()) ?? "{}"),
    ).toMatchObject({
      mode: "once",
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
