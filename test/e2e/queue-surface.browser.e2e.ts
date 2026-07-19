import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";
import { HOSTILE_QUEUE_PROMPT } from "../../packages/react/demo/queue-fixtures";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = process.env.OPENGENI_OPE9_EVIDENCE_DIR ?? "/tmp/opengeni-ope9-queue-evidence";
const viewports = [
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 768, height: 960 },
  { width: 1440, height: 1000 },
] as const;
const themes = ["dark", "light"] as const;

type BrowserMeasurement = {
  viewport: (typeof viewports)[number];
  theme: (typeof themes)[number];
  collapsedHeight: number;
  expandedListHeight: number;
  expandedListScrollHeight: number;
  disclosedHeight: number;
  disclosedScrollHeight: number;
  documentOverflow: number;
  backgroundColor: string;
  backgroundLightness: number | null;
  colorScheme: string;
};

type BrowserAccessibilityEvidence = {
  viewport: { width: number; height: number };
  queueSize: number;
  collapsed: {
    controlName: string;
    boundedDescription: string;
    exactTrailingSourcePresent: boolean;
  };
  expanded: {
    summaryCount: number;
    uniqueSummaryCount: number;
    firstSummary: string;
    lastSummary: string;
    exactTrailingSourcePresent: boolean;
  };
  disclosed: {
    regionName: string;
    exactPromptPresent: boolean;
    exactTrailingSourcePresent: boolean;
  };
};

describe("queue surface browser acceptance", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;
  const measurements: BrowserMeasurement[] = [];
  let accessibilityEvidence: BrowserAccessibilityEvidence | null = null;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await mkdir(evidenceDir, { recursive: true });
    try {
      const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
        cwd: `${repoRoot}/packages/react`,
        timeoutMs: 60_000,
      });
      if (build.exitCode !== 0) {
        throw new Error(`Queue demo build failed:\n${build.stdout}\n${build.stderr}`);
      }
      browser = await chromium.launch({
        executablePath:
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/local/bin/chromium",
      });
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
              await fetch(`${baseUrl}/queue.html`, {
                signal: AbortSignal.timeout(2_000),
              }).catch(() => null)
            )?.ok === true,
          timeoutMs: 45_000,
        },
      );
    } catch (error) {
      await Promise.allSettled([demo?.stop(), browser?.close()]);
      throw error;
    }
  }, 90_000);

  afterAll(async () => {
    await writeFile(
      `${evidenceDir}/measurements.json`,
      `${JSON.stringify({ measurements }, null, 2)}\n`,
    );
    if (accessibilityEvidence) {
      await writeFile(
        `${evidenceDir}/accessibility.json`,
        `${JSON.stringify(accessibilityEvidence, null, 2)}\n`,
      );
    }
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 60_000);

  test("large prompts and 100 rows stay bounded across the viewport and theme matrix", async () => {
    for (const viewport of viewports) {
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width <= 768,
          isMobile: viewport.width <= 375,
        });
        const page = await context.newPage();
        const diagnostics = observePageFailures(page);
        await page.goto(`${baseUrl}/queue.html?count=100&theme=${theme}`, {
          waitUntil: "networkidle",
        });
        const surface = page.getByTestId("queue-surface");
        await surface.waitFor();

        const collapsed = await pageMetrics(page);
        expect(collapsed.documentOverflow).toBeLessThanOrEqual(1);
        expect(collapsed.surfaceHeight).toBeLessThanOrEqual(48);
        expect(collapsed.collapsedPreviewCharacters).toBeLessThanOrEqual(181);
        expect(collapsed.colorScheme).toBe(theme);
        expect(collapsed.backgroundLightness).not.toBeNull();
        if (theme === "light") {
          expect(collapsed.backgroundLightness ?? 0).toBeGreaterThan(0.9);
        } else {
          expect(collapsed.backgroundLightness ?? 1).toBeLessThan(0.3);
        }
        await capture(page, viewport.width, theme, "collapsed");

        const toggle = page.getByRole("button", { name: "100 queued prompts" });
        await toggle.focus();
        await page.keyboard.press("Enter");
        const list = page.getByTestId("queue-list");
        await list.waitFor();
        expect(await list.getAttribute("aria-label")).toBe("Queued prompts");
        expect(await page.locator("[data-queue-turn-id]").count()).toBe(100);
        expect(await page.locator('[data-testid^="queue-prompt-full-"]').count()).toBe(0);

        const expanded = await pageMetrics(page);
        expect(expanded.documentOverflow).toBeLessThanOrEqual(1);
        expect(expanded.listHeight).toBeLessThanOrEqual(
          Math.min(480, Math.round(viewport.height * 0.6)) + 2,
        );
        expect(expanded.listScrollHeight).toBeGreaterThan(expanded.listHeight);
        expect(expanded.maxPreviewHeight).toBeLessThanOrEqual(61);
        expect(expanded.maxRowHeight).toBeLessThanOrEqual(160);

        if (viewport.width <= 768) {
          for (const height of expanded.coarseControlHeights) {
            expect(height).toBeGreaterThanOrEqual(43);
          }
        }
        await capture(page, viewport.width, theme, "expanded");

        const disclosure = page.getByRole("button", {
          name: "Show full content for queued prompt 1",
          exact: true,
        });
        await disclosure.focus();
        await page.keyboard.press("Enter");
        expect(
          await page
            .getByRole("button", {
              name: "Hide full content for queued prompt 1",
              exact: true,
            })
            .getAttribute("aria-expanded"),
        ).toBe("true");
        const full = page.getByRole("region", {
          name: "Full content for queued prompt 1",
          exact: true,
        });
        expect(await full.textContent()).toBe(`1 / 100\n${HOSTILE_QUEUE_PROMPT}`);

        const disclosed = await pageMetrics(page);
        expect(disclosed.documentOverflow).toBeLessThanOrEqual(1);
        expect(disclosed.fullHeight).toBeLessThanOrEqual(258);
        expect(disclosed.fullScrollHeight).toBeGreaterThan(disclosed.fullHeight);
        expect(disclosed.fullOverflow).toBeLessThanOrEqual(1);
        await page.keyboard.press("Tab");
        expect(await full.evaluate((element) => document.activeElement === element)).toBe(true);
        await capture(page, viewport.width, theme, "disclosed");

        await refreshQueue(page);
        await page.getByRole("button", { name: "101 queued prompts" }).waitFor();
        const refreshed = await pageMetrics(page);
        expect(refreshed.documentOverflow).toBeLessThanOrEqual(1);
        expect(refreshed.listHeight).toBeLessThanOrEqual(
          Math.min(480, Math.round(viewport.height * 0.6)) + 2,
        );
        expect(await full.textContent()).toBe(`1 / 100\n${HOSTILE_QUEUE_PROMPT}`);

        if (viewport.width === 360 || viewport.width === 1440) {
          const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
          expect(report.violations).toEqual([]);
        }
        expect(diagnostics).toEqual([]);
        measurements.push({
          viewport,
          theme,
          collapsedHeight: collapsed.surfaceHeight,
          expandedListHeight: expanded.listHeight,
          expandedListScrollHeight: expanded.listScrollHeight,
          disclosedHeight: disclosed.fullHeight,
          disclosedScrollHeight: disclosed.fullScrollHeight,
          documentOverflow: disclosed.documentOverflow,
          backgroundColor: collapsed.backgroundColor,
          backgroundLightness: collapsed.backgroundLightness,
          colorScheme: collapsed.colorScheme,
        });
        await context.close();
      }
    }
  }, 120_000);

  test("dragging and read-only disclosure cannot escape the viewport", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/queue.html?count=2&theme=dark`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "2 queued prompts" }).click();
    const handle = page.getByRole("button", { name: "Reorder queued prompt 1" });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("queue drag handle has no layout box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 24, { steps: 4 });
    const overlay = page.getByTestId("queue-drag-overlay");
    await overlay.waitFor();
    const overlayBox = await overlay.boundingBox();
    expect(overlayBox).not.toBeNull();
    expect(overlayBox?.height ?? Infinity).toBeLessThanOrEqual(82);
    expect(overlayBox?.width ?? Infinity).toBeLessThanOrEqual(343);
    await page.mouse.up();
    expect((await pageMetrics(page)).documentOverflow).toBeLessThanOrEqual(1);
    await context.close();

    const readOnlyContext = await browser.newContext({ viewport: { width: 768, height: 960 } });
    const readOnlyPage = await readOnlyContext.newPage();
    await readOnlyPage.goto(`${baseUrl}/queue.html?count=1&theme=light&readOnly=1`, {
      waitUntil: "networkidle",
    });
    await readOnlyPage.getByRole("button", { name: /1 queued prompt Read-only/ }).click();
    expect(await readOnlyPage.getByRole("button", { name: /^Steer queued prompt/ }).count()).toBe(
      0,
    );
    await readOnlyPage
      .getByRole("button", { name: "Show full content for queued prompt 1", exact: true })
      .click();
    expect(
      await readOnlyPage
        .getByRole("region", { name: "Full content for queued prompt 1", exact: true })
        .textContent(),
    ).toBe(`1 / 1\n${HOSTILE_QUEUE_PROMPT}`);
    expect((await pageMetrics(readOnlyPage)).documentOverflow).toBeLessThanOrEqual(1);
    await readOnlyContext.close();
  }, 30_000);

  test("Chrome exposes 100 bounded prompt summaries before exact-source disclosure", async () => {
    const viewport = { width: 320, height: 800 };
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      const diagnostics = observePageFailures(page);
      await page.goto(`${baseUrl}/queue.html?count=100&theme=light`, {
        waitUntil: "networkidle",
      });

      const collapsedTree = await chromeAccessibilityTree(page);
      const collapsedControl = collapsedTree.find(
        (node) => node.role === "button" && node.name === "100 queued prompts",
      );
      expect(collapsedControl).toBeDefined();
      expect(collapsedControl?.description).toMatch(/^1 \/ 100\s+# Production migration/);
      expect(Array.from(collapsedControl?.description ?? "").length).toBeLessThanOrEqual(181);
      expect(accessibleTreeIncludes(collapsedTree, "Exact trailing line.")).toBe(false);

      await page.getByRole("button", { name: "100 queued prompts", exact: true }).click();
      const expandedTree = await chromeAccessibilityTree(page);
      const summaries = expandedTree
        .filter((node) => node.role === "note" && /^Queued prompt \d+ summary: /.test(node.name))
        .map((node) => node.name);
      expect(summaries).toHaveLength(100);
      expect(new Set(summaries).size).toBe(100);
      for (let index = 0; index < summaries.length; index += 1) {
        expect(
          summaries[index]?.startsWith(`Queued prompt ${index + 1} summary: ${index + 1} / 100`),
        ).toBe(true);
        expect(Array.from(summaries[index] ?? "").length).toBeLessThanOrEqual(400);
      }
      expect(accessibleTreeIncludes(expandedTree, "Exact trailing line.")).toBe(false);
      expect(
        expandedTree.some(
          (node) => node.role === "region" && node.name === "Full content for queued prompt 1",
        ),
      ).toBe(false);

      await page
        .getByRole("button", {
          name: "Show full content for queued prompt 1",
          exact: true,
        })
        .click();
      const exactPrompt = `1 / 100\n${HOSTILE_QUEUE_PROMPT}`;
      const disclosedTree = await chromeAccessibilityTree(page);
      const disclosedRegion = disclosedTree.find(
        (node) => node.role === "region" && node.name === "Full content for queued prompt 1",
      );
      expect(disclosedRegion).toBeDefined();
      expect(disclosedTree.some((node) => node.name === exactPrompt)).toBe(true);
      expect(accessibleTreeIncludes(disclosedTree, "Exact trailing line.")).toBe(true);
      expect((await pageMetrics(page)).documentOverflow).toBeLessThanOrEqual(1);
      expect(diagnostics).toEqual([]);

      accessibilityEvidence = {
        viewport,
        queueSize: summaries.length,
        collapsed: {
          controlName: collapsedControl?.name ?? "",
          boundedDescription: collapsedControl?.description ?? "",
          exactTrailingSourcePresent: accessibleTreeIncludes(collapsedTree, "Exact trailing line."),
        },
        expanded: {
          summaryCount: summaries.length,
          uniqueSummaryCount: new Set(summaries).size,
          firstSummary: summaries[0] ?? "",
          lastSummary: summaries.at(-1) ?? "",
          exactTrailingSourcePresent: accessibleTreeIncludes(expandedTree, "Exact trailing line."),
        },
        disclosed: {
          regionName: disclosedRegion?.name ?? "",
          exactPromptPresent: disclosedTree.some((node) => node.name === exactPrompt),
          exactTrailingSourcePresent: accessibleTreeIncludes(disclosedTree, "Exact trailing line."),
        },
      };
      await capture(page, viewport.width, "light", "disclosed");
    } finally {
      await context.close();
    }
  }, 30_000);
});

type AccessibleTreeNode = {
  role: string;
  name: string;
  description: string;
};

async function chromeAccessibilityTree(page: Page): Promise<AccessibleTreeNode[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    return nodes
      .filter((node) => !node.ignored)
      .map((node) => ({
        role: accessibilityValue(node.role),
        name: accessibilityValue(node.name),
        description: accessibilityValue(node.description),
      }));
  } finally {
    await session.detach();
  }
}

function accessibilityValue(value: { value?: unknown } | undefined): string {
  return typeof value?.value === "string" ? value.value : "";
}

function accessibleTreeIncludes(nodes: AccessibleTreeNode[], expected: string): boolean {
  return nodes.some((node) => node.name.includes(expected) || node.description.includes(expected));
}

async function refreshQueue(page: Page): Promise<void> {
  await page.evaluate(() => window.__ope9SetQueueLoading?.(true));
  await page.locator('[data-testid="queue-surface"] .animate-spin').waitFor();
  await page.evaluate(() => window.__ope9AppendQueuePrompt?.());
  await page.getByRole("button", { name: "101 queued prompts" }).waitFor();
  await page.evaluate(() => window.__ope9SetQueueLoading?.(false));
}

async function capture(
  page: Page,
  width: number,
  theme: (typeof themes)[number],
  state: "collapsed" | "expanded" | "disclosed",
): Promise<void> {
  await page.screenshot({
    path: `${evidenceDir}/after-${width}-${theme}-${state}.png`,
    animations: "disabled",
  });
}

async function pageMetrics(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="queue-surface"]');
    const list = document.querySelector<HTMLElement>('[data-testid="queue-list"]');
    const full = document.querySelector<HTMLElement>('[data-testid="queue-prompt-full-1"]');
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-queue-turn-id]"));
    const previews = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="queue-prompt-preview-"]'),
    );
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-queue-turn-id]:first-child button[aria-label], [data-queue-turn-id]:first-child [data-queue-handle]",
      ),
    );
    const harness = document.querySelector<HTMLElement>("[data-queue-harness]");
    const harnessStyles = harness ? getComputedStyle(harness) : null;
    const backgroundColor = harnessStyles?.backgroundColor ?? "";
    const lightnessMatch = /^oklch\(([\d.]+)(%)?/.exec(backgroundColor);
    const backgroundLightness = lightnessMatch
      ? Number(lightnessMatch[1]) / (lightnessMatch[2] ? 100 : 1)
      : null;
    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      surfaceHeight: Math.round(surface?.getBoundingClientRect().height ?? 0),
      collapsedPreviewCharacters: Array.from(
        document.querySelector<HTMLElement>('[data-testid="queue-collapsed-preview"]')
          ?.textContent ?? "",
      ).length,
      listHeight: Math.round(list?.getBoundingClientRect().height ?? 0),
      listScrollHeight: list?.scrollHeight ?? 0,
      maxRowHeight: Math.round(
        Math.max(0, ...rows.map((row) => row.getBoundingClientRect().height)),
      ),
      maxPreviewHeight: Math.round(
        Math.max(0, ...previews.map((preview) => preview.getBoundingClientRect().height)),
      ),
      coarseControlHeights: controls.map((control) =>
        Math.round(control.getBoundingClientRect().height),
      ),
      fullHeight: Math.round(full?.getBoundingClientRect().height ?? 0),
      fullScrollHeight: full?.scrollHeight ?? 0,
      fullOverflow: full ? Math.max(0, full.scrollWidth - full.clientWidth) : 0,
      backgroundColor,
      backgroundLightness,
      colorScheme: harnessStyles?.colorScheme ?? "",
    };
  });
}

function observePageFailures(page: Page): string[] {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      diagnostics.push(`console:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => diagnostics.push(`page:${String(error)}`));
  page.on("requestfailed", (request) => diagnostics.push(`request:${request.url()}`));
  return diagnostics;
}
