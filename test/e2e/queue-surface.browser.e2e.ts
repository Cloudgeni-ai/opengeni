import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, runCommand, startProcess, type StartedProcess } from "@opengeni/testing";
import {
  OMITTED_QUEUE_SOURCE_MARKER,
  queueHarnessPrompt,
  queuePromptFingerprint,
} from "../../packages/react/demo/queue-fixtures";

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = process.env.OPENGENI_OPE9_EVIDENCE_DIR ?? "/tmp/opengeni-ope9-queue-evidence";
const viewports = [
  { width: 320, height: 800 },
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
  focusOrder: FocusMeasurement[];
};

type FocusMeasurement = {
  name: string;
  centerX: number;
  centerY: number;
};

type BrowserAccessibilityEvidence = {
  viewport: { width: number; height: number };
  queueSize: number;
  collapsed: {
    controlName: string;
    boundedDescription: string;
    fingerprintPresent: boolean;
    omittedMiddleSourcePresent: boolean;
  };
  expanded: {
    summaryCount: number;
    uniqueContentSummaryCount: number;
    distinctiveFingerprintCount: number;
    repeatedDescendantCount: number;
    firstSummary: string;
    lastSummary: string;
    omittedMiddleSourcePresent: boolean;
  };
  disclosed: {
    regionName: string;
    exactPromptPresent: boolean;
    omittedMiddleSourcePresent: boolean;
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
        expect(collapsed.collapsedPreviewCharacters).toBeLessThanOrEqual(180);
        expect(collapsed.colorScheme).toBe(theme);
        expect(collapsed.backgroundLightness).not.toBeNull();
        if (theme === "light") {
          expect(collapsed.backgroundLightness ?? 0).toBeGreaterThan(0.9);
        } else {
          expect(collapsed.backgroundLightness ?? 1).toBeLessThan(0.3);
        }
        const collapsedTree = await chromeAccessibilityTree(page);
        const collapsedControl = collapsedTree.find(
          (node) => !node.ignored && node.role === "button" && node.name === "100 queued prompts",
        );
        expect(collapsedControl?.description).toContain(queuePromptFingerprint(0));
        expect(exposedTreeIncludes(collapsedTree, OMITTED_QUEUE_SOURCE_MARKER)).toBe(false);
        expect(exposedNodesContaining(collapsedTree, queuePromptFingerprint(0))).toHaveLength(1);
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
        expect(expanded.maxRowHeight).toBeLessThanOrEqual(viewport.width <= 375 ? 194 : 160);

        const expandedTree = await chromeAccessibilityTree(page);
        const summaryNodes = queueSummaryNodes(expandedTree);
        const contentSummaries = summaryNodes.map((node) =>
          node.name.replace(/^Queued prompt \d+ summary: /, ""),
        );
        expect(summaryNodes).toHaveLength(100);
        expect(new Set(contentSummaries).size).toBe(100);
        expect(exposedTreeIncludes(expandedTree, OMITTED_QUEUE_SOURCE_MARKER)).toBe(false);
        for (let index = 0; index < summaryNodes.length; index += 1) {
          expect(summaryNodes[index]?.name).toContain(queuePromptFingerprint(index));
          expect(
            unignoredDescendants(expandedTree, summaryNodes[index]?.nodeId ?? ""),
          ).toHaveLength(0);
          expect(exposedNodesContaining(expandedTree, queuePromptFingerprint(index))).toHaveLength(
            1,
          );
        }

        const focusOrder = await sequentialQueueFocusOrder(page);
        expect(focusOrder.map((item) => item.name)).toEqual([
          "Reorder queued prompt 1",
          "Show full content for queued prompt 1",
          "Steer queued prompt 1",
          "Delete queued prompt 1",
          "More actions for queued prompt 1",
          "Reorder queued prompt 2",
        ]);
        assertCoherentFocusGeometry(focusOrder, viewport.width);

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
        expect(await full.textContent()).toBe(queueHarnessPrompt(0));

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
        expect(await full.textContent()).toBe(queueHarnessPrompt(0));

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
          focusOrder,
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
    ).toBe(queueHarnessPrompt(0));
    expect((await pageMetrics(readOnlyPage)).documentOverflow).toBeLessThanOrEqual(1);
    await readOnlyContext.close();
  }, 30_000);

  test("Chrome exposes one useful bounded summary per duplicate-prefix prompt", async () => {
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
        (node) => !node.ignored && node.role === "button" && node.name === "100 queued prompts",
      );
      expect(collapsedControl).toBeDefined();
      expect(collapsedControl?.description).toMatch(/^# Production migration/);
      expect(collapsedControl?.description).toContain(queuePromptFingerprint(0));
      expect(Array.from(collapsedControl?.description ?? "").length).toBeLessThanOrEqual(180);
      expect(exposedNodesContaining(collapsedTree, queuePromptFingerprint(0))).toHaveLength(1);
      expect(exposedTreeIncludes(collapsedTree, OMITTED_QUEUE_SOURCE_MARKER)).toBe(false);

      await page.getByRole("button", { name: "100 queued prompts", exact: true }).click();
      const expandedTree = await chromeAccessibilityTree(page);
      const summaryNodes = queueSummaryNodes(expandedTree);
      const contentSummaries = summaryNodes.map((node) =>
        node.name.replace(/^Queued prompt \d+ summary: /, ""),
      );
      expect(summaryNodes).toHaveLength(100);
      expect(new Set(contentSummaries).size).toBe(100);
      for (let index = 0; index < summaryNodes.length; index += 1) {
        expect(summaryNodes[index]?.name).toContain(queuePromptFingerprint(index));
        expect(Array.from(contentSummaries[index] ?? "").length).toBeLessThanOrEqual(360);
        expect(unignoredDescendants(expandedTree, summaryNodes[index]?.nodeId ?? "")).toHaveLength(
          0,
        );
        expect(exposedNodesContaining(expandedTree, queuePromptFingerprint(index))).toHaveLength(1);
      }
      expect(exposedTreeIncludes(expandedTree, OMITTED_QUEUE_SOURCE_MARKER)).toBe(false);
      expect(
        expandedTree.some(
          (node) =>
            !node.ignored &&
            node.role === "region" &&
            node.name === "Full content for queued prompt 1",
        ),
      ).toBe(false);

      await page
        .getByRole("button", {
          name: "Show full content for queued prompt 1",
          exact: true,
        })
        .click();
      const exactPrompt = queueHarnessPrompt(0);
      const disclosedTree = await chromeAccessibilityTree(page);
      const disclosedRegion = disclosedTree.find(
        (node) =>
          !node.ignored &&
          node.role === "region" &&
          node.name === "Full content for queued prompt 1",
      );
      expect(disclosedRegion).toBeDefined();
      expect(disclosedTree.some((node) => !node.ignored && node.name === exactPrompt)).toBe(true);
      expect(exposedTreeIncludes(disclosedTree, OMITTED_QUEUE_SOURCE_MARKER)).toBe(true);
      expect((await pageMetrics(page)).documentOverflow).toBeLessThanOrEqual(1);
      expect(diagnostics).toEqual([]);

      accessibilityEvidence = {
        viewport,
        queueSize: summaryNodes.length,
        collapsed: {
          controlName: collapsedControl?.name ?? "",
          boundedDescription: collapsedControl?.description ?? "",
          fingerprintPresent:
            collapsedControl?.description.includes(queuePromptFingerprint(0)) ?? false,
          omittedMiddleSourcePresent: exposedTreeIncludes(
            collapsedTree,
            OMITTED_QUEUE_SOURCE_MARKER,
          ),
        },
        expanded: {
          summaryCount: summaryNodes.length,
          uniqueContentSummaryCount: new Set(contentSummaries).size,
          distinctiveFingerprintCount: summaryNodes.filter((node, index) =>
            node.name.includes(queuePromptFingerprint(index)),
          ).length,
          repeatedDescendantCount: summaryNodes.reduce(
            (count, node) => count + unignoredDescendants(expandedTree, node.nodeId).length,
            0,
          ),
          firstSummary: summaryNodes[0]?.name ?? "",
          lastSummary: summaryNodes.at(-1)?.name ?? "",
          omittedMiddleSourcePresent: exposedTreeIncludes(
            expandedTree,
            OMITTED_QUEUE_SOURCE_MARKER,
          ),
        },
        disclosed: {
          regionName: disclosedRegion?.name ?? "",
          exactPromptPresent: disclosedTree.some(
            (node) => !node.ignored && node.name === exactPrompt,
          ),
          omittedMiddleSourcePresent: exposedTreeIncludes(
            disclosedTree,
            OMITTED_QUEUE_SOURCE_MARKER,
          ),
        },
      };
      await capture(page, viewport.width, "light", "disclosed");
    } finally {
      await context.close();
    }
  }, 30_000);
});

type AccessibleTreeNode = {
  nodeId: string;
  parentId: string | null;
  childIds: string[];
  ignored: boolean;
  role: string;
  name: string;
  description: string;
};

async function chromeAccessibilityTree(page: Page): Promise<AccessibleTreeNode[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    return nodes.map((node) => ({
      nodeId: node.nodeId,
      parentId: node.parentId ?? null,
      childIds: node.childIds ?? [],
      ignored: node.ignored,
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

function queueSummaryNodes(nodes: AccessibleTreeNode[]): AccessibleTreeNode[] {
  return nodes.filter(
    (node) =>
      !node.ignored && node.role === "note" && /^Queued prompt \d+ summary: /.test(node.name),
  );
}

function exposedTreeIncludes(nodes: AccessibleTreeNode[], expected: string): boolean {
  return exposedNodesContaining(nodes, expected).length > 0;
}

function exposedNodesContaining(
  nodes: AccessibleTreeNode[],
  expected: string,
): AccessibleTreeNode[] {
  return nodes.filter(
    (node) =>
      !node.ignored && (node.name.includes(expected) || node.description.includes(expected)),
  );
}

function unignoredDescendants(
  nodes: AccessibleTreeNode[],
  rootNodeId: string,
): AccessibleTreeNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const pending = [...(byId.get(rootNodeId)?.childIds ?? [])];
  const descendants: AccessibleTreeNode[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) continue;
    if (!node.ignored) descendants.push(node);
    pending.push(...node.childIds);
  }
  return descendants;
}

async function sequentialQueueFocusOrder(page: Page): Promise<FocusMeasurement[]> {
  const order: FocusMeasurement[] = [];
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        const bounds = element?.getBoundingClientRect();
        return {
          name: element?.getAttribute("aria-label") ?? "",
          centerX: (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
          centerY: (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
        };
      }),
    );
  }
  return order;
}

function assertCoherentFocusGeometry(order: FocusMeasurement[], viewportWidth: number): void {
  expect(order).toHaveLength(6);
  if (viewportWidth <= 375) {
    for (let index = 1; index < order.length; index += 1) {
      expect((order[index]?.centerY ?? 0) + 1).toBeGreaterThanOrEqual(
        order[index - 1]?.centerY ?? Infinity,
      );
    }
    expect(order[1]?.centerY ?? 0).toBeGreaterThan(order[0]?.centerY ?? Infinity);
    expect(order[2]?.centerY ?? 0).toBeGreaterThan(order[1]?.centerY ?? Infinity);
    expect(order[3]?.centerX ?? 0).toBeGreaterThan(order[2]?.centerX ?? Infinity);
    expect(order[4]?.centerX ?? 0).toBeGreaterThan(order[3]?.centerX ?? Infinity);
    expect(order[5]?.centerY ?? 0).toBeGreaterThan(order[4]?.centerY ?? Infinity);
    return;
  }

  for (let index = 1; index < 5; index += 1) {
    expect(order[index]?.centerX ?? 0).toBeGreaterThan(order[index - 1]?.centerX ?? Infinity);
  }
  expect(order[5]?.centerY ?? 0).toBeGreaterThan(order[4]?.centerY ?? Infinity);
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
