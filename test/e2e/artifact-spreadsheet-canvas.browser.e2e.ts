import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type BrowserType,
  type ChromiumBrowser,
  type FirefoxBrowser,
  type WebKitBrowser,
} from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
type EngineId = "chromium" | "firefox" | "webkit";
type Engine = readonly [
  EngineId,
  string,
  BrowserType<ChromiumBrowser | FirefoxBrowser | WebKitBrowser>,
];

const availableEngines: readonly Engine[] = [
  ["chromium", "Chromium", chromium],
  ["firefox", "Firefox", firefox],
  ["webkit", "WebKit", webkit],
];
const requestedEngine = process.env.OPENGENI_ARTIFACT_CANVAS_BROWSER_ENGINE;
const engines = requestedEngine
  ? availableEngines.filter(([engineId]) => engineId === requestedEngine)
  : availableEngines;
if (requestedEngine && engines.length !== 1) {
  throw new TypeError(`Unsupported artifact canvas browser engine: ${requestedEngine}`);
}

describe("artifact spreadsheet retained canvas", () => {
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    baseUrl = `http://127.0.0.1:${webPort}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "--config",
        `${repoRoot}/packages/react/test/artifact-spreadsheet.vite.config.ts`,
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(baseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await web?.stop();
  }, 60_000);

  for (const [, engineName, engine] of engines) {
    test(`${engineName}: paints a Retina 1px-dense viewport with bounded semantic DOM`, async () => {
      const browser = await engine.launch({ headless: true });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({
          viewport: { width: 1_200, height: 800 },
          deviceScaleFactor: 2,
        });
        const page = await context.newPage();
        await prewarmDenseFixture(page, baseUrl);
        await mountDenseFixture(page, baseUrl);

        const grid = page.getByRole("grid", { name: "Dense sheet spreadsheet" });
        await grid.waitFor();
        await page.waitForFunction(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            "canvas[data-og-spreadsheet-canvas]",
          );
          return Number(canvas?.dataset.ogTileCacheSize ?? 0) > 0;
        });

        const initial = await grid.evaluate((element) => {
          const canvas = element.querySelector<HTMLCanvasElement>(
            "canvas[data-og-spreadsheet-canvas]",
          )!;
          const canvasRect = canvas.getBoundingClientRect();
          const gridRect = element.getBoundingClientRect();
          return {
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            cssWidth: canvasRect.width,
            cssHeight: canvasRect.height,
            canvasLeft: canvasRect.left - gridRect.left,
            canvasTop: canvasRect.top - gridRect.top,
            dpr: canvas.dataset.ogDevicePixelRatio,
            cacheSize: Number(canvas.dataset.ogTileCacheSize),
            rows: element.querySelectorAll('[role="row"]').length,
            cells: element.querySelectorAll('[role="gridcell"]').length,
          };
        });
        expect(initial.canvasWidth).toBe(Math.round(initial.cssWidth * 2));
        expect(initial.canvasHeight).toBe(Math.round(initial.cssHeight * 2));
        expect(initial.canvasLeft).toBeCloseTo(0, 2);
        expect(initial.canvasTop).toBeCloseTo(0, 2);
        expect(initial.dpr).toBe("2");
        expect(initial.cacheSize).toBeGreaterThan(0);
        expect(initial.rows).toBeLessThanOrEqual(512);
        expect(initial.cells).toBeLessThanOrEqual(2_048);
        const mountLatency = await page.evaluate(
          () =>
            performance.now() -
            Number(document.documentElement.dataset.ogDenseMountStarted ?? performance.now()),
        );
        expect(mountLatency).toBeLessThan(2_000);

        await page.addScriptTag({ path: axeScriptPath });
        const violations = await grid.evaluate(async (element) => {
          const axe = (globalThis as unknown as AxeGlobal).axe;
          const result = await axe.run(element, {
            runOnly: {
              type: "rule",
              values: [
                "aria-allowed-attr",
                "aria-required-attr",
                "aria-required-children",
                "aria-required-parent",
                "aria-valid-attr",
                "aria-valid-attr-value",
                "duplicate-id-aria",
              ],
            },
          });
          return result.violations.map((violation) => ({
            id: violation.id,
            targets: violation.nodes.slice(0, 3).map((node) => node.target),
          }));
        });
        expect(violations).toEqual([]);

        await grid.click({ position: { x: 243.5, y: 151.5 } });
        await page.waitForFunction(
          () => document.querySelector('[aria-label="Selected range"]')?.textContent === "CW101",
        );
        expect(await page.getByLabel("Selected range").textContent()).toBe("CW101");
        const activeId = await grid.getAttribute("aria-activedescendant");
        expect(activeId).toBeTruthy();
        expect(await page.locator(`#${activeId}`).count()).toBe(1);
        const formulaBar = page.getByLabel("Formula or value");
        await formulaBar.fill("dense edit");
        await formulaBar.press("Enter");
        await page.waitForFunction(
          () => document.querySelector('[data-og-cell="CW101"]')?.textContent === "dense edit",
        );

        const scrollPerformance = { latencyMs: [] as number[], paintDurationMs: [] as number[] };
        const canvasLocator = grid.locator("canvas[data-og-spreadsheet-canvas]");
        for (let index = 1; index <= 12; index += 1) {
          const target = index * 64;
          const started = performance.now();
          await grid.evaluate((element, logicalScrollLeft) => {
            element.scrollLeft = logicalScrollLeft;
          }, target);
          await page.waitForFunction(
            (logicalScrollLeft) =>
              Number(
                document.querySelector<HTMLCanvasElement>("canvas[data-og-spreadsheet-canvas]")
                  ?.dataset.ogLogicalScrollLeft,
              ) === logicalScrollLeft,
            target,
            { timeout: 2_000 },
          );
          scrollPerformance.paintDurationMs.push(
            await canvasLocator.evaluate((element) => Number(element.dataset.ogPaintDurationMs)),
          );
          scrollPerformance.latencyMs.push(performance.now() - started);
        }
        const orderedPaintDuration = [...scrollPerformance.paintDurationMs].sort(
          (left, right) => left - right,
        );
        const orderedPaintLatency = [...scrollPerformance.latencyMs].sort(
          (left, right) => left - right,
        );
        // Hold Chromium to a 60fps median. This pathological Retina 1px-cell fixture keeps
        // headless Firefox/WebKit to 30fps while universal tails remain independently bounded.
        const medianPaintBudgetMs = engineName === "Chromium" ? 16.7 : 33.4;
        expect(orderedPaintDuration).toHaveLength(12);
        expect(orderedPaintDuration[5]).toBeLessThan(medianPaintBudgetMs);
        expect(orderedPaintDuration[8]).toBeLessThan(50);
        expect(orderedPaintDuration[10]).toBeLessThan(100);
        expect(orderedPaintDuration[11]).toBeLessThan(500);
        expect(orderedPaintLatency[8]).toBeLessThan(500);
        expect(orderedPaintLatency[10]).toBeLessThan(1_000);
        expect(orderedPaintLatency[11]).toBeLessThan(2_000);
        await grid.evaluate((element) => {
          element.scrollLeft = 260;
        });
        await page.waitForFunction(() => {
          const gridElement = document.querySelector<HTMLElement>('[role="grid"]');
          const canvas = document.querySelector<HTMLCanvasElement>(
            "canvas[data-og-spreadsheet-canvas]",
          );
          if (!gridElement || !canvas || Number(canvas.dataset.ogReusedTiles ?? 0) <= 0)
            return false;
          return (
            Math.abs(
              canvas.getBoundingClientRect().left - gridElement.getBoundingClientRect().left,
            ) < 0.01
          );
        });
        const scrolled = await grid.evaluate((element) => {
          const canvas = element.querySelector<HTMLCanvasElement>(
            "canvas[data-og-spreadsheet-canvas]",
          )!;
          const canvasRect = canvas.getBoundingClientRect();
          const gridRect = element.getBoundingClientRect();
          return {
            left: canvasRect.left - gridRect.left,
            top: canvasRect.top - gridRect.top,
            painted: Number(canvas.dataset.ogPaintedTiles),
            reused: Number(canvas.dataset.ogReusedTiles),
          };
        });
        expect(scrolled.left).toBeCloseTo(0, 2);
        expect(scrolled.top).toBeCloseTo(0, 2);
        expect(scrolled.painted).toBeGreaterThanOrEqual(0);
        expect(scrolled.reused).toBeGreaterThan(0);

        await grid.evaluate((element) => {
          element.scrollLeft = 0;
          element.scrollTop = 0;
        });
        expect(await page.getByLabel("Selected range").textContent()).toBe("CW101");
        await grid.dblclick({ position: { x: 52.5, y: 32.5 } });
        const editor = page.getByLabel("Edit E5");
        await editor.waitFor();
        await editor.fill("日本語");
        await editor.evaluate((element) => {
          element.setSelectionRange(1, 1);
          element.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true, data: "日" }),
          );
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: "Enter",
              isComposing: true,
            }),
          );
        });
        expect(await editor.count()).toBe(1);
        expect(await editor.evaluate((element) => element.selectionStart)).toBe(1);
        await editor.evaluate((element) => {
          element.dispatchEvent(
            new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
          );
        });
        await editor.press("Enter");
        await page.waitForFunction(
          () => document.querySelector('[data-og-cell="E5"]')?.textContent === "日本語",
        );
        expect(await page.locator('[data-og-cell="E5"]').textContent()).toBe("日本語");
      } finally {
        await context?.close();
        await browser.close();
      }
    }, 60_000);
  }
});

type AxeGlobal = typeof globalThis & {
  axe: {
    run(
      context: Element,
      options: { runOnly: { type: "rule"; values: string[] } },
    ): Promise<{
      violations: Array<{ id: string; nodes: Array<{ target: string[] }> }>;
    }>;
  };
};

const axeScriptPath = new URL(
  import.meta.resolve("axe-core/axe.min.js", import.meta.resolve("@axe-core/playwright")),
).pathname;

async function prewarmDenseFixture(
  page: import("playwright").Page,
  baseUrl: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openFixtureHost(page, baseUrl);
    try {
      await importAndMountDenseFixture(page, baseUrl, "prewarm");
      return;
    } catch (cause) {
      if (attempt === 0 && isColdViteReload(cause)) continue;
      throw cause;
    }
  }
}

async function mountDenseFixture(page: import("playwright").Page, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openFixtureHost(page, baseUrl);
    try {
      await importAndMountDenseFixture(page, baseUrl, "test");
      await page.waitForFunction(
        () => document.documentElement.dataset.ogDenseFixtureReady === "test",
      );
      return;
    } catch (cause) {
      if (attempt === 0 && isColdViteReload(cause)) continue;
      throw cause;
    }
  }
}

async function openFixtureHost(page: import("playwright").Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/artifact-spreadsheet-test.html`, {
    waitUntil: "domcontentloaded",
  });
}

async function importAndMountDenseFixture(
  page: import("playwright").Page,
  baseUrl: string,
  marker: "prewarm" | "test",
): Promise<void> {
  await page.evaluate(
    async ({ fixtureBaseUrl, readinessMarker }) => {
      const fixtureUrl = new URL("/artifact-spreadsheet-scroll-fixture.tsx", fixtureBaseUrl).href;
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = new URL("/styles.css", fixtureBaseUrl).href;
      await new Promise<void>((resolve, reject) => {
        stylesheet.addEventListener("load", () => resolve(), { once: true });
        stylesheet.addEventListener(
          "error",
          () => reject(new Error("Fixture CSS failed to load")),
          {
            once: true,
          },
        );
        document.head.replaceChildren(stylesheet);
      });
      const { mountDenseSpreadsheet } = (await import(/* @vite-ignore */ fixtureUrl)) as {
        mountDenseSpreadsheet: (target: HTMLElement) => void;
      };
      document.body.replaceChildren();
      document.documentElement.dataset.ogDenseMountStarted = String(performance.now());
      const target = document.createElement("div");
      Object.assign(target.style, { width: "900px", height: "516px" });
      document.body.append(target);
      mountDenseSpreadsheet(target);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      document.documentElement.dataset.ogDenseFixtureReady = readinessMarker;
    },
    { fixtureBaseUrl: baseUrl, readinessMarker: marker },
  );
}

function isColdViteReload(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /execution context was destroyed|most likely because of a navigation|target closed|outdated optimize dep|(?:failed to fetch|error loading) dynamically imported module/iu.test(
    message,
  );
}
