#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { chromium, type CDPSession, type Page } from "playwright";

const origin = process.env.QUEUE_DEPTH_WEB_ORIGIN ?? "http://127.0.0.1:3005";
const count = Number(process.env.QUEUE_DEPTH_COUNT ?? "5000");
const outputPath = process.env.QUEUE_DEPTH_OUTPUT;
const expectedPrompt = (ordinal: number) =>
  `Queued performance prompt ${String(ordinal).padStart(5, "0")} ${"q".repeat(480)}`;
const cases = [
  {
    name: "mobile-touch",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    expectedIntrinsic: "auto 44px",
  },
  {
    name: "desktop-pointer",
    viewport: { width: 1280, height: 900 },
    hasTouch: false,
    isMobile: false,
    expectedIntrinsic: "auto 28px",
  },
] as const;

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);
const results: Array<Record<string, unknown>> = [];

try {
  for (const fixture of cases) {
    const context = await browser.newContext({
      viewport: fixture.viewport,
      hasTouch: fixture.hasTouch,
      isMobile: fixture.isMobile,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    try {
      results.push(await measure(page, cdp, fixture, errors));
    } finally {
      await cdp.detach().catch(() => undefined);
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  origin,
  count,
  invariant:
    "Every prompt and action remains mounted. This benchmark validates native find, the full accessibility tree, deep focus, and scroll geometry without pagination or truncation.",
  results,
};
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized);
else process.stdout.write(serialized);

async function measure(
  page: Page,
  cdp: CDPSession,
  fixture: (typeof cases)[number],
  errors: string[],
) {
  await page.goto(
    `${origin}/dev/composer-chrome?scenario=queued-only&queueCount=${count}&queueOpen=0&queueReadOnly=0`,
    { waitUntil: "networkidle", timeout: 60_000 },
  );
  await page.locator('[data-og-session-chrome-signal="queue"]').click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll("[data-queue-turn-id]").length === expected,
    count,
    { timeout: 60_000 },
  );
  await settleFrames(page);

  const initial = await geometry(page);
  const lastText = expectedPrompt(count);
  const findStartedAt = performance.now();
  const find = await page.evaluate((text) => {
    const nativeFind = (window as unknown as { find?: (needle: string) => boolean }).find;
    const found = nativeFind?.call(window, text) ?? false;
    return {
      found,
      selection: window.getSelection()?.toString() ?? "",
    };
  }, lastText);
  await settleFrames(page);
  const findMs = performance.now() - findStartedAt;
  const afterFind = await geometry(page);

  const focusStartedAt = performance.now();
  const lastMore = page.getByRole("button", {
    name: `More actions for queued prompt ${count}`,
    exact: true,
  });
  await lastMore.focus();
  await settleFrames(page);
  const focusMs = performance.now() - focusStartedAt;
  const afterFocus = await geometry(page);
  const focus = await page.evaluate(() => ({
    label: document.activeElement?.getAttribute("aria-label") ?? null,
    visible: document.activeElement
      ? (() => {
          const box = document.activeElement.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight;
        })()
      : false,
  }));

  const scrollCycles = [];
  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => {
      const queue = document.querySelector<HTMLElement>('[data-og-session-chrome-panel="queue"]');
      const panel = queue?.closest<HTMLElement>(
        "[data-og-session-chrome-panel-frame]",
      )?.parentElement;
      if (!panel) throw new Error("queue scroller missing");
      panel.scrollTop = 0;
    });
    await settleFrames(page);
    const top = await geometry(page);
    await page.evaluate(() => {
      const queue = document.querySelector<HTMLElement>('[data-og-session-chrome-panel="queue"]');
      const panel = queue?.closest<HTMLElement>(
        "[data-og-session-chrome-panel-frame]",
      )?.parentElement;
      if (!panel) throw new Error("queue scroller missing");
      panel.scrollTop = panel.scrollHeight;
    });
    await settleFrames(page);
    scrollCycles.push({ top, bottom: await geometry(page) });
  }

  const axStartedAt = performance.now();
  const accessibility = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: Array<{ name?: { value?: unknown }; role?: { value?: unknown } }>;
  };
  const axMs = performance.now() - axStartedAt;
  const lastPromptInAccessibilityTree = accessibility.nodes.some(
    (node) => node.name?.value === lastText,
  );
  const lastActionInAccessibilityTree = accessibility.nodes.some(
    (node) => node.name?.value === `More actions for queued prompt ${count}`,
  );

  const scrollHeights = [
    initial.scrollHeight,
    afterFind.scrollHeight,
    afterFocus.scrollHeight,
    ...scrollCycles.flatMap(({ top, bottom }) => [top.scrollHeight, bottom.scrollHeight]),
  ];
  const scrollHeightSpread = Math.max(...scrollHeights) - Math.min(...scrollHeights);
  const assertions = {
    allRowsMounted: initial.rowCount === count,
    allTextRetained: initial.completeTextCount === count,
    nativeFindReachedLastPrompt: find.found && find.selection === lastText,
    deepFocusReachedLastAction:
      focus.label === `More actions for queued prompt ${count}` && focus.visible,
    lastPromptInAccessibilityTree,
    lastActionInAccessibilityTree,
    responsiveIntrinsicMatches:
      initial.firstIntrinsic === fixture.expectedIntrinsic &&
      initial.lastIntrinsic === fixture.expectedIntrinsic,
    noHorizontalOverflow: initial.documentOverflow <= 1,
    noPageErrors: errors.length === 0,
  };
  if (Object.values(assertions).some((value) => !value)) {
    throw new Error(`${fixture.name} queue depth assertion failed: ${JSON.stringify(assertions)}`);
  }
  return {
    name: fixture.name,
    viewport: fixture.viewport,
    expectedIntrinsic: fixture.expectedIntrinsic,
    initial,
    find: { ...find, elapsedMs: findMs, after: afterFind },
    focus: { ...focus, elapsedMs: focusMs, after: afterFocus },
    accessibility: {
      elapsedMs: axMs,
      nodeCount: accessibility.nodes.length,
      lastPromptInAccessibilityTree,
      lastActionInAccessibilityTree,
    },
    scrollCycles,
    scrollHeightSpread,
    errors,
    assertions,
  };
}

async function geometry(page: Page) {
  return await page.evaluate(
    ({ expectedCount }) => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-queue-turn-id]")];
      const queue = document.querySelector<HTMLElement>('[data-og-session-chrome-panel="queue"]');
      const panel = queue?.closest<HTMLElement>(
        "[data-og-session-chrome-panel-frame]",
      )?.parentElement;
      if (!panel) throw new Error("queue scroller missing");
      const first = rows[0];
      const last = rows.at(-1);
      const panelBox = panel.getBoundingClientRect();
      const lastBox = last?.getBoundingClientRect();
      return {
        rowCount: rows.length,
        completeTextCount: rows.filter(
          (row, index) =>
            row.querySelector("p")?.textContent ===
            `Queued performance prompt ${String(index + 1).padStart(5, "0")} ${"q".repeat(480)}`,
        ).length,
        scrollTop: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        bottomGap: panel.scrollHeight - panel.scrollTop - panel.clientHeight,
        documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        firstHeight: first?.getBoundingClientRect().height ?? null,
        lastHeight: lastBox?.height ?? null,
        firstIntrinsic: first ? getComputedStyle(first).containIntrinsicSize : null,
        lastIntrinsic: last ? getComputedStyle(last).containIntrinsicSize : null,
        lastInPanel:
          lastBox !== undefined &&
          lastBox.top >= panelBox.top - 0.5 &&
          lastBox.bottom <= panelBox.bottom + 0.5,
        expectedCount,
      };
    },
    { expectedCount: count },
  );
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
