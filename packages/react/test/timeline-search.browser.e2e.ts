import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, runCommand } from "@opengeni/testing";

let browser: Browser;
let baseUrl: string;
let buildDirectory: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), "opengeni-timeline-search-"));
  const build = await runCommand(["bun", "run", "vite", "build", "."], {
    cwd: new URL("../demo", import.meta.url).pathname,
    env: {
      OPENGENI_REACT_DEMO_OUT_DIR: buildDirectory,
      OPENGENI_TIMELINE_SCROLL_TEST_BUILD: "1",
    },
    timeoutMs: 120_000,
  });
  if (build.exitCode !== 0)
    throw new Error(`Timeline search harness build failed: ${build.stderr}`);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: async (request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
      if (pathname.includes("..")) return new Response("Not found", { status: 404 });
      const asset = Bun.file(join(buildDirectory!, pathname || "timeline-scroll-test.html"));
      return (await asset.exists())
        ? new Response(asset, { headers: { "content-type": asset.type } })
        : new Response("Not found", { status: 404 });
    },
  });
  const executablePath = [
    process.env.CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/local/bin/chromium",
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 150_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
});

/** Wait for the selected range, not merely an old registered highlight or a timer. */
async function visibleSearchRange(
  page: Page,
  expected: { query: string; sequence?: number; occurrence?: number; offset?: number },
) {
  // Playwright polls the predicate's immediate truthiness: an async predicate
  // returns a truthy Promise even when it later resolves to false. Keep both
  // the predicate and its cross-animation-frame stability check synchronous.
  const probe = await page.evaluateHandle((target) => {
    let previous: { top: number; bottom: number; scrollTop: number } | null = null;
    let stableFrames = 0;
    const snapshot = () => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
      if (!scroller) return null;
      const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
      const ranges = [...registry.entries()]
        .filter(([name]) => name.startsWith("og-search-"))
        .flatMap(([, value]) => [...value]);
      if (ranges.length !== 1 || ranges[0]!.toString() !== target.query) return null;
      const range = ranges[0]!;
      const marker = range.startContainer.parentElement?.closest<HTMLElement>(
        "[data-og-search-occurrence]",
      );
      if (target.sequence != null && marker?.dataset.ogSearchSequence !== String(target.sequence))
        return null;
      if (
        target.occurrence != null &&
        marker?.dataset.ogSearchOccurrence !== String(target.occurrence)
      )
        return null;
      if (target.offset != null && marker?.dataset.ogSearchOffset !== String(target.offset))
        return null;
      if (target.sequence != null && marker?.dataset.ogSearchQuery !== target.query) return null;
      const rect = range.getBoundingClientRect();
      const root = scroller.getBoundingClientRect();
      if (!rect.height || rect.top < root.top || rect.bottom > root.bottom) return null;
      return { top: rect.top, bottom: rect.bottom, scrollTop: scroller.scrollTop };
    };
    return () => {
      const current = snapshot();
      if (
        current &&
        previous &&
        Math.abs(current.top - previous.top) <= 1 &&
        Math.abs(current.scrollTop - previous.scrollTop) <= 1
      )
        stableFrames++;
      else stableFrames = 0;
      previous = current;
      return current && stableFrames >= 2 ? current : false;
    };
  }, expected);
  try {
    const handle = await page.waitForFunction((poll) => poll(), probe, { polling: "raf" });
    try {
      return (await handle.jsonValue()) as { top: number; bottom: number; scrollTop: number };
    } finally {
      await handle.dispose();
    }
  } finally {
    await probe.dispose();
  }
}

test("visibleSearchRange waits for a delayed highlight instead of returning false", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<div data-og-timeline-scroller style="height: 200px"><span>needle</span></div>',
    );
    await page.evaluate(() => {
      setTimeout(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("span")!);
        const registry = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
        const HighlightClass = (window as unknown as { Highlight: new (range: Range) => unknown })
          .Highlight;
        registry.set("og-search-delayed-probe", new HighlightClass(range));
      }, 250);
    });
    const position = await visibleSearchRange(page, { query: "needle" });
    expect(position).toEqual({ top: expect.any(Number), bottom: expect.any(Number), scrollTop: 0 });
  } finally {
    await page.close();
  }
}, 60_000);

async function waitForSearchClosed(page: Page) {
  await page.waitForFunction(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    return ![...registry.keys()].some((name) => name.startsWith("og-search-"));
  });
}

test("exact occurrences in a huge collapsed message scroll into view and closing find preserves position", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/timeline-scroll-test.html?search`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.timelineScrollHarness);
  // Keep the far-apart source fixture: source focus deliberately does not mount
  // its 800 intervening paragraphs while navigating either occurrence.
  const source = `first literal [a+b] match\n\n${"Long source paragraph.\n\n".repeat(800)}last literal [a+b] match`;
  const firstOffset = source.indexOf("[a+b]");
  const secondOffset = source.lastIndexOf("[a+b]");
  expect(secondOffset - firstOffset).toBeGreaterThan(10_000);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({
      sequence: 1040,
      eventId: "evt-1040",
      query: "[a+b]",
      occurrence: 0,
    }),
  );
  await visibleSearchRange(page, {
    sequence: 1040,
    query: "[a+b]",
    occurrence: 0,
    offset: firstOffset,
  });
  const body = page.locator('[data-og-search-item="row-1040"]');
  expect(await body.locator("mark").textContent()).toBe("[a+b]");
  expect((await body.textContent())!.length).toBeLessThan(1000);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({ sequence: 1040, query: "[a+b]", occurrence: 1 }),
  );
  const second = await visibleSearchRange(page, {
    sequence: 1040,
    query: "[a+b]",
    occurrence: 1,
    offset: secondOffset,
  });
  const selected = body.locator(`[data-og-search-offset="${secondOffset}"]`);
  const sourceWindow = await selected.evaluate((element) => element.parentElement!.textContent);
  expect((await body.textContent())!.length).toBeLessThan(1000);
  await page.evaluate(() => window.timelineScrollHarness!.search(null));
  await waitForSearchClosed(page);
  await page.waitForFunction((offset) => {
    const marker = document.querySelector<HTMLElement>(
      `[data-og-search-item="row-1040"] [data-og-search-offset="${offset}"]`,
    );
    return (
      marker?.tagName === "SPAN" && !marker.closest("[data-og-search-item]")?.querySelector("mark")
    );
  }, secondOffset);
  const closed = await selected.evaluate((element) => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    const root = scroller.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      rootTop: root.top,
      rootBottom: root.bottom,
      scrollTop: scroller.scrollTop,
    };
  });
  expect(await selected.textContent()).toBe("[a+b]");
  expect(await selected.evaluate((element) => element.parentElement!.textContent)).toBe(
    sourceWindow,
  );
  expect(closed.top).toBeGreaterThanOrEqual(closed.rootTop);
  expect(closed.bottom).toBeLessThanOrEqual(closed.rootBottom);
  expect(Math.abs(closed.top - second.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(closed.scrollTop - second.scrollTop)).toBeLessThanOrEqual(1);
  await body.getByRole("button", { name: "Show formatted message" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-og-search-item="row-1040"]')?.querySelectorAll("p").length ===
      802,
  );
  expect(await body.locator("[data-og-search-occurrence]").count()).toBe(0);
  expect(await body.locator("p").first().textContent()).toBe("first literal [a+b] match");
  expect(await body.locator("p").last().textContent()).toBe("last literal [a+b] match");
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);

test("search opens a settled assistant turn and retains the expansion on close", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(`${baseUrl}/timeline-scroll-test.html?search-fold`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.timelineScrollHarness);
  expect(await page.locator('[data-og-search-item="folded-answer"]').count()).toBe(0);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({ sequence: 2001, query: "needle" }),
  );
  await page.locator('[data-og-search-item="folded-answer"]').waitFor({ state: "visible" });
  await visibleSearchRange(page, { query: "needle" });
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
  await waitForSearchClosed(page);
  expect(await page.locator('[data-og-search-item="folded-answer"]').isVisible()).toBe(true);
  const closed = await page.evaluate(
    () => document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!.scrollTop,
  );
  expect(Math.abs(closed - position.scrollTop)).toBeLessThanOrEqual(1);
  await page.close();
}, 60_000);

test("a delayed virtualized renderer can materialize an occurrence without earlier matches", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(`${baseUrl}/timeline-scroll-test.html?search-virtual`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.timelineScrollHarness);
  await page.evaluate(() =>
    window.timelineScrollHarness!.search({ sequence: 1040, query: "needle", occurrence: 500 }),
  );
  await page.locator('[data-og-search-occurrence="500"]').waitFor({ state: "visible" });
  await visibleSearchRange(page, { sequence: 1040, query: "needle", occurrence: 500 });
  const position = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    const rect = document
      .querySelector<HTMLElement>('[data-og-search-occurrence="500"]')!
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
  await waitForSearchClosed(page);
  const closed = await page.evaluate(
    () => document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!.scrollTop,
  );
  expect(Math.abs(closed - position.scrollTop)).toBeLessThanOrEqual(1);
  await page.close();
}, 60_000);
