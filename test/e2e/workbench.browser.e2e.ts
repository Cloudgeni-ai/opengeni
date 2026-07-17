import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const dockStates = [
  "warm-live",
  "cold-instant",
  "waking",
  "selfhosted-offline",
  "empty",
  "dense",
  "guard",
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
      browser = await chromium.launch();
      demo = await startProcess(
        [
          "bun",
          "run",
          "vite",
          "dev",
          "demo",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
          "--force",
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
              document.querySelectorAll("button,select,input,[role=button],[role=tab]"),
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
            const clippedTabs = tablistRect
              ? Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'))
                  .filter(visible)
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
              clippedTabs,
            };
          });
          if (
            response?.status() !== 200 ||
            problems.length > 0 ||
            audit.overflow ||
            audit.undersized.length ||
            audit.clippedTabs.length
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
            await page.screenshot({ path: "/tmp/workbench-mobile-dark-dense.png", fullPage: true });
          }
          if (viewport.width === 768 && theme === "light" && state === "selfhosted-offline") {
            await page.screenshot({
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

  test("representative desktop and mobile states pass WCAG 2.2 AA", async () => {
    const cases = [
      ["mobile-dark-changes", 390, 844, true, "warm-live", "dark", "changes"],
      ["mobile-light-files", 390, 844, true, "selfhosted-offline", "light", "files"],
      ["mobile-dark-dense", 320, 720, true, "dense", "dark", "changes"],
      ["mobile-light-error", 320, 720, true, "error", "light", "files"],
      ["desktop-dark-changes", 1440, 960, false, "warm-live", "dark", "changes"],
      ["desktop-light-files", 1440, 960, false, "cold-instant", "light", "files"],
      ["desktop-dark-dense", 1280, 800, false, "dense", "dark", "changes"],
      ["desktop-light-error", 1280, 800, false, "error", "light", "files"],
    ] as const;
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
                !target.includes("data-line-number-content") &&
                !target.includes("data-contrast-audited")
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
          violations: report.violations.map((rule) => ({ id: rule.id, nodes: rule.nodes.length })),
          unexpectedIncomplete,
          manual,
        });
      }

      if (name === "desktop-dark-changes") {
        await page.screenshot({ path: "/tmp/workbench-desktop-dark-changes.png", fullPage: true });
      }
      if (name === "desktop-light-files") {
        await page.screenshot({ path: "/tmp/workbench-desktop-light-files.png", fullPage: true });
      }
      await context.close();
    }
    expect(failures).toEqual([]);
  }, 60_000);

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
    const dialogHandle = await dialog.elementHandle();
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expectEventually(async () => page.locator('[title="Open workspace"]:focus').count());
    expect(await dialog.getAttribute("hidden")).not.toBeNull();
    expect(await dialogHandle?.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByTitle("Open workspace").click();
    expect(await dialog.getAttribute("hidden")).toBeNull();
    expect(await dialogHandle?.evaluate((element) => element.isConnected)).toBe(true);
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

    await page.getByTitle("Restore (Esc)").click();
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
});

async function expectEventually(check: () => Promise<number>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await check()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await check()).toBeGreaterThan(0);
}

async function waitForWorkbenchVisualReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-pierre-section]")).every(
        (section) => {
          const container = section.querySelector("diffs-container");
          return Boolean(
            container?.shadowRoot &&
            container.shadowRoot.childElementCount > 0 &&
            container.getBoundingClientRect().height > 40,
          );
        },
      ),
    undefined,
    { timeout: 5_000 },
  );
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

    const toSrgb = (color: string): number[] => {
      const probe = document.createElement("span");
      probe.style.color = `rgb(from ${color} r g b)`;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      const values =
        resolved
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number) ?? [];
      return resolved.startsWith("rgb(") ? values.map((value) => value / 255) : values;
    };
    const luminance = (color: number[]) => {
      const channels = color.map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const contrast = (foreground: string, background: string) => {
      const first = luminance(toSrgb(foreground));
      const second = luminance(toSrgb(background));
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const opaqueBackground = (element: Element): string => {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        const alpha = color.match(/[\d.]+/g)?.[3];
        if (color !== "rgba(0, 0, 0, 0)" && alpha !== "0") return color;
        current = current.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };

    const ratios: number[] = [];
    for (const host of document.querySelectorAll("diffs-container")) {
      for (const lineNumber of host.shadowRoot?.querySelectorAll("[data-line-number-content]") ??
        []) {
        ratios.push(contrast(getComputedStyle(lineNumber).color, opaqueBackground(lineNumber)));
      }
    }
    for (const audited of document.querySelectorAll("[data-contrast-audited]")) {
      ratios.push(contrast(getComputedStyle(audited).color, opaqueBackground(audited)));
    }
    return {
      missingAriaControls,
      minimumContrast: ratios.length > 0 ? Math.min(...ratios) : null,
    };
  });
}
