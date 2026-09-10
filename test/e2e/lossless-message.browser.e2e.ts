import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

describe("lossless chat message display and copy", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      ["bun", "run", "vite", ".", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: new URL("../../packages/react/demo", import.meta.url).pathname,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      "/opt/google/chrome/chrome",
      "/usr/local/bin/chromium",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  for (const live of [false, true]) {
    test(`reads and copies every byte after ${live ? "streaming" : "history reload"}`, async () => {
      const context = await browser.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseUrl}/lossless-message.html?live=${live ? 1 : 0}`);
        try {
          await page.getByText("Paragraph 899:", { exact: false }).waitFor({ timeout: 10_000 });
        } catch (error) {
          throw new Error(
            `Message not rendered: ${JSON.stringify(errors)}; ${await page.locator("body").innerText()}`,
            { cause: error },
          );
        }
        const text = await page.evaluate(
          () => (window as unknown as { losslessExpectedText: string }).losslessExpectedText,
        );
        expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(96 * 1024);
        const body = page.locator(
          '[data-og-annotation-source-key="11111111-1111-4111-8111-111111111111"]',
        );
        expect(await body.innerText()).toBe(text);
        expect(await page.getByRole("alert").count()).toBe(0);
        await page
          .getByRole("button", { name: "Copy message", exact: true })
          .click({ force: true });
        await page.waitForFunction(
          async () =>
            (await navigator.clipboard.readText()) ===
            (window as unknown as { losslessExpectedText: string }).losslessExpectedText,
        );
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
  }
});
