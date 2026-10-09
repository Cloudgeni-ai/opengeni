import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("persistent stock conversation controller", () => {
  let web: StartedProcess;
  let browser: Browser;
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
            await fetch(`${baseUrl}/embedded-chat.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 60_000,
      },
    );
    browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  for (const width of [1440, 390]) {
    test(`retains draft through layouts and sends annotations without text at ${width}px`, async () => {
      const errors: string[] = [];
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${baseUrl}/embedded-chat.html?controller=1&scenario=long`, {
          waitUntil: "networkidle",
        });
        const input = page.getByRole("textbox", { name: "Message the agent", exact: true });
        await input.fill("Keep this draft while changing layouts");
        await page.getByRole("button", { name: "Toggle panel layout" }).click();
        await page.getByRole("button", { name: "Hide conversation" }).click();
        expect(await input.count()).toBe(0);
        await page.getByRole("button", { name: "Show conversation" }).click();
        expect(await input.inputValue()).toBe("Keep this draft while changing layouts");
        await input.fill("");
        await page.getByRole("button", { name: "Add example annotation" }).click();
        const send = page.getByRole("button", { name: "Send message", exact: true });
        await send.waitFor();
        expect(await send.isEnabled()).toBe(true);
        const inputBox = await input.boundingBox();
        const sendBox = await send.boundingBox();
        expect(inputBox!.width).toBeGreaterThan(100);
        expect(sendBox!.x).toBeGreaterThanOrEqual(0);
        expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(width);
        expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(900);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const evidence = process.env.OPENGENI_CONVERSATION_EVIDENCE_DIR;
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({ path: `${evidence}/annotation-${width}.png` });
        }
        await send.click();
        await page.waitForFunction(
          () =>
            (
              window as unknown as {
                embeddedConversationHarness: { sent: unknown[] };
              }
            ).embeddedConversationHarness.sent.length === 1,
        );
        const state = await page.evaluate(
          () =>
            (
              window as unknown as {
                embeddedConversationHarness: { streams: number; sent: unknown[] };
              }
            ).embeddedConversationHarness,
        );
        expect(state.streams).toBe(1);
        expect(state.sent).toMatchObject([
          {
            text: "",
            modelContext: "Current record: ticket T-4821",
            annotations: [{ quote: "Customer", note: "Check this exact source." }],
          },
        ]);
        expect(errors).toEqual([]);
      } catch (cause) {
        throw new Error(`Browser check failed; page errors: ${errors.join("; ") || "none"}`, {
          cause,
        });
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
