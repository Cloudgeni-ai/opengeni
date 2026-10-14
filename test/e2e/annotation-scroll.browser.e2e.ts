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

  async function afterPaint(page: Page) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }

  async function listState(page: Page) {
    return page.locator("[data-og-annotation-review-list]").evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      const anchor = Array.from(list.querySelectorAll<HTMLElement>("[data-og-annotation-id]")).find(
        (row) => row.getBoundingClientRect().bottom > bounds.top,
      );
      return {
        top: list.scrollTop,
        height: list.clientHeight,
        contentHeight: list.scrollHeight,
        anchorId: anchor?.dataset.ogAnnotationId,
        anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : null,
        documentTop: document.scrollingElement?.scrollTop,
        notes: Array.from(list.querySelectorAll("textarea")).map((note) => note.scrollTop),
      };
    });
  }

  async function wheelList(page: Page) {
    const list = page.locator("[data-og-annotation-review-list]");
    const box = (await list.boundingBox())!;
    // Aim at list padding, outside nested textarea scrollers.
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    // Await listener registration before dispatching the wheel. Resolving the
    // locator concurrently with input can miss movement in a fast browser.
    const observation = await list.evaluateHandle((node) => ({
      settled: new Promise<void>((resolve) => {
        let generation = 0;
        const onScroll = (event: Event) => {
          if (event.target !== node) return;
          const movedGeneration = ++generation;
          const movedTop = node.scrollTop;
          // Firefox's automated wheel need not emit scrollend. Wait for owned
          // movement to survive painted frames, restarting when another scroll arrives.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (generation !== movedGeneration || node.scrollTop !== movedTop) return;
              node.removeEventListener("scroll", onScroll);
              resolve();
            }),
          );
        };
        node.addEventListener("scroll", onScroll);
      }),
    }));
    try {
      await Promise.all([observation.evaluate(({ settled }) => settled), page.mouse.wheel(0, 650)]);
    } finally {
      await observation.dispose();
    }
    return listState(page);
  }

  function expectListMovement(
    before: Awaited<ReturnType<typeof listState>>,
    after: Awaited<ReturnType<typeof listState>>,
  ) {
    expect(after.top).toBeGreaterThan(before.top);
    expect(after.anchorId).not.toBe(before.anchorId);
    expect(after.documentTop).toBe(before.documentTop);
    expect(after.notes).toEqual(before.notes);
  }

  function expectListPreserved(
    before: Awaited<ReturnType<typeof listState>>,
    after: Awaited<ReturnType<typeof listState>>,
  ) {
    expect(after.top).toBeCloseTo(before.top, 0);
    expect(after.anchorId).toBe(before.anchorId);
    expect(after.anchorOffset).toBeCloseTo(before.anchorOffset!, 0);
    expect(after.documentTop).toBe(before.documentTop);
    expect(after.notes).toEqual(before.notes);
  }

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`wheel scrolling the annotation list survives layout and parent renders at ${viewport.width}px`, async () => {
      const page = await openHarness(viewport, 12, true);
      try {
        const initial = await listState(page);
        expect(initial.contentHeight).toBeGreaterThan(initial.height);
        // Native wheel distance varies by engine. Verify navigation instead of a pixel threshold,
        // including a second gesture so repeated layout work cannot pin the list to the first note.
        const scrolled = await wheelList(page);
        expectListMovement(initial, scrolled);
        const advanced = await wheelList(page);
        expectListMovement(scrolled, advanced);
        if (evidenceDir)
          await page.screenshot({ path: `${evidenceDir}/list-scrolled-${viewport.width}.png` });

        await page.setViewportSize({ ...viewport, height: Math.round(viewport.height / 2) });
        await page.waitForFunction(
          (height) =>
            document.querySelector<HTMLElement>("[data-og-annotation-review-list]")!
              .clientHeight !== height,
          advanced.height,
        );
        await afterPaint(page);
        const resized = await listState(page);
        expect(resized.height).toBeLessThan(advanced.height);
        expectListPreserved(advanced, resized);

        const revision = await page.locator("main").getAttribute("data-revision");
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>("main > button")!.click(),
        );
        await page.waitForFunction(
          (previousRevision) =>
            document.querySelector("main")!.getAttribute("data-revision") !== previousRevision,
          revision,
        );
        await afterPaint(page);
        if (evidenceDir)
          await page.screenshot({ path: `${evidenceDir}/list-${viewport.width}.png` });
        expectListPreserved(resized, await listState(page));
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`note autosizing follows edits and available width at ${viewport.width}px`, async () => {
      const page = await openHarness(viewport, 1);
      try {
        const note = page.getByRole("textbox", { name: "Note", exact: true });
        const initialHeight = await note.evaluate((node) => node.clientHeight);
        await note.fill("Short note.");
        await page.waitForFunction(
          (height) => document.querySelector("textarea")!.clientHeight < height,
          initialHeight,
        );
        const shortHeight = await note.evaluate((node) => node.clientHeight);
        const text =
          "Editable notes should grow when words wrap, and shrink again when there is enough space to read them without wrapping.";
        await note.fill(text);
        await page.waitForFunction(
          (height) => document.querySelector("textarea")!.clientHeight > height,
          shortHeight,
        );
        const wide = await note.evaluate((node) => ({
          width: node.clientWidth,
          height: node.clientHeight,
        }));
        await page.setViewportSize({ ...viewport, width: 240 });
        await page.waitForFunction((size) => {
          const textarea = document.querySelector("textarea")!;
          return textarea.clientWidth < size.width && textarea.clientHeight > size.height;
        }, wide);
        const narrowHeight = await note.evaluate((node) => node.clientHeight);
        expect(await note.inputValue()).toBe(text);
        await page.setViewportSize(viewport);
        await page.waitForFunction(
          (height) => document.querySelector("textarea")!.clientHeight < height,
          narrowHeight,
        );
        expect(await note.evaluate((node) => node.clientHeight)).toBeCloseTo(wide.height, 0);
        expect(await note.inputValue()).toBe(text);
        if (evidenceDir)
          await page.screenshot({ path: `${evidenceDir}/note-sizing-${viewport.width}.png` });
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
