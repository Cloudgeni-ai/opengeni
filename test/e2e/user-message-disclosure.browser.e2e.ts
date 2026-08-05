import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Locator, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const demoRoot = `${repoRoot}/packages/react/demo`;
const evidenceDir = process.env.USER_MESSAGE_ARTIFACT_DIR;

describe("long sent user-message browser acceptance", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      ["bun", "run", "vite", ".", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
      {
        cwd: demoRoot,
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      "/opt/google/chrome/chrome",
      "/usr/local/bin/chromium",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 960 },
  ] as const) {
    test(`is lossless, bounded, keyboard accessible, and viewport-safe on ${viewport.name}`, async () => {
      const page = await openHarness(browser, baseUrl, viewport);
      try {
        const body = page.locator('[data-og-message-id="long-user-message"]');
        const clip = body.locator("[data-og-user-message-clip]");
        const disclosure = body.getByRole("button", { name: "Show more" });
        const visibleLink = body.getByRole("link", { name: "Visible preview link" });
        const hiddenLink = body.locator('a[href="https://example.test/hidden-review"]');
        const hiddenAction = body.locator("[data-hidden-message-action]");
        const shadowHost = body.locator("[data-hidden-shadow-control]");
        const zeroSizeAction = body.locator("[data-zero-size-message-action]");
        const preexistingInertAction = body.locator("[data-preexisting-inert-message-action]");
        await disclosure.scrollIntoViewIfNeeded();
        await forceResizeResync(page);
        const collapsed = await body.evaluate((node) => {
          const clipNode = node.querySelector<HTMLElement>("[data-og-user-message-clip]")!;
          const shadowNode = node.querySelector<HTMLElement>("[data-hidden-shadow-control]")!;
          const zeroSizeNode = node.querySelector<HTMLElement>("[data-zero-size-message-action]")!;
          const root = document.documentElement;
          const clipRect = clipNode.getBoundingClientRect();
          const shadowRect = shadowNode.getBoundingClientRect();
          const zeroSizeRect = zeroSizeNode.getBoundingClientRect();
          return {
            ariaExpanded: node
              .querySelector("[data-og-user-message-disclosure]")
              ?.getAttribute("aria-expanded"),
            clipHeight: clipNode.getBoundingClientRect().height,
            clipScrollHeight: clipNode.scrollHeight,
            hasFade: Boolean(node.querySelector("[data-og-user-message-fade]")),
            hasFinalParagraph: (node.textContent ?? "").includes("Final paragraph after the URL"),
            hasUnicode: (node.textContent ?? "").includes("こんにちは · مرحبا · 👩🏽‍💻"),
            attachmentOutsideClip: !clipNode.contains(
              node.querySelector("[data-message-attachments]"),
            ),
            voiceOutsideClip: !clipNode.contains(node.querySelector("[data-voice-identity]")),
            contextOutsideClip: !clipNode.contains(node.querySelector("[data-voice-context]")),
            pageOverflow: root.scrollWidth - window.innerWidth,
            shadowTop: shadowRect.top,
            zeroSizeTop: zeroSizeRect.top,
            zeroSizeWidth: zeroSizeRect.width,
            zeroSizeHeight: zeroSizeRect.height,
            clipBottom: clipRect.bottom,
          };
        });
        expect(collapsed.ariaExpanded).toBe("false");
        expect(collapsed.clipHeight).toBeLessThanOrEqual(viewport.width < 640 ? 225 : 289);
        expect(collapsed.clipScrollHeight).toBeGreaterThan(collapsed.clipHeight + 100);
        expect(collapsed.hasFade).toBe(true);
        expect(collapsed.hasFinalParagraph).toBe(true);
        expect(collapsed.hasUnicode).toBe(true);
        expect(collapsed.attachmentOutsideClip).toBe(true);
        expect(collapsed.voiceOutsideClip).toBe(true);
        expect(collapsed.contextOutsideClip).toBe(true);
        expect(collapsed.pageOverflow).toBeLessThanOrEqual(1);
        expect(collapsed.shadowTop).toBeGreaterThan(collapsed.clipBottom);
        expect(collapsed.zeroSizeTop).toBeGreaterThan(collapsed.clipBottom);
        expect(collapsed.zeroSizeWidth).toBeLessThanOrEqual(0.5);
        expect(collapsed.zeroSizeHeight).toBeLessThanOrEqual(0.5);
        expect(
          await body.evaluate((node) => {
            const paragraph = [...node.querySelectorAll("p")].find((candidate) =>
              candidate.textContent?.includes("This already-sent prompt"),
            );
            const selection = window.getSelection();
            if (!paragraph || !selection) {
              return "";
            }
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            selection.removeAllRanges();
            selection.addRange(range);
            const selected = selection.toString();
            selection.removeAllRanges();
            return selected;
          }),
        ).toContain("This already-sent prompt");
        expect(await visibleLink.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(await hiddenLink.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        expect(await hiddenAction.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        expect(await shadowHost.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(
          await shadowHost.evaluate((node) =>
            node.shadowRoot?.querySelector("button")?.hasAttribute("inert"),
          ),
        ).toBe(true);
        expect(await zeroSizeAction.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        expect(await preexistingInertAction.evaluate((node) => node.hasAttribute("inert"))).toBe(
          true,
        );
        expect(
          await preexistingInertAction.evaluate((node) =>
            node.hasAttribute("data-og-user-message-managed-inert"),
          ),
        ).toBe(false);

        const collapsedAccessibility = await new AxeBuilder({ page })
          .include('[data-og-message-id="long-user-message"]')
          .analyze();
        expect(collapsedAccessibility.violations).toEqual([]);

        await visibleLink.focus();
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        await page.keyboard.press("Shift+Tab");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(
          "https://example.test/visible-preview",
        );
        await disclosure.focus();
        await hiddenLink.evaluate((node: HTMLElement) => node.focus());
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        await shadowHost.evaluate((node) => {
          (node.shadowRoot?.querySelector("button") as HTMLElement | null)?.focus();
        });
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        await zeroSizeAction.evaluate((node: HTMLElement) => node.focus());
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        await preexistingInertAction.evaluate((node: HTMLElement) => node.focus());
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        const collapsedAxTree = await chromeAccessibilityTree(page);
        expect(exposedSpecialControlNames(collapsedAxTree)).toEqual([]);
        await hiddenAction.evaluate((node: HTMLElement) => node.focus());
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);

        if (evidenceDir) {
          await page.screenshot({
            path: `${evidenceDir}/user-message-${viewport.name}-collapsed.png`,
            fullPage: true,
          });
        }

        await disclosure.focus();
        await page.keyboard.press("Enter");
        let showLess = body.getByRole("button", { name: "Show less" });
        await showLess.waitFor();
        expect(await showLess.getAttribute("aria-expanded")).toBe("true");
        const expandedHeight = await clip.evaluate((node) => node.getBoundingClientRect().height);
        expect(expandedHeight).toBeGreaterThan(collapsed.clipHeight + 100);
        expect(await body.locator("[data-og-user-message-fade]").count()).toBe(0);
        expect(await hiddenLink.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(await hiddenAction.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(await shadowHost.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(
          await shadowHost.evaluate((node) =>
            node.shadowRoot?.querySelector("button")?.hasAttribute("inert"),
          ),
        ).toBe(false);
        expect(await zeroSizeAction.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(await preexistingInertAction.evaluate((node) => node.hasAttribute("inert"))).toBe(
          true,
        );

        await visibleLink.focus();
        await page.keyboard.press("Tab");
        expect(
          await body.evaluate((node) => {
            const content = node.querySelector("[data-og-user-message-content]");
            const active = document.activeElement;
            return {
              insideContent: Boolean(content && active && content.contains(active)),
              insideInertSubtree: Boolean(active?.closest("[inert]")),
            };
          }),
        ).toEqual({ insideContent: true, insideInertSubtree: false });

        await hiddenLink.focus();
        expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(
          "https://example.test/hidden-review",
        );

        expect(
          await shadowHost.evaluate((node) => {
            const button = node.shadowRoot?.querySelector("button") as HTMLElement | null;
            button?.focus();
            return {
              documentFocusOnHost: document.activeElement === node,
              shadowFocusLabel: node.shadowRoot?.activeElement?.textContent,
            };
          }),
        ).toEqual({ documentFocusOnHost: true, shadowFocusLabel: "Shadow hidden action" });
        await zeroSizeAction.focus();
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-zero-size-message-action"),
          ),
        ).toBe(true);
        await preexistingInertAction.evaluate((node: HTMLElement) => node.focus());
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-zero-size-message-action"),
          ),
        ).toBe(true);
        const expandedAxTree = await chromeAccessibilityTree(page);
        expect(exposedSpecialControlNames(expandedAxTree)).toEqual([
          "Shadow hidden action",
          "Zero-size hidden action",
        ]);

        await showLess.evaluate((node: HTMLButtonElement) => node.click());
        const showMoreAgain = body.getByRole("button", { name: "Show more" });
        await showMoreAgain.waitFor();
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        expect(await hiddenLink.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        expect(await hiddenAction.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        expect(await shadowHost.evaluate((node) => node.hasAttribute("inert"))).toBe(false);
        expect(
          await shadowHost.evaluate((node) =>
            node.shadowRoot?.querySelector("button")?.hasAttribute("inert"),
          ),
        ).toBe(true);
        expect(await zeroSizeAction.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        expect(await preexistingInertAction.evaluate((node) => node.hasAttribute("inert"))).toBe(
          true,
        );

        await shadowHost.evaluate((node) =>
          node.shadowRoot?.querySelector("button")?.removeAttribute("inert"),
        );
        await zeroSizeAction.evaluate((node) => node.removeAttribute("inert"));
        await forceResizeResync(page);
        expect(
          await shadowHost.evaluate((node) =>
            node.shadowRoot?.querySelector("button")?.hasAttribute("inert"),
          ),
        ).toBe(true);
        expect(await zeroSizeAction.evaluate((node) => node.hasAttribute("inert"))).toBe(true);
        await shadowHost.evaluate((node) => {
          (node.shadowRoot?.querySelector("button") as HTMLElement | null)?.focus();
        });
        expect(
          await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-og-user-message-disclosure"),
          ),
        ).toBe(true);
        await page.keyboard.press("Enter");
        showLess = body.getByRole("button", { name: "Show less" });
        await showLess.waitFor();

        const accessibility = await new AxeBuilder({ page })
          .include('[data-og-message-id="long-user-message"]')
          .analyze();
        expect(accessibility.violations).toEqual([]);

        if (evidenceDir) {
          await page.screenshot({
            path: `${evidenceDir}/user-message-${viewport.name}-expanded.png`,
            fullPage: true,
          });
          await writeFile(
            `${evidenceDir}/user-message-${viewport.name}-accessibility.json`,
            `${JSON.stringify(
              {
                viewport,
                collapsed,
                expandedHeight,
                ariaExpanded: await showLess.getAttribute("aria-expanded"),
                focusedLabel: await page.evaluate(() => document.activeElement?.textContent),
                collapsedAxeViolations: collapsedAccessibility.violations.length,
                axeViolations: accessibility.violations.length,
                collapsedSpecialAxControls: exposedSpecialControlNames(collapsedAxTree),
                expandedSpecialAxControls: exposedSpecialControlNames(expandedAxTree),
              },
              null,
              2,
            )}\n`,
          );
        }
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("preserves scrolled-back anchors, expansion state, streaming, and prepend", async () => {
    const page = await openHarness(browser, baseUrl, { width: 1280, height: 900 });
    try {
      const body = page.locator('[data-og-message-id="long-user-message"]');
      const group = body.locator("xpath=ancestor::*[@data-og-timeline-group-anchor]");
      const scroller = page.locator("[data-og-timeline-scroller]");
      await scroller.evaluate((node) => {
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
      });
      await group.evaluate((node) => node.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(100);
      expect(await scroller.getAttribute("data-og-bottom-follow")).toBe("false");
      const beforeExpand = await relativeTop(group, scroller);
      await body
        .getByRole("button", { name: "Show more" })
        .evaluate((node: HTMLButtonElement) => node.click());
      const afterExpand = await relativeTop(group, scroller);
      expect(afterExpand).toBeCloseTo(beforeExpand, 0);

      await page.evaluate(() => window.userMessageHarness!.stream());
      await page.evaluate(() => window.userMessageHarness!.prepend());
      expect(
        await body.locator("[data-og-user-message-disclosure]").getAttribute("aria-expanded"),
      ).toBe("true");
      const afterUpdates = await relativeTop(group, scroller);
      expect(afterUpdates).toBeCloseTo(afterExpand, 0);

      const showLess = body.getByRole("button", { name: "Show less" });
      await showLess.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(50);
      const beforeCollapse = await relativeTop(showLess, scroller);
      await showLess.evaluate((node: HTMLButtonElement) => node.click());
      const afterCollapse = await relativeTop(
        body.getByRole("button", { name: "Show more" }),
        scroller,
      );
      expect(afterCollapse).toBeCloseTo(beforeCollapse, 0);
      expect(await scroller.getAttribute("data-og-bottom-follow")).toBe("false");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keeps bottom-follow pinned when a near-tip message expands", async () => {
    const page = await openHarness(browser, baseUrl, { width: 1280, height: 900 });
    try {
      const scroller = page.locator("[data-og-timeline-scroller]");
      await scroller.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(100);
      expect(await scroller.getAttribute("data-og-bottom-follow")).toBe("true");
      const disclosure = page
        .locator('[data-og-message-id="long-user-message"]')
        .getByRole("button", { name: "Show more" });
      await disclosure.evaluate((node: HTMLButtonElement) => node.click());
      await page.waitForFunction(() => {
        const node = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
        return Boolean(node && node.scrollHeight - node.scrollTop - node.clientHeight < 2);
      });
      const result = await scroller.evaluate((node) => ({
        gap: node.scrollHeight - node.scrollTop - node.clientHeight,
        bottomFollow: node.getAttribute("data-og-bottom-follow"),
      }));
      expect(result.gap).toBeLessThan(2);
      expect(result.bottomFollow).toBe("true");
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

async function openHarness(
  browser: Browser,
  baseUrl: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.width <= 768,
    isMobile: viewport.width <= 390,
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/user-message-test.html`);
  await page.waitForFunction(() => window.userMessageHarness !== undefined);
  await page.locator('[data-og-message-id="long-user-message"]').waitFor({ timeout: 15_000 });
  return page;
}

async function relativeTop(target: Locator, scroller: Locator) {
  const [targetBox, scrollerBox] = await Promise.all([
    target.boundingBox(),
    scroller.boundingBox(),
  ]);
  if (!targetBox || !scrollerBox) {
    throw new Error("expected visible target and timeline scroller");
  }
  return targetBox.y - scrollerBox.y;
}

type AccessibleTreeNode = {
  ignored: boolean;
  role: string;
  name: string;
};

async function chromeAccessibilityTree(page: Page): Promise<AccessibleTreeNode[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    return nodes.map((node) => ({
      ignored: node.ignored,
      role: accessibilityValue(node.role),
      name: accessibilityValue(node.name),
    }));
  } finally {
    await session.detach();
  }
}

function accessibilityValue(value: { value?: unknown } | undefined): string {
  return typeof value?.value === "string" ? value.value : "";
}

function exposedSpecialControlNames(nodes: AccessibleTreeNode[]): string[] {
  const names = new Set(["Shadow hidden action", "Zero-size hidden action"]);
  return nodes
    .filter((node) => !node.ignored && node.role === "button" && names.has(node.name))
    .map((node) => node.name)
    .sort();
}

async function forceResizeResync(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.dispatchEvent(new Event("resize"));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
