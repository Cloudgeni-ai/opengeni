import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("stock new conversation", () => {
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
    test(`default chat retries the exact creation and retains newer edits at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${baseUrl}/embedded-chat.html?scenario=empty&retry=1`, {
          waitUntil: "networkidle",
        });
        const input = page.getByRole("textbox", { name: "Ask anything…", exact: true });
        await input.fill("First request");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await retry.waitFor();
        await input.fill("My next thought, not a second initial request");
        expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(
          true,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const box = await retry.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(900);
        const evidence = process.env.OPENGENI_CONVERSATION_EVIDENCE_DIR;
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({ path: `${evidence}/creation-retry-${width}.png` });
        }
        await retry.click();
        const attempts = await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              embeddedCreationHarness: { attempts: unknown[]; finish: () => void };
            }
          ).embeddedCreationHarness;
          fixture.finish();
          return fixture.attempts;
        });
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        const nextDraft = page.getByRole("textbox", { name: "Message the agent", exact: true });
        await nextDraft.waitFor();
        expect(await nextDraft.inputValue()).toBe("My next thought, not a second initial request");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`standalone new conversation inherits the host theme at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${baseUrl}/embedded-chat.html?new=standalone&theme=dark&host=navy`, {
          waitUntil: "networkidle",
        });
        const form = page.locator("[data-og-new-chat-composer]");
        // Dark is the inherited stock theme, so no redundant attribute is
        // required. Check the rendered host blending instead of an attribute.
        const colors = await form.evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          host: getComputedStyle(document.body).backgroundColor,
        }));
        expect(colors.background).toBe(colors.host);
        expect(colors.host).toBe("rgb(11, 16, 32)");
        await page
          .getByRole("textbox", { name: "Ask anything…", exact: true })
          .fill("A standalone stock composer");
        expect(await page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(
          true,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const evidence = process.env.OPENGENI_CONVERSATION_EVIDENCE_DIR;
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({ path: `${evidence}/new-conversation-dark-${width}.png` });
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
