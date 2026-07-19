import AxePlaywrightBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
let baseUrl = "";

describe("session archive browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    try {
      browser = await chromium.launch();
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
              await fetch(`${baseUrl}/session-archive.html`, {
                signal: AbortSignal.timeout(2_000),
              }).catch(() => null)
            )?.ok === true,
          timeoutMs: 45_000,
        },
      );
    } catch (error) {
      await demo?.stop().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 60_000);

  test("desktop confirmation is named, focus-trapped, checksum-bound, and restorable", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await page.goto(archiveUrl("archive", "ready", "light"), { waitUntil: "networkidle" });

    const opener = page.getByRole("button", { name: "Review archive" });
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole("alertdialog", { name: "Archive this session tree?" });
    await dialog.waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Cancel");
    expect(await dialog.textContent()).toContain(
      "does not delete, pause, cancel, or stop live work",
    );
    expect(await dialog.textContent()).toContain("2 sessions");
    expect(await dialog.textContent()).toContain(`sha256:${"a".repeat(64)}`);

    const close = dialog.getByRole("button", { name: "Close archive review" });
    const confirm = dialog.getByRole("button", { name: "Archive 2 sessions" });
    await confirm.focus();
    await page.keyboard.press("Tab");
    expect(await close.evaluate((element) => element === document.activeElement)).toBe(true);
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    expect(await confirm.evaluate((element) => element === document.activeElement)).toBe(true);

    await expectNoAxeViolations(page, "[data-session-archive-overlay]");
    await expectNoViewportOverflow(page);
    await page.screenshot({
      path: "/tmp/ope61-session-archive-desktop-light.png",
      fullPage: true,
    });

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
    await context.close();
  }, 30_000);

  test("mobile archive uses touch targets and produces a durable no-resume banner", async () => {
    const context = await mobileContext(browser);
    const page = await context.newPage();
    await page.goto(archiveUrl("archive", "ready", "dark"), { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Review archive" }).tap();
    const dialog = page.getByRole("alertdialog", { name: "Archive this session tree?" });
    await dialog.waitFor();

    await expectNoViewportOverflow(page);
    await expectMinimumTouchTargets(dialog);
    await expectNoAxeViolations(page, "[data-session-archive-overlay]");
    await page.screenshot({
      path: "/tmp/ope61-session-archive-mobile-dark.png",
      fullPage: true,
    });

    await dialog.getByRole("button", { name: "Archive 2 sessions" }).tap();
    await dialog.waitFor({ state: "hidden" });
    const banner = page.getByRole("region", { name: "Archived session" });
    await banner.waitFor();
    expect(await banner.textContent()).toContain("execution is fenced");
    expect(await banner.textContent()).toContain("Unarchive does not resume");
    await expectMinimumTouchTargets(banner);
    await expectNoAxeViolations(page, '[aria-label="Archived session"]');
    await context.close();
  }, 30_000);

  test("unarchive names no-resume semantics and blockers fail closed without truncating count", async () => {
    const context = await mobileContext(browser);
    const page = await context.newPage();
    await page.goto(archiveUrl("unarchive", "blocked", "light"), {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Review unarchive" }).tap();
    const dialog = page.getByRole("alertdialog", { name: "Unarchive this session tree?" });
    await dialog.waitFor();

    expect(await dialog.textContent()).toContain("will not resume work");
    expect(await dialog.textContent()).toContain("Another overlapping seal");
    expect(await dialog.textContent()).toContain("Settle 24 live-work blockers");
    expect(await dialog.textContent()).toContain("And 4 more blockers");
    expect(await dialog.getByRole("button", { name: "Unarchive 2 sessions" }).isDisabled()).toBe(
      true,
    );
    await expectNoViewportOverflow(page);
    await expectMinimumTouchTargets(dialog);
    await expectNoAxeViolations(page, "[data-session-archive-overlay]");

    await page.goto(archiveUrl("unarchive", "ready", "dark"), { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Review unarchive" }).tap();
    const readyDialog = page.getByRole("alertdialog", { name: "Unarchive this session tree?" });
    await readyDialog.waitFor();
    expect(
      await readyDialog.getByRole("button", { name: "Unarchive 2 sessions" }).isEnabled(),
    ).toBe(true);
    await expectNoAxeViolations(page, "[data-session-archive-overlay]");
    await context.close();
  }, 30_000);
});

function archiveUrl(
  action: "archive" | "unarchive",
  state: "ready" | "blocked",
  theme: "light" | "dark",
): string {
  return `${baseUrl}/session-archive.html?${new URLSearchParams({ action, state, theme })}`;
}

async function mobileContext(browser: Browser): Promise<BrowserContext> {
  return await browser.newContext({
    viewport: { width: 320, height: 720 },
    isMobile: true,
    hasTouch: true,
  });
}

async function expectNoViewportOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectMinimumTouchTargets(scope: ReturnType<Page["getByRole"]>): Promise<void> {
  const undersized = await scope.locator("button:not([disabled])").evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.height > 0;
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((button) => button.width < 44 || button.height < 44),
  );
  expect(undersized).toEqual([]);
}

async function expectNoAxeViolations(page: Page, include: string): Promise<void> {
  const results = await new AxePlaywrightBuilder({ page })
    .include(include)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}
