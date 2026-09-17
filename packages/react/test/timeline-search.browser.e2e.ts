import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

// Run against the existing scroll harness: bun run --cwd packages/react demo
// TIMELINE_SEARCH_BASE_URL=http://127.0.0.1:3100 bun test ./packages/react/test/timeline-search.browser.e2e.ts
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
});
afterAll(async () => {
  await browser?.close();
});

test("exact occurrences in a huge collapsed message scroll into view and closing find preserves position", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.TIMELINE_SEARCH_BASE_URL ?? "http://127.0.0.1:3100"}/timeline-scroll-test.html?search`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.timelineScrollHarness);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({
      sequence: 1040,
      eventId: "evt-1040",
      query: "[a+b]",
      occurrence: 0,
    }),
  );
  const activeRect = () =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
      const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
      const ranges = [...registry.entries()]
        .filter(([name]) => name.startsWith("og-search-"))
        .flatMap(([, value]) => [...value]);
      const rect = ranges[0]?.getBoundingClientRect();
      const root = scroller.getBoundingClientRect();
      return {
        top: rect?.top ?? -1,
        bottom: rect?.bottom ?? -1,
        rootTop: root.top,
        rootBottom: root.bottom,
        scrollTop: scroller.scrollTop,
      };
    });
  await page.waitForFunction(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    return [...registry.keys()].some((name) => name.startsWith("og-search-"));
  });
  await page.waitForTimeout(300);
  const first = await activeRect();
  expect(first.top).toBeGreaterThanOrEqual(first.rootTop);
  expect(first.bottom).toBeLessThanOrEqual(first.rootBottom);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({ sequence: 1040, query: "[a+b]", occurrence: 1 }),
  );
  await page.waitForTimeout(300);
  const second = await activeRect();
  expect(second.top).toBeGreaterThanOrEqual(second.rootTop);
  expect(second.bottom).toBeLessThanOrEqual(second.rootBottom);
  expect(second.scrollTop - first.scrollTop).toBeGreaterThan(10_000);
  await page.evaluate(() => window.timelineScrollHarness!.search(null));
  await page.waitForTimeout(300);
  const closed = await activeRect();
  expect(Math.abs(closed.scrollTop - second.scrollTop)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);

test("search opens a settled assistant turn and retains the expansion on close", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(
    `${process.env.TIMELINE_SEARCH_BASE_URL ?? "http://127.0.0.1:3100"}/timeline-scroll-test.html?search-fold`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.timelineScrollHarness);
  expect(await page.locator('[data-og-search-item="folded-answer"]').count()).toBe(0);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({ sequence: 2001, query: "needle" }),
  );
  await page.locator('[data-og-search-item="folded-answer"]').waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const position = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    const rect = document
      .querySelector<HTMLElement>('[data-og-search-item="folded-answer"]')!
      .getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      rootTop: root.getBoundingClientRect().top,
      rootBottom: root.getBoundingClientRect().bottom,
      scrollTop: root.scrollTop,
    };
  });
  expect(position.top).toBeGreaterThanOrEqual(position.rootTop);
  expect(position.bottom).toBeLessThanOrEqual(position.rootBottom);
  await page.evaluate(() => window.timelineScrollHarness!.search(null));
  await page.waitForTimeout(300);
  expect(await page.locator('[data-og-search-item="folded-answer"]').isVisible()).toBe(true);
  const closed = await page.evaluate(
    () => document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!.scrollTop,
  );
  expect(Math.abs(closed - position.scrollTop)).toBeLessThanOrEqual(1);
  await page.close();
}, 60_000);

test("a delayed virtualized renderer can materialize an occurrence without earlier matches", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(`${process.env.TIMELINE_SEARCH_BASE_URL ?? "http://127.0.0.1:3100"}/timeline-scroll-test.html?search-virtual`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.timelineScrollHarness);
  await page.evaluate(() => window.timelineScrollHarness!.search({ sequence: 1040, query: "needle", occurrence: 500 }));
  await page.locator('[data-og-search-occurrence="500"]').waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const position = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    const rect = document.querySelector<HTMLElement>('[data-og-search-occurrence="500"]')!.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, rootTop: root.getBoundingClientRect().top, rootBottom: root.getBoundingClientRect().bottom, scrollTop: root.scrollTop };
  });
  expect(position.top).toBeGreaterThanOrEqual(position.rootTop);
  expect(position.bottom).toBeLessThanOrEqual(position.rootBottom);
  await page.evaluate(() => window.timelineScrollHarness!.search(null));
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!.scrollTop);
  expect(Math.abs(closed - position.scrollTop)).toBeLessThanOrEqual(1);
  await page.close();
}, 60_000);
