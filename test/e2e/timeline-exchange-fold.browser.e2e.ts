import { existsSync, mkdirSync } from "node:fs";
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

describe("readable timeline browser regression", () => {
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

  test("a long answer follows normally and every progress message remains readable", async () => {
    const page = await openHarness("notes");
    try {
      const total = await page.evaluate(() => window.exchangeFoldHarness!.total);
      for (let count = 1; count <= total; count += 1) {
        await page.evaluate((value) => window.exchangeFoldHarness!.show(value), count);
        await nextPaint(page);
        await page.waitForTimeout(60);
        expect((await sample(page)).following).toBe(true);
      }
      const messages = page.locator("[data-og-wide-table-message]");
      expect(await messages.count()).toBeGreaterThanOrEqual(4);
      expect(await page.locator("[data-og-exchange-note]").count()).toBe(0);
      expect(await page.locator('[data-og-exchange-status="worked"]').count()).toBe(1);
      expect((await sample(page)).lastText).toContain("171 in total");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("one Latest question button targets the newest user message from an older bounded window", async () => {
    const page = await openHarness("history");
    try {
      await page.evaluate(() => {
        const driver = window.exchangeFoldHarness!;
        const questions = driver.indexOf("user.message");
        driver.showWindow(questions[1]!, questions[2]!);
      });
      await page.waitForSelector("[data-og-jump-to-question]");
      expect(await page.getByRole("button", { name: "Latest question", exact: true }).count()).toBe(
        1,
      );
      expect(
        await page.getByRole("button", { name: /Previous question|Next question/ }).count(),
      ).toBe(0);
      await page.getByRole("button", { name: "Latest question", exact: true }).click();
      await page.waitForFunction(() => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
        const prompt = [...node.querySelectorAll<HTMLElement>("[data-og-prompt]")].find((item) =>
          item.textContent?.includes("Question 4:"),
        );
        return (
          prompt &&
          Math.abs(prompt.getBoundingClientRect().top - node.getBoundingClientRect().top - 12) <= 2
        );
      });
      expect((await sample(page)).following).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("manual scrolling during a long answer stays unpinned through subsequent machine work", async () => {
    const page = await openHarness("machine-follow-up");
    try {
      const total = await page.evaluate(() => {
        const driver = window.exchangeFoldHarness!;
        driver.show(driver.indexOf("system.update.delivered").at(-1)!);
        return driver.total;
      });
      await page.waitForTimeout(400);
      const scroller = page.locator("[data-og-timeline-scroller]");
      await scroller.hover();
      await page.mouse.wheel(0, -220);
      await page.waitForTimeout(200);
      expect((await sample(page)).following).toBe(false);
      const before = await scroller.evaluate((node) => node.scrollTop);
      await page.evaluate((value) => window.exchangeFoldHarness!.show(value), total);
      await nextPaint(page);
      await page.waitForTimeout(300);
      expect((await sample(page)).following).toBe(false);
      expect(
        Math.abs((await scroller.evaluate((node) => node.scrollTop)) - before),
      ).toBeLessThanOrEqual(2);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  for (const width of [1280, 390]) {
    for (const theme of ["dark", "light"]) {
      test(`actual component ${width}px ${theme}: readable messages, disclosure and preview`, async () => {
        const page = await openHarness();
        try {
          await page.setViewportSize({ width, height: 900 });
          if (theme === "light")
            await page.getByRole("button", { name: "Dark", exact: true }).click();
          await page.getByRole("button", { name: "Working", exact: true }).click();
          await page.waitForTimeout(350);
          expect(await page.locator('[data-og-exchange-status="working"]').count()).toBe(1);
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(1);
          const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
          if (output) {
            mkdirSync(output, { recursive: true });
            await page.screenshot({ path: `${output}/timeline-${width}-${theme}-working.png` });
          }
          await page.getByRole("button", { name: "Done", exact: true }).click();
          await page.waitForTimeout(350);
          expect(await page.locator('[data-og-exchange-status="worked"]').count()).toBe(2);
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(3);
          expect(await page.locator("[data-og-machine-input-batch][open]").count()).toBe(0);
          const worked = page
            .locator('[data-og-exchange-status="worked"]')
            .last()
            .locator("..")
            .locator("..");
          await worked.click();
          expect(await worked.getAttribute("aria-expanded")).toBe("true");
          await worked.click();
          expect(await worked.getAttribute("aria-expanded")).toBe("false");
          await page.waitForTimeout(250);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          expect(overflow).toBe(false);
          if (output)
            await page.screenshot({ path: `${output}/timeline-${width}-${theme}-settled.png` });
        } finally {
          await page.context().close();
        }
      }, 60_000);
    }
  }

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

  test("an answer stays a visible message when a machine-triggered turn follows it", async () => {
    const page = await openHarness("machine-follow-up");
    try {
      const total = await page.evaluate(() => window.exchangeFoldHarness!.total);
      await page.evaluate((value) => window.exchangeFoldHarness!.show(value), total);
      await nextPaint(page);
      await page.waitForTimeout(200);
      const state = await page.evaluate(() => {
        const question = "Do you approve this four-at-a-time layout?";
        const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
        const message = [
          ...scroller.querySelectorAll<HTMLElement>("[data-og-wide-table-message]"),
        ].find(
          (candidate) =>
            candidate.textContent?.includes(question) &&
            !candidate.closest("[data-og-fold-content]"),
        );
        return {
          // The question is readable without expanding anything...
          answerVisible: !!message && message.getBoundingClientRect().height > 0,
          // ...and is not squeezed into a muted status-row preview.
          inStatusNote: [...scroller.querySelectorAll("[data-og-exchange-note]")].some((note) =>
            note.textContent?.includes(question),
          ),
        };
      });
      expect(state).toEqual({ answerVisible: true, inStatusNote: false });
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
