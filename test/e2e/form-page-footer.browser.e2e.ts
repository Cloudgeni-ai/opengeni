import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";

// A FormPage's footer is the bottom of its card: nothing of the form shows
// below it. On the agent sign-in page (a FormPage in a padded scroller) the
// sticky footer used to stop above the visible bottom, with the permission
// list scrolling on underneath it.

type Layout = {
  footerTop: number;
  footerBottom: number;
  footerPosition: string;
  visibleBottom: number;
  bodyBottom: number;
  /** Form content that starts below the footer, inside the visible area. */
  below: string[];
};

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "short", width: 1280, height: 480 },
  { name: "narrow", width: 700, height: 640 },
  { name: "phone", width: 390, height: 760 },
] as const;

describe("FormPage footer", () => {
  let browser: Browser;
  let web: StartedProcess;
  let url: string;

  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/test/form-page-footer.html`;
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
        cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
        ready: async () =>
          (await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  const layout = (page: Page, scroll: "top" | "middle" | "end") =>
    page.evaluate((to) => {
      const footer = document.querySelector<HTMLElement>("form footer")!;
      const body = document.querySelector<HTMLElement>("[data-slot=form-body]")!;
      let scroller: HTMLElement | null = footer.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement;
      }
      const max = scroller!.scrollHeight - scroller!.clientHeight;
      scroller!.scrollTop = to === "top" ? 0 : to === "middle" ? max / 2 : max;
      const box = footer.getBoundingClientRect();
      const visibleBottom = Math.min(scroller!.getBoundingClientRect().bottom, innerHeight);
      const below = [...body.querySelectorAll<HTMLElement>("label, input, button, p, span")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.height > 0 && rect.top >= box.bottom - 0.5 && rect.top < visibleBottom;
        })
        .map((element) => element.textContent?.trim() || element.tagName);
      return {
        footerTop: box.top,
        footerBottom: box.bottom,
        footerPosition: getComputedStyle(footer).position,
        visibleBottom,
        bodyBottom: body.getBoundingClientRect().bottom,
        below,
      } satisfies Layout;
    }, scroll);

  for (const view of ["consent", "content"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${view}, ${scheme}: no field shows below the footer`, async () => {
        for (const viewport of VIEWPORTS) {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
          });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${url}?view=${view}`);
          await page.locator("form footer button[type=submit]").waitFor({ timeout: 90_000 });
          for (const scroll of ["top", "middle", "end"] as const) {
            const at = { view, scheme, viewport: viewport.name, scroll };
            const result = await layout(page, scroll);
            expect({ ...at, below: result.below }).toEqual({ ...at, below: [] });
            if (result.footerPosition !== "sticky" || scroll === "end") {
              // In the flow, or at the end of the form: right after its last field.
              expect(result.footerTop).toBeGreaterThanOrEqual(result.bodyBottom - 0.5);
            } else {
              // Stuck while the form goes on: it rests on the visible bottom edge.
              expect({ ...at, bottom: Math.round(result.footerBottom) }).toEqual({
                ...at,
                bottom: Math.round(result.visibleBottom),
              });
            }
          }
          expect(errors).toEqual([]);
          await page.close();
        }
      }, 180_000);
    }
  }
});
