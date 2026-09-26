// Real-browser regression for the compact exchange presentation (the web
// app's mode): a delegated question folds behind one status row, following
// the tip stops once the answer pushes the question to the top, the next
// question resumes following, "Your question" returns a reader to the question
// they are reading, a short answer never leaves a stale stop behind, progress
// notes streamed without a phase never read as the answer, and loading older
// history keeps the reader in place.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;

type Sample = {
  following: boolean;
  promptTop: number | null;
  promptTops: number[];
  rowsBetween: number | null;
  jumpToLatest: boolean;
  lastText: string;
  status: string | null;
  maxScroll: number;
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
    const topOf = (element: HTMLElement) =>
      Math.round(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    return {
      following: scroller.dataset.ogBottomFollow === "true",
      promptTop: prompt < 0 ? null : topOf(groups[prompt]!),
      promptTops: groups.filter((group) => group.hasAttribute("data-og-prompt")).map(topOf),
      status:
        [...scroller.querySelectorAll<HTMLElement>("[data-og-exchange-status]")]
          .at(-1)
          ?.getAttribute("data-og-exchange-status") ?? null,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
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

  async function openHarness(scenario = "delegated"): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 390, height: 560 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (message.location().url.endsWith("/favicon.ico")) return;
      browserErrors.push(`console: ${message.text()}`);
    });
    await page.goto(`${baseUrl}/exchange-fold.html?scenario=${scenario}`);
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

  test("a short answer leaves no stop behind for the next question", async () => {
    const page = await openHarness("follow-up");
    try {
      const harness = await page.evaluate(() => ({
        total: window.exchangeFoldHarness!.total,
        followUp: window.exchangeFoldHarness!.indexOf("user.message")[1]!,
        settle: window.exchangeFoldHarness!.indexOf("agent.message.completed")[1]!,
      }));
      const samples: Sample[] = [];
      // Step through from the start: the first answer arrives live.
      for (let count = 1; count <= harness.settle; count += 1) {
        await page.evaluate((value) => window.exchangeFoldHarness!.show(value), count);
        await nextPaint(page);
        await page.waitForTimeout(80);
        const state = await sample(page);
        if (count > harness.followUp) samples.push(state);
      }
      expect(samples.length).toBeGreaterThan(10);
      // The follow-up and all of its work keep following the tip.
      for (const state of samples) {
        expect(state).toMatchObject({ following: true, jumpToLatest: false });
      }
      // The earlier question scrolled away instead of parking at the top.
      expect(samples.at(-1)!.promptTops[0]!).toBeLessThan(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("progress notes streamed without a phase never read as the answer", async () => {
    const page = await openHarness("notes");
    try {
      const harness = await page.evaluate(() => {
        const driver = window.exchangeFoldHarness!;
        return {
          total: driver.total,
          oversized: driver.indexOf("agent.message.delta", { messageId: "note-oversized" }),
          verify: driver.indexOf("agent.toolCall.created", { id: "verify" })[0]!,
          settle: driver.indexOf("agent.message.completed")[0]!,
        };
      });
      for (let count = 3; count <= harness.settle; count += 1) {
        await page.evaluate((value) => window.exchangeFoldHarness!.show(value), count);
        await nextPaint(page);
        await page.waitForTimeout(60);
        const index = count - 1;
        if (index === harness.verify) {
          // Let the jump control finish its exit once following resumes.
          await page
            .waitForFunction(() => !document.querySelector("[data-og-jump-to-latest]"), undefined, {
              timeout: 2_000,
            })
            .catch(() => undefined);
        }
        const state = await sample(page);
        if (index < harness.oversized[0]!) {
          // Typical notes (a few sentences) stay in the status row while they stream.
          expect(state).toMatchObject({ status: "working", following: true, jumpToLatest: false });
          expect(state.rowsBetween).toBeNull();
        } else if (index >= harness.verify) {
          // A note long enough to read as an answer folds back once work
          // follows it, and following resumes where it stopped.
          expect(state).toMatchObject({ status: "working", following: true, jumpToLatest: false });
          expect(state.rowsBetween).toBeNull();
        }
      }
      // Only the settled turn shows its answer below the separator.
      await page.evaluate((value) => window.exchangeFoldHarness!.show(value), harness.total);
      await nextPaint(page);
      await page.waitForTimeout(80);
      const done = await sample(page);
      expect(done.status).toBe("worked");
      expect(done.rowsBetween).toBe(1);
      expect(done.lastText).toContain("171 in total");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("loading older history inside an exchange keeps the reader in place", async () => {
    const page = await openHarness("history");
    try {
      const start = await page.evaluate(() => {
        const driver = window.exchangeFoldHarness!;
        // Start the window in the middle of the second exchange's work.
        const first = driver.indexOf("agent.toolCall.created", { id: "q-2-2" })[0]!;
        driver.showWindow(first, driver.total);
        return first;
      });
      expect(start).toBeGreaterThan(0);
      const scroller = page.locator("[data-og-timeline-scroller]");
      await page.waitForFunction(() => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
        return (
          !!node && node.style.visibility !== "hidden" && node.scrollHeight > node.clientHeight
        );
      });
      await scroller.hover();
      for (let step = 0; step < 40; step += 1) {
        if (await page.evaluate(() => window.exchangeFoldHarness!.olderRequested())) break;
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(60);
      }
      expect(await page.evaluate(() => window.exchangeFoldHarness!.olderRequested())).toBe(true);
      await page.waitForTimeout(200);
      const anchors = () =>
        page.evaluate(() => {
          const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const top = node.getBoundingClientRect().top;
          const at = (text: string) => {
            const group = [...node.querySelectorAll<HTMLElement>("[data-og-group-key]")].find(
              (candidate) => candidate.textContent?.includes(text),
            );
            return group ? Math.round(group.getBoundingClientRect().top - top) : null;
          };
          return {
            answer: at("Week 2:"),
            question: at("Question 3:"),
            first: at("Question 1:"),
            following: node.dataset.ogBottomFollow === "true",
          };
        });
      const before = await anchors();
      expect(before.first).toBeNull();
      expect(before.answer).not.toBeNull();
      await page.evaluate(() => window.exchangeFoldHarness!.completeOlder());
      await page.waitForFunction(() =>
        [...document.querySelectorAll("[data-og-group-key]")].some((group) =>
          group.textContent?.includes("Question 1:"),
        ),
      );
      await nextPaint(page);
      await page.waitForTimeout(120);
      const after = await anchors();
      expect(after.following).toBe(false);
      expect(Math.abs(after.answer! - before.answer!)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.question! - before.question!)).toBeLessThanOrEqual(1);
      expect(after.first!).toBeLessThan(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
