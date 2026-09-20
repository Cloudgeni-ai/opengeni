import { afterAll, beforeAll, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, firefox, webkit, type Browser } from "playwright";

const engine = process.env.OPENGENI_ACCOUNT_BROWSER_ENGINE ?? "chromium";
let browser: Browser;
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
      cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
      ready: async () =>
        (await fetch(`${baseUrl}/test/managed-actor-response.html`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    },
  );
  if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit") {
    throw new Error(`Unsupported browser: ${engine}`);
  }
  browser = await { chromium, firefox, webkit }[engine].launch();
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30_000);

test.each(["json", "text"])(
  `managed actor %s cancellation rejects without a native ${engine} console error`,
  async (method) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/test/managed-actor-response.html?method=${method}`);
      await page.getByRole("button", { name: "Read response" }).click();
      await page.waitForFunction(() => document.querySelector("#result")?.textContent !== "");
      const result = JSON.parse((await page.locator("#result").textContent())!);
      expect(result).toEqual({
        outcome: { name: "AbortError" },
        events: ["read", "abort", "cleanup", "cancel"],
        bodyUsed: true,
        sourceLocked: false,
      });
      // Console notifications follow the body's rejection on a separate task.
      await page.waitForTimeout(100);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
  15_000,
);
