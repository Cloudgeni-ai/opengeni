import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chromium,
  type Browser,
  type Locator,
  type Page,
  type PageScreenshotOptions,
} from "playwright";
import {
  assertScreenshotPainted,
  freePort,
  runCommand,
  startProcess,
  type StartedProcess,
} from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const dockStates = [
  "warm-live",
  "cold-instant",
  "waking",
  "selfhosted-offline",
  "empty",
  "dense",
  "guard",
  "content-stress",
  "error",
  "permission-gated",
  "connecting",
] as const;

describe("workbench browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    try {
      // Browser acceptance must exercise a complete, immutable production
      // bundle. Vite's dev dependency optimizer can invalidate its module graph
      // during the first navigation, which makes browser/network failures
      // indistinguishable from product failures.
      const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
        cwd: `${repoRoot}/packages/react`,
        timeoutMs: 45_000,
      });
      if (build.exitCode !== 0) {
        throw new Error(`Workbench demo build failed:\n${build.stdout}\n${build.stderr}`);
      }
      browser = await chromium.launch();
      demo = await startProcess(
        [
          "bun",
          "run",
          "vite",
          "preview",
          "demo",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
        ],
        {
          cwd: `${repoRoot}/packages/react`,
          ready: async () =>
            (
              await fetch(`${baseUrl}/workbench-dock.html`, {
                signal: AbortSignal.timeout(2_000),
              }).catch(() => null)
            )?.ok === true,
          timeoutMs: 45_000,
        },
      );
    } catch (error) {
      await demo?.stop().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 60_000);

  test("all states stay bounded and meet touch-target budgets in both themes", async () => {
    const failures: unknown[] = [];
    for (const viewport of [
      { width: 320, height: 720 },
      { width: 768, height: 1024 },
    ]) {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      for (const theme of ["dark", "light"] as const) {
        for (const state of dockStates) {
          const problems: string[] = [];
          page.removeAllListeners();
          page.on("console", (message) => {
            if (message.type() === "warning" || message.type() === "error") {
              problems.push(`console:${message.text()}`);
            }
          });
          page.on("pageerror", (error) => problems.push(`page:${String(error)}`));
          page.on("requestfailed", (request) => problems.push(`request:${request.url()}`));

          const response = await page.goto(dockUrl(baseUrl, state, theme), {
            waitUntil: "networkidle",
          });
          await waitForWorkbenchVisualReady(page);
          const audit = await page.evaluate(() => {
            const visible = (element: Element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0
              );
            };
            const undersized = Array.from(
              document.querySelectorAll(
                'button:not([disabled]),select:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),a[href],[role=button],[role=tab]',
              ),
            )
              .filter(visible)
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  label:
                    element.getAttribute("aria-label") ??
                    element.textContent?.trim().slice(0, 60) ??
                    "",
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                };
              })
              .filter((target) => target.width < 44 || target.height < 44);
            const tablist = document.querySelector('[role="tablist"]');
            const tablistRect = tablist?.getBoundingClientRect();
            const clippedSelectedTabs = tablistRect
              ? Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'))
                  .filter((tab) => visible(tab) && tab.getAttribute("aria-selected") === "true")
                  .map((tab) => ({
                    label: tab.textContent?.trim() ?? "",
                    rect: tab.getBoundingClientRect(),
                  }))
                  .filter(
                    ({ rect }) =>
                      rect.left < tablistRect.left - 1 || rect.right > tablistRect.right + 1,
                  )
                  .map(({ label }) => label)
              : [];
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              undersized,
              clippedSelectedTabs,
            };
          });
          if (
            response?.status() !== 200 ||
            problems.length > 0 ||
            audit.overflow ||
            audit.undersized.length ||
            audit.clippedSelectedTabs.length
          ) {
            failures.push({
              viewport: viewport.width,
              theme,
              state,
              status: response?.status(),
              problems,
              audit,
            });
          }

          if (viewport.width === 320 && theme === "dark" && state === "dense") {
            await capturePageScreenshot(page, {
              path: "/tmp/workbench-mobile-dark-dense.png",
              fullPage: true,
            });
          }
          if (viewport.width === 768 && theme === "light" && state === "selfhosted-offline") {
            await capturePageScreenshot(page, {
              path: "/tmp/workbench-tablet-light-offline.png",
              fullPage: true,
            });
          }
        }
      }
      await context.close();
    }
    expect(failures).toEqual([]);
  }, 90_000);

  test("every desktop/mobile state and theme passes WCAG 2.2 AA", async () => {
    type AccessibilityCase = readonly [
      name: string,
      width: number,
      height: number,
      mobile: boolean,
      state: (typeof dockStates)[number],
      theme: "dark" | "light",
      tab?: string,
    ];
    const cases: AccessibilityCase[] = [];
    for (const [surface, width, height, mobile] of [
      ["mobile", 320, 720, true],
      ["desktop", 1280, 800, false],
    ] as const) {
      for (const theme of ["dark", "light"] as const) {
        for (const state of dockStates) {
          cases.push([`${surface}-${theme}-${state}`, width, height, mobile, state, theme]);
        }
      }
    }
    // Default-tab coverage alone would miss the complete Files surface in a
    // capture-backed session. Keep explicit mobile and desktop file-browser
    // cells in the same fail-closed matrix.
    cases.push(
      ["mobile-light-files", 390, 844, true, "selfhosted-offline", "light", "files"],
      ["desktop-light-files", 1440, 960, false, "cold-instant", "light", "files"],
    );
    const failures: unknown[] = [];

    for (const [name, width, height, mobile, state, theme, tab] of cases) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      await page.goto(dockUrl(baseUrl, state, theme, tab), { waitUntil: "networkidle" });
      await waitForWorkbenchVisualReady(page);
      const report = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const manual = await manualAccessibilityAudit(page);
      const unexpectedIncomplete = report.incomplete.flatMap((rule) =>
        rule.nodes
          .filter((node) => {
            const target = JSON.stringify(node.target);
            if (rule.id === "aria-valid-attr-value") return false;
            if (rule.id === "color-contrast") {
              return (
                !target.includes("diffs-container") &&
                !target.includes("data-line-number-content") &&
                !target.includes("data-contrast-audited") &&
                !node.html.includes("data-contrast-audited")
              );
            }
            return true;
          })
          .map((node) => ({ id: rule.id, target: node.target })),
      );

      if (
        report.violations.length > 0 ||
        unexpectedIncomplete.length > 0 ||
        manual.missingAriaControls.length > 0 ||
        (manual.minimumContrast !== null && manual.minimumContrast < 4.5)
      ) {
        failures.push({
          name,
          violations: report.violations.map((rule) => ({
            id: rule.id,
            nodes: rule.nodes.map((node) => ({
              target: node.target,
              summary: node.failureSummary,
            })),
          })),
          unexpectedIncomplete,
          manual,
        });
      }

      if (name === "desktop-dark-warm-live") {
        await capturePageScreenshot(page, {
          path: "/tmp/workbench-desktop-dark-changes.png",
          fullPage: true,
        });
      }
      if (name === "desktop-light-files") {
        await capturePageScreenshot(page, {
          path: "/tmp/workbench-desktop-light-files.png",
          fullPage: true,
        });
      }
      if (name === "desktop-light-content-stress") {
        await capturePageScreenshot(page, {
          path: "/tmp/workbench-desktop-light-content-stress.png",
          fullPage: true,
        });
      }
      await context.close();
    }
    expect(failures).toEqual([]);
  }, 180_000);

  test("forced colors keeps selection and diff meaning while reduced motion stops animation", async () => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 720 },
      isMobile: true,
      hasTouch: true,
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await page.goto(dockUrl(baseUrl, "warm-live", "dark", "changes"), {
        waitUntil: "networkidle",
      });
      const selectedTab = page.getByRole("tab", { name: /Changes/ });
      const plainDiff = page.locator('[data-opengeni-plain-diff="forced-colors"]');
      await plainDiff.waitFor();
      expect(await selectedTab.evaluate((tab) => getComputedStyle(tab).outlineStyle)).toBe("solid");
      expect(await selectedTab.evaluate((tab) => getComputedStyle(tab).outlineWidth)).toBe("2px");
      expect(await plainDiff.locator("pre").textContent()).toContain("+  app.use(helmet());");
      expect(
        await page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" && animation.effect?.getTiming().duration !== 0,
              ).length,
        ),
      ).toBe(0);
      const report = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(report.violations).toEqual([]);
      await capturePageScreenshot(page, {
        path: "/tmp/workbench-mobile-forced-colors-reduced-motion.png",
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 30_000);

  test("the complete viewport matrix preserves reflow, chrome separation, and the active surface", async () => {
    const viewports = [
      [320, 720],
      [375, 812],
      [390, 844],
      [430, 932],
      [640, 800],
      [768, 1024],
      [1024, 768],
      [1280, 800],
      [1440, 960],
      [1920, 1080],
      [2560, 1080],
    ] as const;
    const failures: unknown[] = [];

    for (const [width, height] of viewports) {
      const narrow = width < 1024;
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: narrow,
        hasTouch: narrow,
      });
      try {
        const page = await context.newPage();
        await page.goto(
          dockUrl(baseUrl, "warm-live", width % 2 === 0 ? "dark" : "light", "changes"),
          { waitUntil: "networkidle" },
        );
        await waitForWorkbenchVisualReady(page);
        const audit = await page.evaluate(() => {
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const selectedTab = document.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"]',
          );
          const tablist = selectedTab?.closest<HTMLElement>('[role="tablist"]');
          const activePanel = document.querySelector<HTMLElement>(
            '[role="tabpanel"]:not([hidden])',
          );
          const dialog = document.querySelector<HTMLElement>(
            '[role="dialog"][aria-label="Workspace"]',
          );
          const workspace =
            dialog ?? document.querySelector<HTMLElement>("[data-workspace-surface]");
          const selectedRect = selectedTab?.getBoundingClientRect();
          const tablistRect = tablist?.getBoundingClientRect();
          const workspaceRect = workspace?.getBoundingClientRect();
          const chrome = workspace?.firstElementChild?.getBoundingClientRect();
          return {
            pageOverflow: document.documentElement.scrollWidth - viewport.width,
            selectedTabClipped:
              !selectedRect ||
              !tablistRect ||
              selectedRect.left < tablistRect.left - 1 ||
              selectedRect.right > tablistRect.right + 1,
            activePanelVisible:
              Boolean(activePanel) &&
              !activePanel?.hidden &&
              (activePanel?.getBoundingClientRect().width ?? 0) > 0 &&
              (activePanel?.getBoundingClientRect().height ?? 0) > 0,
            workspaceOutOfBounds:
              !workspaceRect ||
              workspaceRect.left < -1 ||
              workspaceRect.top < -1 ||
              workspaceRect.right > viewport.width + 1 ||
              workspaceRect.bottom > viewport.height + 1,
            chromeHeight: chrome?.height ?? null,
          };
        });
        if (
          audit.pageOverflow > 1 ||
          audit.selectedTabClipped ||
          !audit.activePanelVisible ||
          audit.workspaceOutOfBounds
        ) {
          failures.push({ width, height, audit });
        }
        if (width >= 640 && width < 1024) {
          expect(audit.chromeHeight).not.toBeNull();
          expect(audit.chromeHeight ?? Infinity).toBeLessThanOrEqual(52);
        }
        if (width === 375 || width === 2560) {
          await capturePageScreenshot(page, {
            path: `/tmp/workbench-viewport-${width}.png`,
            fullPage: true,
          });
        }
      } finally {
        await context.close();
      }
    }

    expect(failures).toEqual([]);
  }, 60_000);

  test("320px reflow and WCAG text spacing retain every control and keyboard route", async () => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 720 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.goto(dockUrl(baseUrl, "warm-live", "light", "changes"), {
        waitUntil: "networkidle",
      });
      await waitForWorkbenchVisualReady(page);
      await page.addStyleTag({
        content: `
          .og-root *:not(svg):not(path) {
            letter-spacing: 0.12em !important;
            line-height: 1.5 !important;
            word-spacing: 0.16em !important;
          }
          .og-root p { margin-bottom: 2em !important; }
        `,
      });

      const tabs = page.getByRole("tab");
      await tabs.first().focus();
      await page.keyboard.press("End");
      expect(await tabs.last().getAttribute("aria-selected")).toBe("true");
      const audit = await page.evaluate(() => {
        const selected = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        const tablist = selected?.closest<HTMLElement>('[role="tablist"]');
        const selectedRect = selected?.getBoundingClientRect();
        const tablistRect = tablist?.getBoundingClientRect();
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"] > div:first-child button, [role="dialog"] > div:first-child [role="tab"]',
          ),
        ).filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const relevantTab =
            element.getAttribute("role") !== "tab" ||
            element.getAttribute("aria-selected") === "true";
          return (
            relevantTab &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0
          );
        });
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          selectedTabClipped:
            !selectedRect ||
            !tablistRect ||
            selectedRect.left < tablistRect.left - 1 ||
            selectedRect.right > tablistRect.right + 1,
          controlsOutOfViewport: controls
            .filter((control) => {
              const rect = control.getBoundingClientRect();
              return rect.left < -1 || rect.right > window.innerWidth + 1;
            })
            .map((control) => control.getAttribute("aria-label") ?? control.textContent?.trim()),
        };
      });
      expect(audit).toEqual({
        pageOverflow: 0,
        selectedTabClipped: false,
        controlsOutOfViewport: [],
      });
      await page.keyboard.press("Home");
      expect(await tabs.first().getAttribute("aria-selected")).toBe("true");
      await waitForWorkbenchVisualReady(page);
      const report = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(report.violations).toEqual([]);
      await capturePageScreenshot(page, {
        path: "/tmp/workbench-mobile-text-spacing.png",
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 30_000);

  test("Unicode paths and long host tabs remain bounded and keyboard-scroll into view", async () => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 720 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.goto(dockUrl(baseUrl, "content-stress", "light", "changes"), {
        waitUntil: "networkidle",
      });
      await waitForWorkbenchVisualReady(page);
      const tablist = page.getByRole("tablist");
      expect(await tablist.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      expect(await tablist.evaluate((element) => getComputedStyle(element).maskImage)).not.toBe(
        "none",
      );

      const changes = page.getByRole("tab", { name: /Changes/ });
      await changes.focus();
      await page.keyboard.press("End");
      const trailing = page.getByRole("tab", {
        name: "Regression diagnostics and verification evidence",
      });
      expect(await trailing.getAttribute("aria-selected")).toBe("true");
      expect(await tabIsFullyVisible(trailing)).toBe(true);
      expect(await tablist.evaluate((element) => getComputedStyle(element).maskImage)).not.toBe(
        "none",
      );

      await page.keyboard.press("Home");
      const leading = page.getByRole("tab", { name: "Deployments and observability" });
      expect(await leading.getAttribute("aria-selected")).toBe("true");
      expect(await tabIsFullyVisible(leading)).toBe(true);

      await changes.click();
      await waitForWorkbenchVisualReady(page);
      const picker = page.locator("[data-compact-file-picker]");
      const pickerLabels = await picker.locator("option").allTextContents();
      expect(pickerLabels[0]).toStartWith(
        "M · internationalisation-accessibility-observability-and-deployment-coordination-",
      );
      expect(pickerLabels.some((label) => label.includes("naïve café/日本語/مرحبا"))).toBe(true);
      const unicodeFonts = await page.evaluate(async () => {
        await document.fonts.ready;
        const [japanese, arabic] = await Promise.all([
          document.fonts.load('12px "Noto Sans JP Variable"', "日本語"),
          document.fonts.load('12px "Noto Sans Arabic Variable"', "مرحبا"),
        ]);
        return { japanese: japanese.length, arabic: arabic.length };
      });
      expect(unicodeFonts.japanese).toBeGreaterThan(0);
      expect(unicodeFonts.arabic).toBeGreaterThan(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await capturePageScreenshot(page, {
        path: "/tmp/workbench-mobile-content-stress.png",
        fullPage: true,
      });

      await page.getByRole("button", { name: "Machine: Live" }).click();
      await page
        .getByText("Production observability and deployment coordination machine — Stockholm 01", {
          exact: true,
        })
        .waitFor();
      const popoverContent = page.locator('[data-machine-state-popover][data-state="open"]');
      await popoverContent.waitFor({ state: "visible" });
      const popoverBounds = await popoverContent.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          viewportWidth: window.innerWidth,
        };
      });
      if (popoverBounds.left < 8 || popoverBounds.right > popoverBounds.viewportWidth - 8) {
        throw new Error(
          `Machine popover escaped its 8px viewport inset: ${JSON.stringify(popoverBounds)}`,
        );
      }
      expect(
        await popoverContent.evaluate((element) => {
          const source = document.querySelector<HTMLElement>('[data-og-theme="light"]');
          const sourceStyle = source ? getComputedStyle(source) : null;
          const portalStyle = getComputedStyle(element);
          const sourceBackground = sourceStyle?.getPropertyValue("--og-color-bg") ?? "";
          const sourceForeground = sourceStyle?.getPropertyValue("--og-color-fg") ?? "";
          return {
            colorScheme: portalStyle.colorScheme,
            hasTokens: sourceBackground.length > 0 && sourceForeground.length > 0,
            tokensMatch:
              portalStyle.getPropertyValue("--og-color-bg") === sourceBackground &&
              portalStyle.getPropertyValue("--og-color-fg") === sourceForeground,
          };
        }),
      ).toEqual({ colorScheme: "light", hasTokens: true, tokensMatch: true });
      await waitForVisualStability(page);
      await capturePageScreenshot(page, {
        path: "/tmp/workbench-mobile-content-stress-machine.png",
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a controlled initial tab scrolls fully into view on mobile and desktop", async () => {
    for (const viewport of [
      { width: 390, height: 844, mobile: true },
      { width: 1280, height: 800, mobile: false },
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
      });
      try {
        const page = await context.newPage();
        await page.goto(dockUrl(baseUrl, "content-stress", "light", "regression-diagnostics"), {
          waitUntil: "networkidle",
        });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        });
        const selected = page.getByRole("tab", {
          name: "Regression diagnostics and verification evidence",
        });
        expect(await selected.getAttribute("aria-selected")).toBe("true");
        expect(await tabIsFullyVisible(selected)).toBe(true);
      } finally {
        await context.close();
      }
    }
  });

  test("dynamic workspace states expose live semantics without color-only git status", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();

      await page.goto(dockUrl(baseUrl, "connecting", "dark", "changes"), {
        waitUntil: "networkidle",
      });
      const reconnecting = page.getByRole("status");
      await reconnecting.getByText("Waking workspace", { exact: true }).waitFor();
      expect(await reconnecting.getAttribute("aria-live")).toBe("polite");

      await page.goto(dockUrl(baseUrl, "error", "dark", "changes"), {
        waitUntil: "networkidle",
      });
      const failure = page.getByRole("alert");
      await failure.getByText("Sandbox unavailable", { exact: true }).waitFor();
      expect(await failure.getAttribute("aria-live")).toBe("assertive");

      await page.goto(dockUrl(baseUrl, "connecting", "dark", "files"), {
        waitUntil: "networkidle",
      });
      const waking = page.getByRole("status");
      await waking.getByText("Waking workspace", { exact: true }).waitFor();

      await page.goto(dockUrl(baseUrl, "empty", "dark", "files"), {
        waitUntil: "networkidle",
      });
      await page.getByText("Working tree clean", { exact: true }).waitFor();

      await page.goto(dockUrl(baseUrl, "warm-live", "dark", "changes"), {
        waitUntil: "networkidle",
      });
      await page.getByRole("status").filter({ hasText: "3 files changed" }).waitFor();
    } finally {
      await context.close();
    }
  }, 30_000);

  test("tab semantics work from the keyboard in the narrow overlay", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(dockUrl(baseUrl, "warm-live", "dark", "changes"), {
      waitUntil: "networkidle",
    });
    const tabs = page.getByRole("tab");
    expect(await tabs.nth(0).evaluate((tab) => tab === document.activeElement)).toBe(true);
    await tabs.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    expect(await tabs.nth(1).getAttribute("aria-selected")).toBe("true");
    expect(await tabs.nth(1).getAttribute("tabindex")).toBe("0");
    const panelId = await tabs.nth(1).getAttribute("aria-controls");
    expect(panelId).not.toBeNull();
    expect(await page.locator(`[id="${panelId}"]`).getAttribute("aria-labelledby")).toBe(
      await tabs.nth(1).getAttribute("id"),
    );

    await page.keyboard.press("End");
    expect(await tabs.nth(3).getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("ArrowRight");
    expect(await tabs.nth(0).getAttribute("aria-selected")).toBe("true");

    const dialog = page.locator('[role="dialog"][aria-label="Workspace"]');
    const primary = page.locator("[data-workspace-primary]");
    expect(await primary.getAttribute("inert")).not.toBeNull();
    expect(await primary.getAttribute("aria-hidden")).toBe("true");
    const dialogHandle = await dialog.elementHandle();
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expectEventually(async () => page.locator('[title="Open workspace"]:focus').count());
    expect(await dialog.getAttribute("hidden")).not.toBeNull();
    expect(await primary.getAttribute("inert")).toBeNull();
    expect(await primary.getAttribute("aria-hidden")).toBeNull();
    expect(await dialogHandle?.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByTitle("Open workspace").click();
    expect(await dialog.getAttribute("hidden")).toBeNull();
    expect(await primary.getAttribute("inert")).not.toBeNull();
    expect(await primary.getAttribute("aria-hidden")).toBe("true");
    expect(await dialogHandle?.evaluate((element) => element.isConnected)).toBe(true);
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press(index % 5 === 0 ? "Shift+Tab" : "Tab");
      await nextAnimationFrame(page);
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
    await context.close();
  });

  test("desktop maximize and collapse preserve one viewport-correct mounted surface", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await page.goto(dockUrl(baseUrl, "warm-live", "dark", "changes"), {
      waitUntil: "networkidle",
    });
    await waitForWorkbenchVisualReady(page);
    const surface = page.locator("[data-workspace-surface]");
    const surfaceHandle = await surface.elementHandle();

    await page.getByTitle("Maximize").click();
    const rect = await surface.boundingBox();
    expect(rect).not.toBeNull();
    expect(Math.round(rect?.x ?? -1)).toBe(0);
    expect(Math.round(rect?.y ?? -1)).toBe(0);
    expect(Math.round(rect?.width ?? -1)).toBe(1440);
    expect(Math.round(rect?.height ?? -1)).toBe(960);
    expect(await surfaceHandle?.evaluate((element) => element.isConnected)).toBe(true);
    expect(await surface.getAttribute("role")).toBe("dialog");
    expect(await surface.getAttribute("aria-modal")).toBe("true");
    const primary = page.locator("[data-workspace-primary]");
    expect(await primary.getAttribute("inert")).not.toBeNull();
    expect(await primary.getAttribute("aria-hidden")).toBe("true");
    for (let index = 0; index < 32; index += 1) {
      await page.keyboard.press(index % 7 === 0 ? "Shift+Tab" : "Tab");
      await nextAnimationFrame(page);
      expect(await surface.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }

    await page.getByTitle("Restore (Esc)").click();
    expect(await surface.getAttribute("role")).toBeNull();
    expect(await primary.getAttribute("inert")).toBeNull();
    expect(await primary.getAttribute("aria-hidden")).toBeNull();
    await page.getByTitle("Collapse").click();
    await expectEventually(async () => page.locator('[title="Open workspace"]:focus').count());
    expect(await surface.getAttribute("aria-hidden")).toBe("true");
    expect(await surfaceHandle?.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByTitle("Open workspace").click();
    expect(await surface.getAttribute("aria-hidden")).toBeNull();
    expect(await surfaceHandle?.evaluate((element) => element.isConnected)).toBe(true);
    await context.close();
  });

  test("a guarded diff opens the requested path in Files on mobile", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(dockUrl(baseUrl, "guard", "dark", "changes"), {
      waitUntil: "networkidle",
    });
    await page.locator("[data-compact-file-picker]").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Open in Files" }).click();

    expect(await page.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await expectEventually(async () =>
      page
        .locator('[role="tabpanel"]:not([hidden])')
        .getByText("assets/logo.png", { exact: true })
        .count(),
    );
    await context.close();
  });

  test("file deletion uses an accessible non-blocking dialog on mobile", async () => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 720 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.goto(dockUrl(baseUrl, "warm-live", "light", "files"), {
        waitUntil: "networkidle",
      });
      const file = page.getByRole("treeitem").filter({ hasText: "README.md" }).first();
      await file.getByRole("button").click();
      const deleteButton = page
        .getByRole("toolbar", { name: "File actions" })
        .getByRole("button", { name: "Delete", exact: true });
      const deleteButtonHandle = await deleteButton.elementHandle();
      await deleteButton.click();

      const dialog = page.getByRole("alertdialog", { name: "Delete file?" });
      await dialog.waitFor();
      await dialog.getByText("README.md", { exact: false }).waitFor();
      expect(await page.getByRole("dialog", { name: "Workspace" }).count()).toBe(0);
      expect(
        await dialog.evaluate((element) => {
          const source = document.querySelector<HTMLElement>('[data-og-theme="light"]');
          const sourceStyle = source ? getComputedStyle(source) : null;
          const dialogStyle = getComputedStyle(element);
          return {
            colorScheme: dialogStyle.colorScheme,
            tokensMatch:
              dialogStyle.getPropertyValue("--og-color-bg") ===
                sourceStyle?.getPropertyValue("--og-color-bg") &&
              dialogStyle.getPropertyValue("--og-color-fg") ===
                sourceStyle?.getPropertyValue("--og-color-fg"),
          };
        }),
      ).toEqual({ colorScheme: "light", tokensMatch: true });
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      const confirm = dialog.getByRole("button", { name: "Delete permanently" });
      expect(await cancel.evaluate((button) => button === document.activeElement)).toBe(true);
      const targets = await dialog.getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      expect(targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await confirm.evaluate((button) => button === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await cancel.evaluate((button) => button === document.activeElement)).toBe(true);
      const report = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(report.violations).toEqual([]);
      await waitForVisualStability(page);
      await capturePageScreenshot(page, {
        path: "/tmp/workbench-mobile-delete-dialog.png",
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      expect(await dialog.count()).toBe(0);
      await expectEventually(async () => page.getByRole("dialog", { name: "Workspace" }).count());
      await page.waitForFunction(
        (button) => button?.isConnected === true && button === document.activeElement,
        deleteButtonHandle,
        { timeout: 1_000 },
      );
      expect(
        await deleteButtonHandle?.evaluate((button) => ({
          connected: button.isConnected,
          focused: button === document.activeElement,
          activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
          activeRole: document.activeElement?.getAttribute("role") ?? null,
          activeTag: document.activeElement?.tagName ?? null,
        })),
      ).toEqual({
        connected: true,
        focused: true,
        activeLabel: "Delete",
        activeRole: null,
        activeTag: "BUTTON",
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 30_000);
});

async function expectEventually(check: () => Promise<number>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await check()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await check()).toBeGreaterThan(0);
}

async function nextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function tabIsFullyVisible(tab: Locator): Promise<boolean> {
  return tab.evaluate((element) => {
    const tablist = element.closest<HTMLElement>('[role="tablist"]');
    const rect = element.getBoundingClientRect();
    const listRect = tablist?.getBoundingClientRect();
    return Boolean(listRect && rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1);
  });
}

async function waitForWorkbenchVisualReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const surface = document.querySelector<HTMLElement>("[data-workspace-surface]");
      const activePanel = surface?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
      const surfaceRect = surface?.getBoundingClientRect();
      const panelRect = activePanel?.getBoundingClientRect();
      if (
        !surface ||
        surface.hidden ||
        !activePanel ||
        !surfaceRect ||
        !panelRect ||
        surfaceRect.width <= 0 ||
        surfaceRect.height <= 0 ||
        panelRect.width <= 0 ||
        panelRect.height <= 0
      ) {
        return false;
      }
      return Array.from(activePanel.querySelectorAll<HTMLElement>("[data-pierre-section]")).every(
        (section) => {
          const container = section.querySelector("diffs-container");
          return Boolean(
            container?.shadowRoot &&
            container.shadowRoot.childElementCount > 0 &&
            container.getBoundingClientRect().height > 40,
          );
        },
      );
    },
    undefined,
    { timeout: 5_000 },
  );
}

async function capturePageScreenshot(page: Page, options: PageScreenshotOptions): Promise<void> {
  const png = await page.screenshot(options);
  await assertScreenshotPainted(page, png, String(options.path ?? "workbench"));
}

async function waitForVisualStability(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  // Chromium can acknowledge the two DOM frames before its out-of-process
  // compositor has promoted a newly portalled layer. A short bounded settle
  // keeps screenshot evidence off that transient all-black surface.
  await page.waitForTimeout(500);
}

function dockUrl(
  baseUrl: string,
  state: (typeof dockStates)[number],
  theme: "dark" | "light",
  tab?: string,
): string {
  const params = new URLSearchParams({ state, theme });
  if (tab) params.set("tab", tab);
  return `${baseUrl}/workbench-dock.html?${params}`;
}

async function manualAccessibilityAudit(page: Page): Promise<{
  missingAriaControls: string[];
  minimumContrast: number | null;
}> {
  return page.evaluate(() => {
    const missingAriaControls = Array.from(
      document.querySelectorAll<HTMLElement>("[aria-controls]"),
    )
      .map((element) => element.getAttribute("aria-controls"))
      .filter((id): id is string => Boolean(id && !document.getElementById(id)));

    type Rgba = [red: number, green: number, blue: number, alpha: number];
    const toRgba = (color: string): Rgba => {
      const probe = document.createElement("span");
      probe.style.color = `rgb(from ${color} r g b / alpha)`;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      const values = resolved.match(/[\d.]+/g)?.map(Number) ?? [];
      const channels = resolved.startsWith("rgb")
        ? values.slice(0, 3).map((value) => value / 255)
        : values.slice(0, 3);
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, values[3] ?? 1];
    };
    const luminance = (color: readonly number[]) => {
      const channels = color
        .slice(0, 3)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const blend = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) /
          alpha,
        alpha,
      ];
    };
    const backgroundBehind = (element: Element): Rgba => {
      const layers: Rgba[] = [];
      let current: Element | null = element;
      while (current) {
        layers.push(toRgba(getComputedStyle(current).backgroundColor));
        const root = current.getRootNode();
        current =
          current.parentElement ?? (root instanceof ShadowRoot ? (root.host as Element) : null);
      }
      const darkCanvas = getComputedStyle(document.documentElement).colorScheme.includes("dark");
      let composite: Rgba = darkCanvas ? [0, 0, 0, 1] : [1, 1, 1, 1];
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        composite = blend(layers[index]!, composite);
      }
      return composite;
    };
    const contrast = (element: Element) => {
      const background = backgroundBehind(element);
      const foreground = blend(toRgba(getComputedStyle(element).color), background);
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };

    const ratios: number[] = [];
    for (const host of document.querySelectorAll("diffs-container")) {
      for (const textLeaf of host.shadowRoot?.querySelectorAll("*") ?? []) {
        const hasDirectText = Array.from(textLeaf.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
        );
        const style = getComputedStyle(textLeaf);
        const rect = textLeaf.getBoundingClientRect();
        if (
          hasDirectText &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          ratios.push(contrast(textLeaf));
        }
      }
    }
    for (const audited of document.querySelectorAll("[data-contrast-audited]")) {
      ratios.push(contrast(audited));
    }
    return {
      missingAriaControls,
      minimumContrast: ratios.length > 0 ? Math.min(...ratios) : null,
    };
  });
}
