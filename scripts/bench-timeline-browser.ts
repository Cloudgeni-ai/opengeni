#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { chromium, type CDPSession, type Page } from "playwright";

type Fixture = {
  eventCount: number;
  sessionId: string;
  shape?: "messages" | "turns";
  workspaceId: string;
};

const fixtureFile = stringArgument("--fixtures") ?? "/tmp/opengeni-timeline-fixtures.ndjson";
const webOrigin = stringArgument("--web-origin") ?? "http://127.0.0.1:3001";
const samples = integerArgument("--samples", 1);
const cpuThrottleRate = integerArgument("--cpu-throttle", 4);
const allowInertFixtureErrors = process.argv.includes("--allow-inert-fixture-errors");
const cpuProfilePrefix = stringArgument("--cpu-profile-prefix");
const selectedCounts = new Set(integerListArgument("--counts"));
if (!existsSync(fixtureFile)) throw new Error(`fixture file does not exist: ${fixtureFile}`);
if (samples < 1 || samples > 10) throw new Error("--samples must be between 1 and 10");
if (cpuThrottleRate < 1 || cpuThrottleRate > 20) {
  throw new Error("--cpu-throttle must be between 1 and 20");
}

const fixtures = readFileSync(fixtureFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Fixture)
  .filter((fixture) => selectedCounts.size === 0 || selectedCounts.has(fixture.eventCount));
if (fixtures.length === 0) throw new Error("no matching timeline fixtures");

const browser = await chromium.launch();
try {
  const receipts = [];
  for (const fixture of fixtures) {
    const fixtureSamples = [];
    const markerMode = fixture.shape ?? "messages";
    const expectedMarkerCount = expectedMarkers(fixture.eventCount, markerMode);
    for (let sample = 0; sample < samples; sample += 1) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      await context.addInitScript(() => {
        const longTasks: number[] = [];
        (window as unknown as { __timelineLongTasks: number[] }).__timelineLongTasks = longTasks;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
      if (cpuProfilePrefix) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 1_000 });
      }
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") {
          const source = message.location().url;
          if (!isExpectedBrowserError(message.text(), source, allowInertFixtureErrors)) {
            errors.push(source ? `${message.text()} (${source})` : message.text());
          }
        }
      });
      const url = `${webOrigin}/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
      const startedAt = performance.now();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      try {
        const startupState = await page.waitForFunction(
          () => {
            const timeline = document.querySelector("[data-og-timeline-scroller]");
            if (timeline) return "timeline";
            if (document.body.textContent?.includes("Client configuration unavailable")) {
              return "configuration-error";
            }
            return false;
          },
          undefined,
          { timeout: 60_000, polling: 50 },
        );
        if ((await startupState.jsonValue()) !== "timeline") {
          throw new Error("production bundle could not load its client configuration");
        }
      } catch (error) {
        const diagnosis = await page.evaluate(() => ({
          href: location.href,
          title: document.title,
          bodyText: document.body.textContent?.slice(0, 2_000) ?? "",
          htmlChars: document.documentElement.outerHTML.length,
        }));
        throw new Error(
          `timeline surface did not mount: ${JSON.stringify({ diagnosis, errors })}`,
          { cause: error },
        );
      }
      const initialExpected = Math.min(markerMode === "turns" ? 250 : 1_000, expectedMarkerCount);
      await waitForTimelineProgress(page, initialExpected, "at-least", 120_000, markerMode);
      await settleFrames(page);
      const initialReadyMs = performance.now() - startedAt;
      const initial = await measure(page, cdp, markerMode);
      const prepends = [];
      let currentCount = initial.markerCount;
      for (let attempt = 0; currentCount < expectedMarkerCount && attempt < 20; attempt += 1) {
        const before = await measure(page, cdp, markerMode);
        const metricsBefore = await performanceMetrics(cdp);
        const longTaskStart = before.longTasks.length;
        const loadStartedAt = performance.now();
        if (cpuProfilePrefix) await cdp.send("Profiler.start");
        const scroller = page.locator("[data-og-timeline-scroller]");
        const olderLoadAlreadyRunning =
          (await page.getByText("Loading earlier activity…", { exact: true }).count()) > 0;
        if (!olderLoadAlreadyRunning) {
          const bounds = await scroller.boundingBox();
          if (!bounds) throw new Error("timeline scroller has no layout bounds");
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, -1_000_000);
        }
        const nextCount = await waitForTimelineProgress(
          page,
          currentCount,
          "greater-than",
          180_000,
          markerMode,
        );
        await settleFrames(page);
        const elapsedMs = performance.now() - loadStartedAt;
        if (cpuProfilePrefix) {
          const { profile } = (await cdp.send("Profiler.stop")) as {
            profile: unknown;
          };
          await Bun.write(
            `${cpuProfilePrefix}-${fixture.eventCount}-${sample}-${attempt}.cpuprofile`,
            JSON.stringify(profile),
          );
        }
        const after = await measure(page, cdp, markerMode);
        const metricsAfter = await performanceMetrics(cdp);
        prepends.push({
          fromMarkers: currentCount,
          toMarkers: nextCount,
          elapsedMs,
          olderLoadAlreadyRunning,
          addedMarkers: nextCount - currentCount,
          addedNodes: after.nodeCount - before.nodeCount,
          heapDeltaBytes: nullableDelta(after.jsHeapUsedBytes, before.jsHeapUsedBytes),
          longTasks: after.longTasks.slice(longTaskStart),
          performanceDelta: metricDelta(metricsAfter, metricsBefore),
        });
        currentCount = nextCount;
      }
      const totalReadyMs = performance.now() - startedAt;
      const complete = await measure(page, cdp, markerMode);
      const parity = await markerParity(page, expectedMarkerCount, markerMode);
      const completeDomBreakdown = await domBreakdown(page);
      if (!parity.passed) {
        throw new Error(
          `timeline ${fixture.eventCount} lost content: ${JSON.stringify({ complete, parity })}`,
        );
      }
      if (errors.length > 0) {
        throw new Error(`timeline ${fixture.eventCount} browser errors: ${errors.join("; ")}`);
      }
      await cdp.send("HeapProfiler.collectGarbage");
      await settleFrames(page);
      const completeAfterGc = await measure(page, cdp, markerMode);
      fixtureSamples.push({
        initialReadyMs,
        totalReadyMs,
        initial,
        complete,
        completeAfterGc,
        completeDomBreakdown,
        prepends,
        parity,
      });
      await cdp.detach();
      await context.close();
    }
    receipts.push({
      eventCount: fixture.eventCount,
      shape: markerMode,
      expectedMarkerCount,
      samples,
      initialReadyMs: distribution(fixtureSamples.map((sample) => sample.initialReadyMs)),
      totalReadyMs: distribution(fixtureSamples.map((sample) => sample.totalReadyMs)),
      initialMarkers: fixtureSamples[0]!.initial.markerCount,
      completeMarkers: fixtureSamples[0]!.complete.markerCount,
      completeUniqueMarkers: fixtureSamples[0]!.parity.uniqueMarkers,
      completeNodeCount: distribution(fixtureSamples.map((sample) => sample.complete.nodeCount)),
      completeHeapBytes: distribution(
        fixtureSamples.flatMap((sample) =>
          sample.complete.jsHeapUsedBytes === null ? [] : [sample.complete.jsHeapUsedBytes],
        ),
      ),
      completeRetainedHeapBytes: distribution(
        fixtureSamples.flatMap((sample) =>
          sample.completeAfterGc.jsHeapUsedBytes === null
            ? []
            : [sample.completeAfterGc.jsHeapUsedBytes],
        ),
      ),
      completeScrollHeight: fixtureSamples[0]!.complete.scrollHeight,
      completeTextChars: fixtureSamples[0]!.complete.textChars,
      completeDomBreakdown: fixtureSamples[0]!.completeDomBreakdown,
      totalLongTaskMs: distribution(
        fixtureSamples.map((sample) =>
          sample.complete.longTasks.reduce((sum, duration) => sum + duration, 0),
        ),
      ),
      maximumLongTaskMs: distribution(
        fixtureSamples.map((sample) => Math.max(0, ...sample.complete.longTasks)),
      ),
      horizontalOverflow: Math.max(
        ...fixtureSamples.map((sample) => sample.complete.horizontalOverflow),
      ),
      prepends: fixtureSamples.map((sample) => sample.prepends),
      contentParity: fixtureSamples.every((sample) => sample.parity.passed) ? "pass" : "fail",
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        surface: "production OpenGeni session timeline with complete rich user-message content",
        viewport: { width: 390, height: 844, mobile: true, touch: true },
        cpuThrottleRate,
        invariant:
          "Every seeded marker and its complete containing message must remain mounted exactly once; no virtualization, content visibility, truncation, pagination reduction, or hidden body is admitted.",
        receipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}

async function waitForTimelineProgress(
  page: Page,
  threshold: number,
  comparison: "at-least" | "greater-than",
  timeoutMs: number,
  markerMode: "messages" | "turns",
): Promise<number> {
  const handle = await page.waitForFunction(
    ({ expected, mode, markers }) => {
      const scroller = document.querySelector("[data-og-timeline-scroller]");
      // The deterministic turn fixture renders one durable anchor per visible
      // user or assistant marker. Polling those structural
      // anchors avoids repeatedly scanning megabytes of visible transcript
      // text while the product is still rendering. Exact text/content parity
      // is still checked once after the product-ready clock stops.
      const count =
        markers === "turns"
          ? (scroller?.querySelectorAll("[data-og-timeline-group-anchor]").length ?? 0)
          : (scroller?.textContent?.match(/Marker \d{5}/gu)?.length ?? 0);
      return (mode === "at-least" ? count >= expected : count > expected) ? count : false;
    },
    { expected: threshold, mode: comparison, markers: markerMode },
    { timeout: timeoutMs, polling: 50 },
  );
  return (await handle.jsonValue()) as number;
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function measure(page: Page, cdp: CDPSession, markerMode: "messages" | "turns") {
  const [dom, pageValues, metrics] = await Promise.all([
    cdp.send("Memory.getDOMCounters") as Promise<{
      documents: number;
      jsEventListeners: number;
      nodes: number;
    }>,
    page.evaluate((markers) => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
      const pattern = markers === "turns" ? /Marker [UA]\d{5}/gu : /Marker \d{5}/gu;
      const longTasks =
        (window as unknown as { __timelineLongTasks?: number[] }).__timelineLongTasks ?? [];
      return {
        markerCount: scroller?.textContent?.match(pattern)?.length ?? 0,
        groupCount: scroller?.querySelectorAll("[data-og-timeline-group-anchor]").length ?? 0,
        scrollHeight: scroller?.scrollHeight ?? 0,
        textChars: scroller?.textContent?.length ?? 0,
        horizontalOverflow: scroller ? Math.max(0, scroller.scrollWidth - scroller.clientWidth) : 0,
        longTasks: [...longTasks],
      };
    }, markerMode),
    performanceMetrics(cdp),
  ]);
  const heap = metrics.JSHeapUsedSize;
  return {
    ...pageValues,
    nodeCount: dom.nodes,
    documentCount: dom.documents,
    jsEventListeners: dom.jsEventListeners,
    jsHeapUsedBytes: heap ?? null,
  };
}

async function domBreakdown(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    const tags = new Map<string, number>();
    const classes = new Map<string, number>();
    const dataAttributes = new Map<string, number>();
    for (const element of scroller?.querySelectorAll("*") ?? []) {
      const tag = element.tagName.toLowerCase();
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
      const className = element.getAttribute("class");
      if (className) classes.set(className, (classes.get(className) ?? 0) + 1);
      for (const attribute of element.getAttributeNames()) {
        if (attribute.startsWith("data-og-")) {
          dataAttributes.set(attribute, (dataAttributes.get(attribute) ?? 0) + 1);
        }
      }
    }
    const top = (counts: Map<string, number>, limit: number) =>
      [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([name, count]) => ({ name, count }));
    return {
      tags: top(tags, 40),
      classes: top(classes, 60),
      dataAttributes: top(dataAttributes, 60),
    };
  });
}

async function markerParity(page: Page, expectedCount: number, markerMode: "messages" | "turns") {
  return await page.evaluate(
    ({ expected, markers: markerShape }) => {
      const scroller = document.querySelector("[data-og-timeline-scroller]");
      const pattern = markerShape === "turns" ? /Marker ([UA]\d{5})/gu : /Marker (\d{5})/gu;
      const found = [...(scroller?.textContent?.matchAll(pattern) ?? [])].map((match) => match[1]!);
      const unique = new Set(found);
      let ordered = found.length === expected;
      for (let index = 0; index < found.length && ordered; index += 1) {
        const position = Math.floor(index / 2) + 1;
        const expectedMarker =
          markerShape === "turns"
            ? `${index % 2 === 0 ? "U" : "A"}${String(position).padStart(5, "0")}`
            : String(index + 1).padStart(5, "0");
        ordered = found[index] === expectedMarker;
      }
      return {
        markers: found.length,
        uniqueMarkers: unique.size,
        first: found[0] ?? null,
        last: found.at(-1) ?? null,
        ordered,
        passed: found.length === expected && unique.size === expected && ordered,
      };
    },
    { expected: expectedCount, markers: markerMode },
  );
}

function expectedMarkers(eventCount: number, shape: "messages" | "turns"): number {
  if (shape === "messages") return eventCount;
  return Math.floor(eventCount / 4) * 2 + Math.min(eventCount % 4, 2);
}

async function performanceMetrics(cdp: CDPSession): Promise<Record<string, number>> {
  const response = (await cdp.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
}

function metricDelta(
  after: Record<string, number>,
  before: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((name) => [
      name,
      (after[name] ?? 0) - (before[name] ?? 0),
    ]),
  );
}

function nullableDelta(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before;
}

function isExpectedBrowserError(
  message: string,
  source: string,
  allowInertErrors: boolean,
): boolean {
  if (
    message.includes("the server responded with a status of 404") &&
    /\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/goal$/u.test(source)
  ) {
    return true;
  }
  if (!allowInertErrors) return false;
  return (
    (message.includes("the server responded with a status of 404") &&
      /\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/stream-capabilities$/u.test(source)) ||
    (message.includes("the server responded with a status of 503") &&
      /\/v1\/workspaces\/[^/]+\/editable-artifacts\?/u.test(source))
  );
}

function distribution(values: number[]) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function stringArgument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function integerListArgument(name: string): number[] {
  const value = stringArgument(name);
  if (value === null || value.trim() === "") return [];
  const parsed = value.split(",").map((entry) => Number.parseInt(entry, 10));
  if (parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    throw new Error(`${name} must be a comma-separated positive integer list`);
  }
  return parsed;
}
