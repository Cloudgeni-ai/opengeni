import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

  async function openHarness(
    scenario = "delegated",
    width = 390,
    touch = false,
    recordMotion = false,
  ): Promise<Page> {
    const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
    const context = await browser.newContext({
      viewport: { width, height: recordMotion ? 900 : 560 },
      hasTouch: touch,
      isMobile: touch,
      ...(recordMotion && output
        ? { recordVideo: { dir: `${output}/motion`, size: { width, height: 900 } } }
        : {}),
    });
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

  for (const width of [390, 1280]) {
    test(`history prepend and settlement preserve the selected reader at ${width}px`, async () => {
      const page = await openHarness("tail", width, width === 390);
      try {
        await page.evaluate(() => {
          const driver = window.exchangeFoldHarness!;
          driver.showWindow(
            driver.indexOf("agent.message.delta", { messageId: "progress-2" })[0]!,
            driver.total - 1,
          );
        });
        await page.waitForTimeout(500);
        const result = await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const paragraph = scroller.querySelector<HTMLElement>("[data-og-wide-table-message] p")!;
          scroller.scrollTop +=
            paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 80;
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
          const top = paragraph.getBoundingClientRect().top;
          const text = window.getSelection()!.toString();
          // show() delivers the entire window and its terminal event in one commit.
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total, true);
          return {
            connected: paragraph.isConnected,
            drift: paragraph.getBoundingClientRect().top - top,
            retained: window.getSelection()!.toString() === text,
          };
        });
        expect(result.connected).toBe(true);
        expect(result.retained).toBe(true);
        expect(Math.abs(result.drift)).toBeLessThanOrEqual(2);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`overlapping pending turn and session replacement own settlement at ${width}px`, async () => {
      const page = await openHarness("overlap", width, width === 390);
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() =>
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total - 1),
        );
        await page.waitForTimeout(600);
        const result = await page.evaluate(() => {
          const driver = window.exchangeFoldHarness!;
          driver.show(driver.total, true);
          const animation = document.getAnimations().find((a) => a.id === "og-timeline-settlement");
          const started = !!animation;
          const oldScroller = document.querySelector("[data-og-timeline-scroller]")!;
          driver.switchSession();
          return { started, state: animation?.playState, detached: !oldScroller.isConnected };
        });
        expect(result).toEqual({ started: true, state: "idle", detached: true });
        await page.evaluate(() => window.exchangeFoldHarness!.show(3));
        await nextPaint(page);
        expect(await page.locator('[data-og-exchange-status="working"]').count()).toBe(1);
        expect(await page.locator('[data-og-exchange-status="worked"]').count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`startup failure remains visible through next-turn recovery at ${width}px`, async () => {
      const page = await openHarness("startup-recovery", width, width === 390);
      try {
        await page.evaluate(() => window.exchangeFoldHarness!.show(3));
        await nextPaint(page);
        expect(await page.locator(".og-genie-loading").count()).toBe(1);
        await page.evaluate(() => window.exchangeFoldHarness!.show(5));
        await nextPaint(page);
        expect(await page.locator(".og-genie-loading").count()).toBe(0);
        const header = page.locator('[data-og-work-header="outer"]').first();
        expect(await header.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator('[data-og-exchange-status="worked"]').count()).toBe(1);
        await header.focus();
        await header.evaluate((node) => node.setAttribute("data-failure-focus", "true"));
        await page.evaluate(() => window.exchangeFoldHarness!.show(9));
        await nextPaint(page);
        expect(await page.locator(".og-genie-loading").count()).toBe(1);
        await page.evaluate(() =>
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total),
        );
        await nextPaint(page);
        expect(await page.locator(".og-genie-loading").count()).toBe(0);
        expect(
          await page.evaluate(() => document.activeElement?.hasAttribute("data-failure-focus")),
        ).toBe(true);
        expect(await page.locator('[data-og-exchange-status="worked"]').count()).toBe(2);
        expect(await header.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`same-update selection survives settlement at ${width}px`, async () => {
      const page = await openHarness("tail", width, width === 390);
      try {
        await page.evaluate(() =>
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total - 1),
        );
        await page.waitForTimeout(600);
        const result = await page.evaluate(() => {
          const paragraph = document.querySelector<HTMLElement>("[data-og-wide-table-message] p")!;
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          const before = selection.toString();
          // Commit before the browser's asynchronous selectionchange notification.
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total, true);
          return { before, after: selection.toString(), connected: paragraph.isConnected };
        });
        expect(result.connected).toBe(true);
        expect(result.after).toBe(result.before);
        const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
        if (output) {
          mkdirSync(output, { recursive: true });
          writeFileSync(`${output}/selection-${width}.json`, JSON.stringify(result, null, 2));
          await page.screenshot({ path: `${output}/selection-${width}.png` });
        }
        await page.locator("[data-og-jump-to-latest]").click();
        await nextPaint(page);
        expect(await page.locator("[data-og-wide-table-message]").count()).toBe(1);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    for (const intent of ["wheel", "focus", "selection", "keyboard", "touch"] as const) {
      test(`reader ${intent} interrupts settlement motion at ${width}px`, async () => {
        const page = await openHarness("tail", width, width === 390);
        try {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() =>
            window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total - 1),
          );
          await page.waitForTimeout(600);
          const result = await page.evaluate(async (kind) => {
            const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
            window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total, true);
            const animation = document
              .getAnimations()
              .find((a) => a.id === "og-timeline-settlement")!;
            if (!animation) throw new Error("Expected a real settlement animation");
            animation.pause();
            animation.currentTime = 80;
            if (kind === "wheel")
              scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
            if (kind === "keyboard")
              scroller.dispatchEvent(
                new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
              );
            if (kind === "touch")
              scroller.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [] }));
            if (kind === "focus")
              scroller
                .querySelector<HTMLButtonElement>("[data-og-work-header]")!
                .focus({ preventScroll: true });
            if (kind === "selection") {
              const range = document.createRange();
              range.selectNodeContents(
                scroller.querySelectorAll("[data-og-wide-table-message] p")[0]!,
              );
              window.getSelection()!.removeAllRanges();
              window.getSelection()!.addRange(range);
              document.dispatchEvent(new Event("selectionchange"));
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            return document.getAnimations().some((a) => a.id === "og-timeline-settlement");
          }, intent);
          expect(result).toBe(false);
          const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
          if (output && intent === "wheel") {
            mkdirSync(output, { recursive: true });
            await page.screenshot({ path: `${output}/reader-interruption-${width}.png` });
          }
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }

    for (const reduced of [false, true]) {
      test(`settlement preserves answer motion frame-by-frame at ${width}px, reduced=${reduced}`, async () => {
        const page = await openHarness("tail", width, false, !reduced);
        const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
        try {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
          await page.evaluate(() => {
            const driver = window.exchangeFoldHarness!;
            driver.show(driver.total - 1);
          });
          await page.waitForTimeout(1_200);
          expect((await sample(page)).following).toBe(true);
          const trace = await page.evaluate(async () => {
            const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
            const paragraph = [...scroller.querySelectorAll("[data-og-wide-table-message]")]
              .at(-1)!
              .querySelector("p")!;
            const read = () => ({
              time: performance.now(),
              top: paragraph.getBoundingClientRect().top,
              scrollTop: scroller.scrollTop,
              scrollHeight: scroller.scrollHeight,
              following: scroller.dataset.ogBottomFollow === "true",
              connected: paragraph.isConnected,
              animating: document.getAnimations().some((a) => a.id === "og-timeline-settlement"),
              worked: !!scroller.querySelector('[data-og-exchange-status="worked"]'),
            });
            const before = read();
            window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total);
            const frames = [];
            for (let index = 0; index < 35; index++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              frames.push(read());
            }
            return { before, frames };
          });
          const after = trace.frames.at(-1)!;
          const distance = Math.abs(trace.before.top - after.top);
          expect(distance).toBeGreaterThan(100); // The real scroll-clamp regression, not a no-op.
          expect(trace.frames.every((frame) => frame.connected && frame.following)).toBe(true);
          expect(after.worked).toBe(true);
          expect(after.animating).toBe(false);
          const worked = trace.frames.filter((frame) => frame.worked);
          if (reduced) {
            expect(worked.every((frame) => !frame.animating)).toBe(true);
            expect(worked.every((frame) => Math.abs(frame.top - after.top) < 1)).toBe(true);
          } else {
            expect(worked.some((frame) => frame.animating)).toBe(true);
            const intermediate = worked.filter(
              (frame) =>
                Math.abs(frame.top - trace.before.top) > 2 && Math.abs(frame.top - after.top) > 2,
            );
            expect(intermediate.length).toBeGreaterThanOrEqual(3);
            const positions = [trace.before, ...trace.frames];
            const jumps = positions
              .slice(1)
              .map((frame, index) => Math.abs(frame.top - positions[index]!.top));
            expect(Math.max(...jumps)).toBeLessThan(distance * 0.65);
            expect(Math.abs(trace.frames.at(-2)!.top - after.top)).toBeLessThan(1);
          }
          if (output) {
            mkdirSync(`${output}/motion`, { recursive: true });
            writeFileSync(
              `${output}/motion/settlement-${width}-reduced-${reduced}.json`,
              JSON.stringify(trace, null, 2),
            );
          }
        } finally {
          await page.context().close();
          if (!reduced && output)
            await page.video()?.saveAs(`${output}/motion/settlement-${width}.webm`);
        }
      }, 30_000);
    }
  }

  for (const width of [390, 1280]) {
    for (const intent of ["selection", "focus"] as const) {
      test(`pinned ${intent} owns progress through settlement at ${width}px`, async () => {
        const page = await openHarness("startup", width, width === 390);
        try {
          await page.evaluate(() => {
            const driver = window.exchangeFoldHarness!;
            driver.show(driver.indexOf("agent.message.delta", { messageId: "startup-final" })[0]!);
          });
          await page.waitForTimeout(350);
          expect((await sample(page)).following).toBe(true);
          const selected = await page.evaluate((kind) => {
            const paragraph = document.querySelector<HTMLElement>(
              "[data-og-wide-table-message] p",
            )!;
            paragraph.dataset.pinnedReader = "true";
            if (kind === "selection") {
              const range = document.createRange();
              range.selectNodeContents(paragraph);
              window.getSelection()!.removeAllRanges();
              window.getSelection()!.addRange(range);
            } else {
              const link = paragraph.querySelector<HTMLAnchorElement>("a")!;
              link.dataset.pinnedFocus = "true";
              link.focus({ preventScroll: true });
            }
            return paragraph.textContent;
          }, intent);
          await nextPaint(page);
          expect((await sample(page)).following).toBe(false);
          await page.evaluate(() =>
            window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total),
          );
          await nextPaint(page);
          expect(await page.locator("[data-pinned-reader]").count()).toBe(1);
          expect(
            await page.evaluate(() =>
              document
                .getAnimations()
                .some((animation) => animation.id === "og-timeline-settlement"),
            ),
          ).toBe(false);
          if (intent === "selection")
            expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected!);
          else
            expect(
              await page.evaluate(() => document.activeElement?.hasAttribute("data-pinned-focus")),
            ).toBe(true);
          expect((await sample(page)).following).toBe(false);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }

    test(`manual reader keeps prose, selection and focus through settlement at ${width}px`, async () => {
      const page = await openHarness("tail", width, width === 390);
      try {
        const finalStart = await page.evaluate(() => {
          const driver = window.exchangeFoldHarness!;
          const index = driver.indexOf("agent.message.delta", { messageId: "final" })[0]!;
          driver.show(index);
          return index;
        });
        await page.waitForTimeout(400);
        const scroller = page.locator("[data-og-timeline-scroller]");
        await scroller.hover();
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(150);
        expect((await sample(page)).following).toBe(false);
        const before = await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const paragraph = node.querySelector<HTMLElement>("[data-og-wide-table-message] p")!;
          paragraph.dataset.readerProse = "true";
          node.scrollTop +=
            paragraph.getBoundingClientRect().top - node.getBoundingClientRect().top - 100;
          const link = node.querySelector<HTMLAnchorElement>("[data-og-wide-table-message] a")!;
          link.dataset.readerFocus = "true";
          link.focus({ preventScroll: true });
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
          return {
            top: paragraph.getBoundingClientRect().top,
            selection: window.getSelection()!.toString(),
          };
        });
        for (const count of [
          finalStart + 1,
          await page.evaluate(() => window.exchangeFoldHarness!.total),
        ]) {
          await page.evaluate((value) => window.exchangeFoldHarness!.show(value), count);
          await nextPaint(page);
          await page.waitForTimeout(150);
          const after = await page.evaluate(() => ({
            top: document.querySelector("[data-reader-prose]")?.getBoundingClientRect().top,
            selection: window.getSelection()!.toString(),
            focused: document.activeElement?.hasAttribute("data-reader-focus"),
          }));
          expect(after.focused).toBe(true);
          expect(
            await page.evaluate(() =>
              document
                .getAnimations()
                .some((animation) => animation.id === "og-timeline-settlement"),
            ),
          ).toBe(false);
          expect(after.selection).toBe(before.selection);
          expect(Math.abs(after.top! - before.top)).toBeLessThanOrEqual(2);
          expect((await sample(page)).following).toBe(false);
        }
        // Only an explicit disclosure action now moves protected prose inside.
        const header = page.locator('[data-og-work-header="outer"]');
        await header.click();
        expect(await header.getAttribute("aria-expanded")).toBe("true");
        expect(
          await page.locator("[data-og-fold-content] [data-og-wide-table-message]").count(),
        ).toBe(3);
        await header.click();
        await page.waitForTimeout(250);
        expect(await page.locator("[data-og-wide-table-message]").count()).toBe(1);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`expanded live tail retains controls and reader anchor at ${width}px`, async () => {
      const page = await openHarness("tail", width, width === 390);
      try {
        const nextProgress = await page.evaluate(() => {
          const driver = window.exchangeFoldHarness!;
          const index = driver.indexOf("agent.message.delta", { messageId: "progress-2" })[0]!;
          driver.show(index);
          return index;
        });
        await page.waitForTimeout(350);
        const header = page.locator('[data-og-work-header="outer"]');
        await header.click();
        await page.waitForTimeout(300);
        const before = await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const section = node.querySelector<HTMLElement>("[data-og-work-section]")!;
          const trigger = section.querySelector<HTMLButtonElement>(
            '[data-og-work-header="outer"]',
          )!;
          trigger.dataset.retainedTrigger = "true";
          trigger.focus({ preventScroll: true });
          node.scrollTop +=
            section.getBoundingClientRect().top - node.getBoundingClientRect().top + 100;
          const row = [...section.querySelectorAll<HTMLElement>("[data-og-item]")].find(
            (item) => item.getBoundingClientRect().top > node.getBoundingClientRect().top + 100,
          )!;
          row.dataset.retainedTool = "true";
          return row.getBoundingClientRect().top;
        });
        await page.evaluate((count) => window.exchangeFoldHarness!.show(count), nextProgress + 1);
        await nextPaint(page);
        const after = await page.evaluate(() => ({
          top: document.querySelector("[data-retained-tool]")?.getBoundingClientRect().top,
          focused: document.activeElement?.hasAttribute("data-retained-trigger"),
          open: document.querySelector("[data-retained-trigger]")?.getAttribute("aria-expanded"),
        }));
        expect(after.focused).toBe(true);
        expect(after.open).toBe("true");
        expect(Math.abs(after.top! - before)).toBeLessThanOrEqual(2);
        await page.evaluate(() =>
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total),
        );
        await nextPaint(page);
        expect(await header.getAttribute("data-retained-trigger")).toBe("true");
        expect(await header.getAttribute("aria-expanded")).toBe("true");
        expect((await sample(page)).following).toBe(false);
        expect(
          await page.evaluate(() =>
            document.getAnimations().some((animation) => animation.id === "og-timeline-settlement"),
          ),
        ).toBe(false);
      } finally {
        await page.context().close();
      }
    }, 30_000);

    test(`legacy attention updates the owning work row at ${width}px`, async () => {
      const page = await openHarness("legacy-attention", width, width === 390);
      const evidenceDir = `${repoRoot}/.agent/evidence/timeline-legacy-work`;
      mkdirSync(evidenceDir, { recursive: true });
      try {
        await page.evaluate(() => window.exchangeFoldHarness!.show(4));
        const statuses = page.locator("[data-og-exchange-status]");
        await page.waitForFunction(
          () => document.querySelector('[data-og-exchange-status="waiting"]') !== null,
        );
        expect(await statuses.count()).toBe(1);
        expect(await statuses.innerText()).toContain("Waiting for you");
        await page.screenshot({ path: `${evidenceDir}/legacy-waiting-${width}.png` });
        await page.evaluate(() => window.exchangeFoldHarness!.show(5));
        await page.waitForFunction(
          () => document.querySelector('[data-og-exchange-status="worked"]') !== null,
        );
        expect(await statuses.count()).toBe(1);
        await page.screenshot({ path: `${evidenceDir}/legacy-cancelled-${width}.png` });
        await page.evaluate(() => window.exchangeFoldHarness!.show(7));
        await page.waitForFunction(
          () => document.querySelectorAll("[data-og-exchange-status]").length === 2,
        );
        expect(
          await statuses.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-og-exchange-status")),
          ),
        ).toEqual(["worked", "working"]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
      } finally {
        await page.context().close();
      }
    });
  }

  for (const mode of [
    "pending",
    "started",
    "withdrawn",
    "legacy-running",
    "legacy-settled",
  ] as const) {
    for (const width of [390, 1280]) {
      test(`Latest question reaches ${mode} through the production conversation at ${width}px`, async () => {
        const page = await openHarness(`question-${mode}`, width, width === 390);
        try {
          await page.waitForSelector("[data-og-conversation]");
          await page.waitForSelector("[data-og-wide-table-message]");
          if (mode === "pending") {
            const queue = page.getByRole("button", { name: /1 queued/ });
            if ((await queue.getAttribute("aria-expanded")) === "true") await queue.click();
          }
          const latest = page.locator("[data-og-jump-to-question]");
          await latest.waitFor({ state: "visible" });
          expect(await latest.count()).toBe(1);
          const resolverRequests = () =>
            page.evaluate(() =>
              performance
                .getEntriesByType("resource")
                .filter((entry) =>
                  new URL(entry.name).pathname.endsWith("/hooks/latest-question.ts"),
                )
                .map((entry) => entry.name),
            );
          expect(await resolverRequests()).toEqual([]);
          await latest.click();
          if (mode === "pending") {
            await page.waitForFunction(
              () =>
                (document.activeElement as HTMLElement)?.dataset.queueTurnId ===
                "newest-queued-turn",
            );
            expect(await page.locator("[data-og-timeline-scroller]").innerText()).not.toContain(
              "Newest queued question",
            );
          } else {
            const label =
              mode === "withdrawn" ? "Previous valid question" : "Newest queued question";
            await page.waitForFunction((text) => {
              const scroller = document.querySelector("[data-og-timeline-scroller]")!;
              const prompt = [...scroller.querySelectorAll("[data-og-prompt]")].find((row) =>
                row.textContent?.includes(text),
              );
              if (!prompt) return false;
              const bounds = prompt.getBoundingClientRect();
              const viewport = scroller.getBoundingClientRect();
              return bounds.top >= viewport.top && bounds.top < viewport.bottom - 20;
            }, label);
            // The target must survive automatic later-page loading and row
            // settlement, not merely cross the viewport for one animation frame.
            await page.waitForTimeout(1000);
            const parked = await page.evaluate((text) => {
              const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
              const prompt = [...scroller.querySelectorAll("[data-og-prompt]")].find((row) =>
                row.textContent?.includes(text),
              );
              const bounds = prompt?.getBoundingClientRect();
              const viewport = scroller.getBoundingClientRect();
              return {
                visible:
                  !!bounds && bounds.top >= viewport.top && bounds.top < viewport.bottom - 20,
                following: scroller.dataset.ogBottomFollow,
                top: scroller.scrollTop,
                promptTop: bounds ? bounds.top - viewport.top : null,
              };
            }, label);
            expect(parked).toMatchObject({ visible: true, following: "false" });
            expect(
              await page.evaluate(() => document.activeElement?.hasAttribute("data-og-prompt")),
            ).toBe(true);
            if (mode === "withdrawn")
              expect(await page.locator("[data-og-timeline-scroller]").innerText()).not.toContain(
                "Newest queued question",
              );
          }
          expect(await resolverRequests()).toHaveLength(1);
          const directory = process.env.TIMELINE_QUESTION_PREVIEW_DIR;
          if (directory) {
            mkdirSync(directory, { recursive: true });
            await page.screenshot({ path: `${directory}/question-${mode}-${width}-dark.png` });
            await page.getByRole("button", { name: "Dark", exact: true }).click();
            await nextPaint(page);
            await page.screenshot({ path: `${directory}/question-${mode}-${width}-light.png` });
          }
          if (mode === "started") {
            const scroller = page.locator("[data-og-timeline-scroller]");
            const beforeScroll = await scroller.evaluate((node) => node.scrollTop);
            await scroller.hover();
            await page.mouse.wheel(0, 250);
            await page.waitForTimeout(300);
            expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(
              beforeScroll + 100,
            );
            expect(await scroller.getAttribute("data-og-bottom-follow")).toBe("false");
          }
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }

  test("a long answer follows normally, then settled progress remains readable in details", async () => {
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
      expect(await messages.count()).toBe(1);
      expect(await page.locator("[data-og-exchange-note]").count()).toBe(0);
      expect(await page.locator('[data-og-exchange-status="worked"]').count()).toBe(1);
      expect((await sample(page)).lastText).toContain("171 in total");
      await page.locator('[data-og-work-header="outer"]').click();
      expect(await messages.count()).toBeGreaterThanOrEqual(4);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  for (const scenario of ["review-maintenance", "review-approval"]) {
    test(`${scenario} has truthful live status and preserved history`, async () => {
      const page = await openHarness(scenario, 390, true);
      try {
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByRole("button", { name: "Dark", exact: true }).click();
        await page.evaluate(() =>
          window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total),
        );
        await page.waitForTimeout(350);
        if (scenario === "review-maintenance") {
          expect(await page.locator("[data-og-exchange-status]").count()).toBe(0);
          await page
            .getByText("Conversation history compacted", { exact: false })
            .waitFor({ state: "visible" });
          expect(await page.locator("[data-og-fold-content]").count()).toBe(0);
        } else {
          expect(await page.locator('[data-og-exchange-status="working"]').count()).toBe(1);
          expect(await page.locator('[data-og-exchange-status="waiting"]').count()).toBe(0);
          await page
            .getByText("Approval was needed.", { exact: true })
            .waitFor({ state: "visible" });
          expect(await page.getByText("waiting on you", { exact: false }).count()).toBe(0);
          await page
            .getByText("reconciling the source breakdown", { exact: false })
            .waitFor({ state: "visible" });
        }
        const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
        if (output) {
          mkdirSync(output, { recursive: true });
          await page.screenshot({ path: `${output}/timeline-${scenario}-390-light.png` });
        }
      } finally {
        await page.context().close();
      }
    }, 60_000);
  }

  for (const width of [320, 390, 1280]) {
    test(`history controls keep separate real pointer targets at ${width}px`, async () => {
      const page = await openHarness("history", width, width < 600);
      try {
        await page.evaluate(() => {
          const driver = window.exchangeFoldHarness!;
          driver.showWindow(driver.indexOf("user.message")[1]!, driver.total);
        });
        const scroller = page.locator("[data-og-timeline-scroller]");
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
          return (
            !!node && node.style.visibility !== "hidden" && node.scrollHeight > node.clientHeight
          );
        });
        await scroller.hover();
        await page.mouse.wheel(0, -20000);
        const start = page.locator("[data-og-jump-to-start]");
        const latest = page.locator("[data-og-jump-to-question]");
        await start.waitFor({ state: "visible" });
        await latest.waitFor({ state: "visible" });
        await page.waitForTimeout(200);
        const targets = await page.evaluate(() => {
          const startButton = document.querySelector<HTMLElement>("[data-og-jump-to-start]")!;
          const latestButton = document.querySelector<HTMLElement>("[data-og-jump-to-question]")!;
          const a = startButton.getBoundingClientRect();
          const b = latestButton.getBoundingClientRect();
          const clickable = (element: HTMLElement, bounds: DOMRect) =>
            element.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            );
          return {
            separate:
              a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
            start: clickable(startButton, a),
            latest: clickable(latestButton, b),
          };
        });
        expect(targets).toEqual({ separate: true, start: true, latest: true });
        expect(await latest.count()).toBe(1);
        const directory = process.env.TIMELINE_NAVIGATION_PREVIEW_DIR;
        if (directory) {
          mkdirSync(directory, { recursive: true });
          await page.screenshot({ path: `${directory}/navigation-${width}-dark.png` });
          await page.getByRole("button", { name: "Dark", exact: true }).click();
          await nextPaint(page);
          await page.waitForTimeout(250);
          await page.screenshot({ path: `${directory}/navigation-${width}-light.png` });
        }
        await start.click();
        await page.waitForFunction(() =>
          document.querySelector("[data-og-prompt]")?.textContent?.includes("Question 1:"),
        );
        await latest.click();
        await page.waitForFunction(() =>
          document.activeElement?.textContent?.includes("Question 4:"),
        );
        expect((await sample(page)).following).toBe(false);
      } finally {
        await page.context().close();
      }
    }, 20_000);
  }

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
      test(`standalone startup hands its elapsed clock to Working: ${width}px ${theme}`, async () => {
        const page = await openHarness("startup", width, width === 390);
        try {
          await page.setViewportSize({ width, height: 900 });
          if (theme === "light")
            await page.getByRole("button", { name: "Dark", exact: true }).click();
          const steps = await page.evaluate(() => {
            const driver = window.exchangeFoldHarness!;
            return {
              starting: driver.indexOf("sandbox.operation.started")[0]! + 1,
              ready: driver.indexOf("agent.model.request", { phase: "first_byte" })[0]! + 1,
              progress:
                driver.indexOf("agent.message.completed", { messageId: "startup-progress" })[0]! +
                1,
            };
          });
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), steps.starting);
          await page.waitForTimeout(300);
          const orb = page.locator(".og-genie-loading");
          expect(await orb.count()).toBe(1);
          expect(await page.locator("[data-og-work-header]").count()).toBe(0);
          await orb.evaluate((node) => node.setAttribute("data-startup-identity", "same"));
          const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
          if (output) {
            mkdirSync(output, { recursive: true });
            await page.screenshot({ path: `${output}/startup-${width}-${theme}-orb.png` });
          }
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), steps.ready);
          await nextPaint(page);
          expect(await orb.getAttribute("data-startup-identity")).toBe("same");
          expect(await page.locator("[data-og-work-header]").count()).toBe(0);
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), steps.progress);
          await nextPaint(page);
          expect(await orb.count()).toBe(0);
          const header = page.locator('[data-og-work-header="outer"]');
          expect(await header.count()).toBe(1);
          expect(await header.textContent()).toMatch(/Working · [5-9]s/);
          expect(await header.textContent()).not.toContain("Preparation");
          if (output)
            await page.screenshot({ path: `${output}/startup-${width}-${theme}-working.png` });
          await header.click();
          expect(await page.locator("[data-og-fold-content] .og-genie-loading").count()).toBe(0);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
          ).toBe(false);
        } finally {
          await page.context().close();
        }
      }, 30_000);

      test(`tail activity and settled chronology preview: ${width}px ${theme}`, async () => {
        const page = await openHarness("tail", width, width === 390);
        try {
          await page.setViewportSize({ width, height: 900 });
          if (theme === "light")
            await page.getByRole("button", { name: "Dark", exact: true }).click();
          // Exercise the same transition without motion as well as the normal
          // desktop/mobile paths; no transition depends on animation callbacks.
          if (width === 390 && theme === "light")
            await page.emulateMedia({ reducedMotion: "reduce" });
          const stages = await page.evaluate(() => {
            const driver = window.exchangeFoldHarness!;
            return {
              waiting: driver.indexOf("session.status.changed")[0]!,
              final: driver.indexOf("agent.message.delta", { messageId: "final" })[0]!,
              total: driver.total,
            };
          });
          const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
          const capture = async (stage: string) => {
            await page.waitForTimeout(300);
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
            ).toBe(false);
            if (output) {
              mkdirSync(output, { recursive: true });
              await page.screenshot({ path: `${output}/tail-${width}-${theme}-${stage}.png` });
            }
          };
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), stages.waiting);
          await nextPaint(page);
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(3);
          expect(await page.locator('[data-og-exchange-status="working"]').count()).toBe(1);
          expect(
            await page.locator("[data-og-group-key]").last().getAttribute("data-og-group-key"),
          ).toBe("work-turn-tail");
          const header = page.locator('[data-og-work-header="outer"]');
          await header.evaluate((node) => node.setAttribute("data-tail-identity", "same"));
          await capture("live");
          await page.evaluate(
            (count) => window.exchangeFoldHarness!.show(count),
            stages.waiting + 1,
          );
          await nextPaint(page);
          expect(await page.locator('[data-og-exchange-status="waiting"]').count()).toBe(1);
          expect(
            await page.locator("[data-og-group-key]").last().getAttribute("data-og-group-key"),
          ).toBe("work-turn-tail");
          await capture("waiting");
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), stages.final + 1);
          await nextPaint(page);
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(4);
          const duration = await header.textContent();
          expect(duration).toContain("Working");
          await capture("answering");
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), stages.total - 1);
          await nextPaint(page);
          expect(await header.textContent()).toContain("Working");
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(4);
          await page
            .locator("[data-og-exchange-preview]")
            .getByText("record-analysis-metadata", { exact: false })
            .waitFor({ state: "visible" });
          await page.evaluate((count) => window.exchangeFoldHarness!.show(count), stages.total);
          await nextPaint(page);
          expect(await header.getAttribute("data-tail-identity")).toBe("same");
          expect(await header.textContent()).toContain("Worked for");
          expect(await header.getAttribute("aria-expanded")).toBe("false");
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(1);
          expect(await page.locator("[data-og-wide-table-message] table").count()).toBe(1);
          await capture("settled");
          await header.click();
          expect(
            await page.locator("[data-og-fold-content] [data-og-wide-table-message]").count(),
          ).toBe(3);
          expect(await header.textContent()).toContain("26 steps");
          await capture("expanded");
        } finally {
          await page.context().close();
        }
      }, 30_000);

      test(`expanded work sticks only through its section: ${width}px ${theme}`, async () => {
        const page = await openHarness("sticky", width, width === 390);
        try {
          await page.setViewportSize({ width, height: 900 });
          if (theme === "light")
            await page.getByRole("button", { name: "Dark", exact: true }).click();
          await page.evaluate(() => {
            const driver = window.exchangeFoldHarness!;
            driver.show(driver.indexOf("turn.completed")[0]! + 1);
          });
          await page.waitForTimeout(350);
          const header = page.locator('[data-og-work-header="outer"]').first();
          await header.click();
          await page.waitForTimeout(300);
          const scroller = page.locator("[data-og-timeline-scroller]");
          await scroller.hover();
          await page.mouse.wheel(0, -100);
          await page.waitForTimeout(150);
          const scrollInside = async () => {
            await page.evaluate(() => {
              const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
              const section = node.querySelector<HTMLElement>("[data-og-work-section]")!;
              node.scrollTop +=
                section.getBoundingClientRect().top - node.getBoundingClientRect().top + 280;
            });
            await page.waitForTimeout(200);
          };
          await scrollInside();
          const geometry = await page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
            const trigger = viewport.querySelector<HTMLElement>('[data-og-work-header="outer"]')!;
            const rect = trigger.getBoundingClientRect();
            const question = document
              .querySelector("[data-og-jump-to-question]")!
              .getBoundingClientRect();
            const host = document.querySelector("header")!.getBoundingClientRect();
            return {
              position: getComputedStyle(trigger).position,
              top: rect.top,
              bottom: rect.bottom,
              // Flush with the scrollport: no scrolling row may show above it.
              expectedTop: viewport.getBoundingClientRect().top,
              questionTop: question.top,
              hostBottom: host.bottom,
              hit: trigger.contains(
                document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
              ),
              following: viewport.dataset.ogBottomFollow,
              overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
          });
          expect(geometry.position).toBe("sticky");
          expect(Math.abs(geometry.top - geometry.expectedTop)).toBeLessThanOrEqual(2);
          expect(geometry.questionTop).toBeGreaterThanOrEqual(geometry.bottom);
          expect(geometry.top).toBeGreaterThanOrEqual(geometry.hostBottom);
          expect(geometry.hit).toBe(true);
          expect(geometry.following).toBe("false");
          expect(geometry.overflow).toBe(false);
          expect(await header.textContent()).toContain("42 steps");
          expect(
            await page.locator('[data-og-recorded-outcome="wait"] summary').textContent(),
          ).toContain("Waiting for 2 agents");
          const output = process.env.OPENGENI_TIMELINE_PREVIEW_DIR;
          if (output) {
            mkdirSync(output, { recursive: true });
            await page.screenshot({ path: `${output}/timeline-${width}-${theme}-sticky.png` });
          }
          // The pinned hit target remains the real collapse control.
          await header.click();
          expect(await header.getAttribute("aria-expanded")).toBe("false");
          expect(await header.evaluate((node) => getComputedStyle(node).position)).not.toBe(
            "sticky",
          );
          await header.click();
          await page.evaluate(() =>
            window.exchangeFoldHarness!.show(window.exchangeFoldHarness!.total),
          );
          await page.waitForTimeout(350);
          await scrollInside();
          await page.evaluate(() => {
            const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
            const section = node.querySelector<HTMLElement>("[data-og-work-section]")!;
            node.scrollTop +=
              section.getBoundingClientRect().bottom - node.getBoundingClientRect().top + 100;
          });
          await page.waitForTimeout(200);
          expect(
            await header.evaluate((node) => node.getBoundingClientRect().bottom),
          ).toBeLessThanOrEqual(
            await scroller.evaluate((node) => node.getBoundingClientRect().top),
          );
          // Classic nested cluster disclosures also stay ordinary in-flow rows.
          await page.getByRole("button", { name: "Readable", exact: true }).click();
          await page.waitForTimeout(350);
          await page.locator('[data-og-work-header="outer"]').first().click();
          await page.waitForTimeout(300);
          const nested = page.locator('[data-og-work-header="nested"]');
          expect(await nested.count()).toBeGreaterThan(0);
          expect(
            await nested.evaluateAll((nodes) =>
              nodes.every((node) => getComputedStyle(node).position !== "sticky"),
            ),
          ).toBe(true);
        } finally {
          await page.context().close();
        }
      }, 60_000);

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
          expect(await page.locator("[data-og-wide-table-message]").count()).toBe(2);
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
