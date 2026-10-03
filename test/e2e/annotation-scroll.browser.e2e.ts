import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";

const demoRoot = new URL("../../packages/react/demo", import.meta.url).pathname;
const evidenceDir = process.env.ANNOTATION_SCROLL_ARTIFACT_DIR;

describe("editable annotation scroll ownership", () => {
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
        ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    const executablePath = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      "/opt/google/chrome/chrome",
      "/usr/local/bin/chromium",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    const engine = process.env.ANNOTATION_SCROLL_BROWSER_ENGINE ?? "chromium";
    browser =
      engine === "webkit"
        ? await webkit.launch()
        : engine === "firefox"
          ? await firefox.launch()
          : await chromium.launch({
              ...(executablePath ? { executablePath } : {}),
              args: ["--no-sandbox", "--disable-dev-shm-usage"],
            });
    if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  });

  async function openHarness(
    viewport: { width: number; height: number },
    count = 12,
    focus = false,
  ): Promise<Page> {
    const page = await browser.newPage({ viewport });
    await page.goto(
      `${baseUrl}/annotation-scroll-test.html?count=${count}${focus ? "&focus=1" : ""}`,
    );
    if (!focus)
      await page
        .getByRole("button", {
          name: `Review ${count} ${count === 1 ? "annotation" : "annotations"}`,
          exact: true,
        })
        .click();
    await page.locator("[data-og-annotation-review-list]").waitFor();
    return page;
  }

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`wheel scrolling the annotation list survives layout and parent renders at ${viewport.width}px`, async () => {
      const page = await openHarness(viewport, 12, true);
      try {
        const list = page.locator("[data-og-annotation-review-list]");
        const box = (await list.boundingBox())!;
        // Aim at the list padding, outside nested textarea scrollers.
        await page.mouse.move(box.x + 4, box.y + box.height / 2);
        await page.mouse.wheel(0, 650);
        await page.waitForTimeout(350);
        const scrolled = await list.evaluate((node) => node.scrollTop);
        if (evidenceDir)
          await page.screenshot({ path: `${evidenceDir}/list-scrolled-${viewport.width}.png` });
        expect(scrolled).toBeGreaterThan(300);
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>("main > button")!.click(),
        );
        await page.waitForTimeout(100);
        if (evidenceDir)
          await page.screenshot({ path: `${evidenceDir}/list-${viewport.width}.png` });
        expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(scrolled, 0);
      } finally {
        await page.close();
      }
    }, 30_000);

    for (const count of [1, 12])
      test(`wheel scrolling a long note survives list position updates and editing with ${count} annotations at ${viewport.width}px`, async () => {
        const page = await openHarness(viewport, count);
        try {
          const note = page.getByRole("textbox", { name: "Note", exact: true }).first();
          await note.focus();
          await note.hover();
          await page.mouse.wheel(0, 220);
          await page.waitForTimeout(350);
          const scrolled = await note.evaluate((node) => node.scrollTop);
          if (evidenceDir)
            await page.screenshot({ path: `${evidenceDir}/note-${count}-${viewport.width}.png` });
          expect(scrolled).toBeGreaterThan(100);
          // Put the caret in the visible scrolled note and type without changing its height.
          await note.click();
          await page.keyboard.type("Edited ");
          await page.waitForTimeout(100);
          expect(await note.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
        } finally {
          await page.close();
        }
      }, 30_000);
  }
});
