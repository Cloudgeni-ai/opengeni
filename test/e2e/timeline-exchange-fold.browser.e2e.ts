// Real-browser regression for the compact exchange presentation: a delegated
// question folds behind one status row, following the tip stops once the
// answer pushes the question to the top, the next question resumes following,
// and "Your question" returns a reader to the question they are reading.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;

type Sample = {
  following: boolean;
  promptTop: number | null;
  rowsBetween: number | null;
  jumpToLatest: boolean;
  lastText: string;
};

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    const groups = [...scroller.querySelectorAll<HTMLElement>("[data-og-group-key]")];
    const prompt = groups.findIndex((group) => group.hasAttribute("data-og-prompt"));
    const nextPrompt = groups.findIndex(
      (group, index) => index > prompt && group.hasAttribute("data-og-prompt"),
    );
    const exchange = groups.slice(prompt + 1, nextPrompt < 0 ? undefined : nextPrompt);
    return {
      following: scroller.dataset.ogBottomFollow === "true",
      promptTop:
        prompt < 0
          ? null
          : Math.round(
              groups[prompt]!.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            ),
      // Rows between the question and its answer, once an answer exists.
      rowsBetween: exchange.length > 1 ? exchange.length - 1 : null,
      jumpToLatest: document.querySelector("[data-og-jump-to-latest]") !== null,
      lastText: groups.at(-1)?.textContent ?? "",
    };
  });
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

describe("timeline exchange fold browser regression", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  const browserErrors: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      ["bun", "run", "vite", ".", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: demoRoot,
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
    try {
      expect(browserErrors).toEqual([]);
    } finally {
      await Promise.allSettled([browser?.close(), web?.stop()]);
    }
  });

  async function openHarness(): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 390, height: 560 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.location().url.endsWith("/favicon.ico")) return;
      browserErrors.push(`console: ${message.text()}`);
    });
    await page.goto(`${baseUrl}/exchange-fold.html`);
    await page.waitForFunction(() => window.exchangeFoldHarness !== undefined);
    return page;
  }

  test("the answer stops following at its question and the next question resumes", async () => {
    const page = await openHarness();
    try {
      const total = await page.evaluate(() => window.exchangeFoldHarness!.total);
      let answered = false;
      let released: Sample | null = null;
      for (let count = 1; count <= total; count += 1) {
        await page.evaluate((value) => window.exchangeFoldHarness!.show(value), count);
        await nextPaint(page);
        await page.waitForTimeout(80);
        const state = await sample(page);
        if (state.lastText.startsWith("312 new users")) answered = true;
        if (!answered) {
          // Work never unpins the reader: one status row, always following.
          expect(state.following).toBe(true);
        } else if (!released && !state.following) {
          released = state;
        }
        if (state.lastText.includes("And yesterday alone?")) break;
      }
      expect(released).not.toBeNull();
      // Following stopped with the question parked at the top of the viewport.
      expect(Math.abs(released!.promptTop! - 12)).toBeLessThanOrEqual(2);
      expect(released!.jumpToLatest).toBe(true);
      // Prompt, one status row, then the answer.
      expect(released!.rowsBetween).toBe(1);
      // The next question returns the reader to the tip.
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>("[data-og-timeline-scroller]")?.dataset
            .ogBottomFollow === "true",
        undefined,
        { timeout: 4_000 },
      );
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("Your question returns a reader to the question they are reading", async () => {
    const page = await openHarness();
    try {
      const total = await page.evaluate(() => window.exchangeFoldHarness!.total);
      await page.evaluate((value) => window.exchangeFoldHarness!.show(value), total);
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
        scroller.scrollTop = 220;
      });
      await page.waitForSelector("[data-og-jump-to-question]", { timeout: 4_000 });
      await page.locator("[data-og-jump-to-question]").click();
      await nextPaint(page);
      const state = await sample(page);
      expect(Math.abs(state.promptTop! - 12)).toBeLessThanOrEqual(2);
      expect(state.following).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
