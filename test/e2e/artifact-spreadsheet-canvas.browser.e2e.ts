import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type BrowserType,
  type ChromiumBrowser,
  type FirefoxBrowser,
  type Locator,
  type Page,
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
        const bootEvents: string[] = [];
        const recordBootEvent = (event: string) => {
          bootEvents.push(event.slice(0, 1_000));
          if (bootEvents.length > 20) bootEvents.shift();
        };
        page.on("pageerror", (error) => recordBootEvent(`pageerror: ${error.message}`));
        page.on("console", (message) => {
          if (message.type() === "error") recordBootEvent(`console: ${message.text()}`);
        });
        page.on("requestfailed", (request) =>
          recordBootEvent(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
        );
        await prewarmDenseFixture(page, baseUrl);
        await mountDenseFixture(page, baseUrl);

        const grid = page.getByRole("grid", { name: "Dense sheet spreadsheet" });
        try {
          await grid.waitFor();
        } catch (error) {
          // Preserve the original failure; diagnostics must not replace it if the page closed.
          try {
            const dom = await page
              .locator("html")
              .evaluate((element) => element.outerHTML.slice(0, 4_000), undefined, {
                timeout: 1_000,
              })
              .catch((cause: unknown) => `DOM unavailable: ${String(cause).slice(0, 1_000)}`);
            console.error("Spreadsheet canvas boot diagnostics", {
              url: page.url(),
              events: bootEvents,
              dom,
              server: web.logs().slice(-8_000),
            });
          } catch {
            // The original grid wait below remains authoritative even if diagnostics fail.
          }
          throw error;
        }
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
        // Hold Chromium to a 60fps median. Firefox/WebKit run this pathological Retina 1px-cell
        // fixture as a percentile-bounded smoke on variable shared CI hardware; their p75/p92/max
        // bounds below already subsume a median bound without adding a redundant flaky threshold.
        // Representative-hardware production p95 remains a separate 16.7ms acceptance target.
        const isChromium = engineName === "Chromium";
        expect(orderedPaintDuration).toHaveLength(12);
        if (isChromium) expect(orderedPaintDuration[5]).toBeLessThan(16.7);
        expect(orderedPaintDuration[8]).toBeLessThan(isChromium ? 33.4 : 100);
        expect(orderedPaintDuration[10]).toBeLessThan(isChromium ? 50 : 250);
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

    test(`${engineName}: document Enter/paste land after a trailing newline`, async () => {
      const browser = await engine.launch({ headless: true });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({
          viewport: { width: 900, height: 600 },
        });
        const page = await context.newPage();
        await mountDocumentNewlineFixture(page, baseUrl, "hello");
        const editor = page.locator('[role="textbox"][aria-label="Paragraph"]');
        await editor.waitFor();
        await editor.click();
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        const afterEnter = await readMountedDocumentText(page);
        expect(afterEnter).toBe("hello\n");
        const trailingBreak = await editor.evaluate((element) => {
          const br = element.querySelector("br[data-og-trailing-break]");
          return {
            present: Boolean(br),
            textContent: element.textContent,
          };
        });
        expect(trailingBreak.present).toBe(true);
        expect(trailingBreak.textContent).toBe("hello\n");

        // Chromium is load-bearing for the whitespace-pre-wrap trailing-newline
        // caret. Ordinary keyboard.type after End+Enter must land on the new line.
        await page.keyboard.type("x");
        const afterType = await readMountedDocumentText(page);
        expect(afterType).toBe("hello\nx");
        if (engineName === "Chromium") {
          await page.screenshot({
            path: "test-results/artifacts/document-chromium-type-after-enter.png",
            fullPage: true,
          });
        }

        await remountDocumentNewlineFixture(page, baseUrl);
        expect(await readMountedDocumentText(page)).toBe("hello\nx");

        // Exercise ordinary native typing at each boundary without resetting
        // the selection or editing DOM after Enter.
        for (const scenario of [
          { text: "", keys: ["Enter", "Enter"], expected: "\n\nx" },
          {
            text: "hello",
            keys: ["Home", "ArrowRight", "ArrowRight", "Enter"],
            expected: "he\nxllo",
          },
          { text: "hello", keys: ["Home", "Shift+End", "Enter"], expected: "\nx" },
          { text: "hello", keys: ["End", "Enter", "Enter"], expected: "hello\n\nx" },
        ]) {
          const boundaryEditor = await mountDocumentNewlineFixture(page, baseUrl, scenario.text);
          await boundaryEditor.click();
          for (const key of scenario.keys) await page.keyboard.press(key);
          await page.keyboard.type("x");
          expect(await readMountedDocumentText(page)).toBe(scenario.expected);
          await boundaryEditor.press("Tab");
          expect(await readMountedDocumentText(page)).toBe(scenario.expected);
          await remountDocumentNewlineFixture(page, baseUrl);
          expect(await readMountedDocumentText(page)).toBe(scenario.expected);
          expect(await page.locator("br[data-og-trailing-break]").count()).toBe(0);
        }

        const pasteDocument = await mountDocumentNewlineFixture(page, baseUrl, "hello");
        await pasteDocument.click();
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        expect(await readMountedDocumentText(page)).toBe("hello\n");
        const pastePath = await pasteAfterTrailingNewline(page, context, engineName);
        expect(await readMountedDocumentText(page)).toBe("hello\npasted");
        expect(
          await pasteDocument.evaluate((element) => element.querySelector("img, a, script")),
        ).toBeNull();
        if (engineName === "Chromium") {
          await page.screenshot({
            path: `test-results/artifacts/document-chromium-paste-${pastePath}.png`,
            fullPage: true,
          });
        }

        // Playwright cannot drive a real IME candidate window. This only proves
        // the synthetic compositionstart + isComposing Enter path; composing.current
        // and keyCode 229 are covered in unit tests.
        const imeEditor = await mountDocumentNewlineFixture(page, baseUrl, "hello");
        await imeEditor.click();
        await page.keyboard.press("End");
        const composingEnterPrevented = await imeEditor.evaluate((element) => {
          element.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true, data: "二" }),
          );
          const composingEnter = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            isComposing: true,
          });
          element.dispatchEvent(composingEnter);
          return composingEnter.defaultPrevented;
        });
        expect(composingEnterPrevented).toBe(false);
        expect(await readMountedDocumentText(page)).toBe("hello");
      } finally {
        await context?.close();
        await browser.close();
      }
    }, 60_000);

    test(`${engineName}: spreadsheet General display is display-only`, async () => {
      const browser = await engine.launch({ headless: true });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({
          viewport: { width: 1_200, height: 800 },
        });
        const page = await context.newPage();
        await mountGeneralDisplayFixture(page, baseUrl);
        const grid = page.getByRole("grid", { name: "General spreadsheet" });
        await grid.waitFor();
        await page.waitForFunction(
          () => document.querySelector('[data-og-cell="A1"]')?.textContent === "110",
        );
        const labels = await page.evaluate(() => {
          const cell = (address: string) => {
            const node = document.querySelector(`[data-og-cell="${address}"]`);
            return {
              text: node?.textContent ?? "",
              aria: node?.getAttribute("aria-label") ?? "",
            };
          };
          return {
            a1: cell("A1"),
            b1: cell("B1"),
            c1: cell("C1"),
            d1: cell("D1"),
            e1: cell("E1"),
            a2: cell("A2"),
            c2: cell("C2"),
            d2: cell("D2"),
            e2: cell("E2"),
            a3: cell("A3"),
          };
        });
        expect(labels.a1).toEqual({ text: "110", aria: "A1, 110" });
        expect(labels.b1).toEqual({ text: "220", aria: "B1, 220" });
        expect(labels.c1).toEqual({ text: "0.3", aria: "C1, 0.3" });
        expect(labels.d1).toEqual({ text: "1e-20", aria: "D1, 1e-20" });
        expect(labels.e1).toEqual({ text: "1e+21", aria: "E1, 1e+21" });
        expect(labels.a2).toEqual({ text: "-110", aria: "A2, -110" });
        expect(labels.c2).toEqual({ text: "42", aria: "C2, 42" });
        expect(labels.d2).toEqual({ text: "TRUE", aria: "D2, TRUE" });
        expect(labels.e2).toEqual({ text: "#DIV/0!", aria: "E2, #DIV/0!" });
        expect(labels.a3.text).toBe("1.23456789012345");
        const formulaBar = page.getByLabel("Formula or value");
        expect(await formulaBar.inputValue()).toBe("110.00000000000001");
        const stored = await readGeneralDisplayProof(page);
        expect(stored.a1Value).toBe(110.00000000000001);
        expect(stored.c1Formula).toBe("=0.1+0.2");
        expect(stored.c1Value).toBe(0.1 + 0.2);
        const revision = stored.revision;
        await formulaBar.focus();
        await formulaBar.press("Enter");
        const afterNoop = await readGeneralDisplayProof(page);
        expect(afterNoop.revision).toBe(revision);
        expect(afterNoop.a1Value).toBe(110.00000000000001);
        expect(afterNoop.c1Formula).toBe("=0.1+0.2");
        await grid.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(
          () => document.querySelector('[aria-label="Selected range"]')?.textContent === "C1",
        );
        // Selection renders before the effect that refreshes the formula draft.
        // Wait for the editor itself, not just the selected-range indicator.
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')?.value ===
            "=0.1+0.2",
          undefined,
          { timeout: 2_000 },
        );
        expect(await formulaBar.inputValue()).toBe("=0.1+0.2");
        expect(await readGeneralDisplayProof(page)).toEqual(stored);
        if (engineName === "Chromium") {
          await page.screenshot({
            path: "test-results/artifacts/spreadsheet-chromium-general-display.png",
            fullPage: true,
          });
        }
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

async function prewarmDenseFixture(page: Page, baseUrl: string): Promise<void> {
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

async function mountDenseFixture(page: Page, baseUrl: string): Promise<void> {
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

async function openFixtureHost(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/artifact-spreadsheet-test.html`, {
    waitUntil: "domcontentloaded",
  });
}

async function importAndMountDenseFixture(
  page: Page,
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

async function mountDocumentNewlineFixture(
  page: Page,
  baseUrl: string,
  text: string,
): Promise<Locator> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openFixtureHost(page, baseUrl);
    try {
      await page.evaluate(
        async ({ fixtureBaseUrl, initialText }) => {
          const fixtureUrl = new URL("/artifact-document-newline-fixture.tsx", fixtureBaseUrl).href;
          const stylesheet = document.createElement("link");
          stylesheet.rel = "stylesheet";
          stylesheet.href = new URL("/styles.css", fixtureBaseUrl).href;
          await new Promise<void>((resolve, reject) => {
            stylesheet.addEventListener("load", () => resolve(), { once: true });
            stylesheet.addEventListener(
              "error",
              () => reject(new Error("Fixture CSS failed to load")),
              { once: true },
            );
            document.head.replaceChildren(stylesheet);
          });
          const { mountDocumentNewlineEditor } = (await import(/* @vite-ignore */ fixtureUrl)) as {
            mountDocumentNewlineEditor: (target: HTMLElement, options?: { text?: string }) => void;
          };
          document.body.replaceChildren();
          const target = document.createElement("div");
          Object.assign(target.style, { width: "720px", height: "360px" });
          document.body.append(target);
          mountDocumentNewlineEditor(target, { text: initialText });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        { fixtureBaseUrl: baseUrl, initialText: text },
      );
      const editor = page.locator('[role="textbox"][aria-label="Paragraph"]');
      await editor.waitFor();
      return editor;
    } catch (cause) {
      if (attempt === 0 && isColdViteReload(cause)) continue;
      throw cause;
    }
  }
  throw new Error("Document newline fixture failed to mount");
}

async function remountDocumentNewlineFixture(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(async (fixtureBaseUrl) => {
    const fixtureUrl = new URL("/artifact-document-newline-fixture.tsx", fixtureBaseUrl).href;
    const { remountDocumentNewlineEditor } = (await import(/* @vite-ignore */ fixtureUrl)) as {
      remountDocumentNewlineEditor: () => void;
    };
    remountDocumentNewlineEditor();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, baseUrl);
  await page.locator('[role="textbox"][aria-label="Paragraph"]').waitFor();
}

async function readMountedDocumentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = (
      globalThis as typeof globalThis & {
        __ogDocumentNewline?: {
          document: { resolve(id: string): { text?: string } };
          paragraphId: string;
        };
      }
    ).__ogDocumentNewline;
    if (!host) throw new Error("Document newline fixture is not mounted");
    return host.document.resolve(host.paragraphId).text ?? "";
  });
}

async function pasteAfterTrailingNewline(
  page: Page,
  context: BrowserContext,
  engineName: string,
): Promise<"native" | "synthetic"> {
  const payload = "pasted";
  const editor = page.locator('[role="textbox"][aria-label="Paragraph"]');
  if (engineName === "Chromium") {
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, payload);
      await page.keyboard.press("Control+v");
      if ((await readMountedDocumentText(page)) === "hello\npasted") return "native";
    } catch {
      // Playwright clipboard grants are Chromium-only and may still fail in
      // headless Linux; fall through to the same paste Event the unit tests use.
    }
  }
  await editor.evaluate((element, text) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData(format: string) {
          if (format === "text/plain") return text;
          if (format === "text/html") return `<b>${text}</b><img src="x"><script>1</script>`;
          return "";
        },
      },
    });
    element.dispatchEvent(event);
  }, payload);
  return "synthetic";
}

async function mountGeneralDisplayFixture(page: Page, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openFixtureHost(page, baseUrl);
    try {
      await page.evaluate(async (fixtureBaseUrl) => {
        const fixtureUrl = new URL("/artifact-spreadsheet-scroll-fixture.tsx", fixtureBaseUrl).href;
        const stylesheet = document.createElement("link");
        stylesheet.rel = "stylesheet";
        stylesheet.href = new URL("/styles.css", fixtureBaseUrl).href;
        await new Promise<void>((resolve, reject) => {
          stylesheet.addEventListener("load", () => resolve(), { once: true });
          stylesheet.addEventListener(
            "error",
            () => reject(new Error("Fixture CSS failed to load")),
            { once: true },
          );
          document.head.replaceChildren(stylesheet);
        });
        const { mountGeneralDisplaySpreadsheet } = (await import(
          /* @vite-ignore */ fixtureUrl
        )) as {
          mountGeneralDisplaySpreadsheet: (target: HTMLElement) => void;
        };
        document.body.replaceChildren();
        const target = document.createElement("div");
        Object.assign(target.style, { width: "900px", height: "516px" });
        document.body.append(target);
        mountGeneralDisplaySpreadsheet(target);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      }, baseUrl);
      return;
    } catch (cause) {
      if (attempt === 0 && isColdViteReload(cause)) continue;
      throw cause;
    }
  }
}

async function readGeneralDisplayProof(page: Page): Promise<{
  revision: unknown;
  a1Value: unknown;
  c1Formula: unknown;
  c1Value: unknown;
}> {
  return page.evaluate(() => {
    const host = (
      globalThis as typeof globalThis & {
        __ogGeneralDisplay?: {
          workbook: { revision: unknown };
          worksheet: {
            getRange(address: string): { values: unknown[][]; formulas: unknown[][] };
          };
        };
      }
    ).__ogGeneralDisplay;
    if (!host) throw new Error("General display fixture is not mounted");
    return {
      revision: host.workbook.revision,
      a1Value: host.worksheet.getRange("A1").values[0]?.[0],
      c1Formula: host.worksheet.getRange("C1").formulas[0]?.[0],
      c1Value: host.worksheet.getRange("C1").values[0]?.[0],
    };
  });
}
