import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const root = new URL("../..", import.meta.url).pathname;

describe("console composer in a split desktop pane", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;

  beforeAll(async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/test/composer-pane.html`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${root}/apps/web`,
        ready: async () => (await fetch(url).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
    });
    page = await browser.newPage({
      viewport: { width: 1775, height: 1000 },
      reducedMotion: "reduce",
    });
    // Keep the production settings editor, but supply deterministic context at
    // the fixture boundary instead of bootstrapping a live authenticated app.
    await page.route("**/src/context.tsx", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `let settings = {}; const context = {
        client: {
          getAgentLearningSettings: async () => ({ version: 1, settings }),
          saveAgentLearningSettings: async (_workspace, input) => {
            settings = { ...settings, ...input.settings };
            return { version: 2, settings };
          }
        },
        captureWorkspaceInvocation: () => ({}), ownsWorkspaceInvocation: () => true
      }; export function useAppContext() { return context; }`,
      }),
    );
    await page.goto(url, { waitUntil: "networkidle" });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  test("production console source wires pane measurement", () => {
    expect(readFileSync(`${root}/apps/web/src/components/Composer.tsx`, "utf8")).toContain(
      'responsiveBasis="container"',
    );
  });

  test("rendered fixture measures its composer container", async () => {
    expect(await page.locator(".og-composer").getAttribute("data-og-responsive-basis")).toBe(
      "container",
    );
  });

  test("controls never overlap while resizing the pane", async () => {
    for (const width of [320, 375, 448, 500, 639, 640, 768, 448]) {
      await page.locator("main").evaluate((node, paneWidth) => {
        node.style.width = `${paneWidth}px`;
      }, width);
      const buttons = await page.locator(".og-composer-footer button:visible").all();
      const boxes = await Promise.all(buttons.map((button) => button.boundingBox()));
      const composer = (await page.locator(".og-composer").boundingBox())!;
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i]!;
        expect(a.x).toBeGreaterThanOrEqual(composer.x);
        expect(a.x + a.width).toBeLessThanOrEqual(composer.x + composer.width + 1);
        for (const b of boxes.slice(i + 1)) {
          if (!b) continue;
          const overlaps =
            Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
          expect(overlaps).toBe(false);
        }
      }
      expect(await page.getByRole("button", { name: "More composer actions" }).isVisible()).toBe(
        true,
      );
    }
    await page.screenshot({ path: `${root}/composer-pane-fixed.png` });
  });

  test("shared actions keep repositories, connectors, and variable sets reachable", async () => {
    await page.getByRole("button", { name: "More composer actions" }).click();
    expect(await page.getByRole("menuitem", { name: /Repositories/ }).isVisible()).toBe(true);
    expect(await page.getByRole("menuitem", { name: /Connectors/ }).isVisible()).toBe(true);
    expect(await page.getByRole("menuitem", { name: /Variable sets/ }).isVisible()).toBe(true);
    expect(await page.getByRole("menuitem", { name: "Chat settings", exact: true }).count()).toBe(
      1,
    );
    await page.keyboard.press("Escape");
  });

  test("new-session popovers fit the viewport and preserve navigation and focus", async () => {
    await page.goto(`${page.url().split("?")[0]}?new-session`, { waitUntil: "networkidle" });
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator("main").evaluate((node) => {
        node.style.width = "min(448px, calc(100vw - 32px))";
      });
      for (const name of ["Repositories", "Connectors", "Variable sets"]) {
        const plus = page.getByRole("button", { name: "More composer actions" });
        expect(await page.getByRole("button", { name: "More composer actions" }).count()).toBe(1);
        await plus.click();
        expect(
          await page.getByRole("menuitem", { name: "Chat settings", exact: true }).count(),
        ).toBe(1);
        await page.getByRole("menuitem", { name: new RegExp(name) }).click();
        const dialog = page.getByRole("menu");
        await dialog.waitFor({ state: "visible" });
        const box = (await dialog.boundingBox())!;
        expect(box.height).toBeGreaterThan(name === "Connectors" ? 60 : 120);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        if (name !== "Connectors") {
          const scroll = dialog.getByTestId("picker-scroll");
          expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
          await dialog.getByRole("button", { name: /option 30/ }).scrollIntoViewIfNeeded();
        }
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("menuitem", { name: new RegExp(name) }).click();
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("aria-label") === "More composer actions",
          undefined,
          { timeout: 2_000 },
        );
        expect(await plus.evaluate((node) => document.activeElement === node)).toBe(true);
      }
      await page.getByRole("button", { name: "More composer actions" }).click();
      await page.getByRole("menuitem", { name: /Repositories/ }).click();
      await page.getByRole("menu").waitFor({ state: "visible" });
      await page.screenshot({ path: `${root}/new-session-picker-${viewport.width}.png` });
      await page.keyboard.press("Escape");
    }
  }, 60_000);

  test("settings share white popovers with Back, outside dismissal and a single voice picker", async () => {
    for (const newSession of [false, true]) {
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.goto(`${page.url().split("?")[0]}${newSession ? "?new-session" : ""}`, {
        waitUntil: "networkidle",
      });
      await page.evaluate(() => document.documentElement.setAttribute("data-og-theme", "light"));
      const plus = page.getByRole("button", { name: "More composer actions" });
      await plus.click();
      const menu = page.getByRole("menu");
      const white = await menu.evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(await page.getByRole("menuitem", { name: /Voice model/ }).count()).toBe(0);
      await page.getByRole("menuitem", { name: "Chat settings", exact: true }).click();
      await page.getByLabel("Knowledge", { exact: true }).waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await page.getByRole("button", { name: /close/i }).count()).toBe(0);
      expect(await menu.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(white);
      await page.getByLabel("Knowledge", { exact: true }).selectOption("off");
      await page.screenshot({
        path: `${root}/composer-settings-${newSession ? "new" : "existing"}.png`,
      });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("menuitem", { name: "Chat settings", exact: true }).click();
      expect(await page.getByLabel("Knowledge", { exact: true }).inputValue()).toBe("off");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await plus.click();
      await page.mouse.click(950, 20);
      await menu.waitFor({ state: "hidden" });
      await page.setViewportSize({ width: 390, height: 800 });
      await page.locator("main").evaluate((node) => (node.style.width = "calc(100vw - 48px)"));
      expect(await page.getByRole("button", { name: /choose voice model/i }).count()).toBe(1);
    }
  }, 60_000);
});
