import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("restored new-session attachment preview in Chromium", () => {
  let browser: Browser;
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
            await fetch(`${baseUrl}/test/restored-attachment-preview.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    page = await context.newPage();
    await page.goto(`${baseUrl}/test/restored-attachment-preview.html`, {
      waitUntil: "networkidle",
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([page?.context().close(), browser?.close(), web?.stop()]);
  }, 30_000);

  test("paste, route return, and click restore the expandable image without eager work", async () => {
    await page.getByRole("textbox", { name: "Message the agent" }).evaluate((input) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(
          ["<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/>"],
          "pasted-screenshot.svg",
          {
            type: "image/svg+xml",
          },
        ),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    });

    const freshPreview = page.getByRole("button", { name: "Preview pasted-screenshot.svg" });
    await freshPreview.waitFor();
    expect(await freshPreview.isVisible()).toBe(true);
    expect(await freshPreview.locator("img").count()).toBe(1);

    await page.getByRole("button", { name: "Other session" }).click();
    expect(await page.getByRole("heading", { name: "Other session" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "New session" }).click();

    const restoredPreview = page.getByRole("button", { name: "Preview pasted-screenshot.svg" });
    await restoredPreview.waitFor();
    expect(await restoredPreview.isVisible()).toBe(true);
    expect(await restoredPreview.locator("img").count()).toBe(0);
    expect(await page.getByTestId("preview-request-count").textContent()).toBe(
      "Preview requests: 0",
    );

    await restoredPreview.click();
    const dialog = page.getByRole("dialog", { name: "Attachment preview" });
    await dialog.waitFor();
    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.locator("img").getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(await page.getByTestId("preview-request-count").textContent()).toBe(
      "Preview requests: 1",
    );

    // Visibility does not imply the lightbox's opacity animations have settled,
    // even with reduced motion. Audit the fully presented dialog and backdrop.
    await page.waitForFunction(
      () => {
        const content = document.querySelector('[role="dialog"][aria-label="Attachment preview"]');
        const overlay = document.querySelector('.bg-black\\/90[data-state="open"]');
        return (
          content !== null &&
          overlay !== null &&
          getComputedStyle(content).opacity === "1" &&
          getComputedStyle(overlay).opacity === "1"
        );
      },
      undefined,
      { timeout: 5_000 },
    );

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
  }, 60_000);
});
