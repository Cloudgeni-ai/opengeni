import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("embedded artifact viewer", () => {
  let web: StartedProcess;
  let browser: Browser;
  let baseUrl: string;
  const errors: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "demo",
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/artifact-viewer.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 60_000,
      },
    );
    const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, "/usr/local/bin/chromium"].find(
      (candidate): candidate is string => Boolean(candidate && existsSync(candidate)),
    );
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }, 90_000);

  afterAll(async () => {
    try {
      expect(errors).toEqual([]);
    } finally {
      await Promise.allSettled([browser?.close(), web?.stop()]);
    }
  });

  async function open(
    width: number,
    theme: "dark" | "light",
    query = "",
    height = width < 768 ? 844 : 900,
  ): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico"))
        errors.push(`console: ${message.text()}`);
    });
    await page.goto(`${baseUrl}/artifact-viewer.html?theme=${theme}${query}`);
    await page.getByText("Open the dashboard").waitFor();
    return page;
  }

  async function capture(page: Page, name: string) {
    const directory = process.env.OPENGENI_ARTIFACT_VIEWER_EVIDENCE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/${name}.png` });
  }

  for (const theme of ["dark", "light"] as const) {
    test(`agent links and Site previews open the host viewer beside the conversation (${theme})`, async () => {
      const page = await open(1440, theme);
      try {
        // The opengeni-site fence renders the shared inline preview.
        const preview = page.frameLocator('aside iframe[title="Weekly progress"]');
        await preview.getByRole("heading", { name: "Weekly progress" }).waitFor();
        await capture(page, `conversation-1440-${theme}`);

        await page.getByText("Open the dashboard").click();
        const viewer = page.locator("[data-og-artifact-viewer]");
        await viewer.waitFor();
        expect(await viewer.getAttribute("data-og-artifact-viewer")).toBe("site");
        const main = await page.locator("[data-host-main]").boundingBox();
        const box = await viewer.boundingBox();
        expect(Math.round(box!.x)).toBe(Math.round(main!.x));
        expect(Math.round(box!.width)).toBe(Math.round(main!.width));
        await viewer
          .frameLocator('iframe[title="Weekly progress"]')
          .getByRole("heading", { name: "Weekly progress" })
          .waitFor();
        expect(await viewer.locator("[data-og-artifact-header]").textContent()).toContain(
          "Weekly progress",
        );
        await capture(page, `site-viewer-1440-${theme}`);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await viewer.waitFor({ state: "detached" });

        // "Open Site" in the inline preview uses the same host action.
        await page.locator("[data-og-open-site]").click();
        await viewer.waitFor();

        // Editable artifacts need the proxy capability; without it the viewer says so.
        await page.getByText("Open the weekly report").click();
        await page.getByRole("heading", { name: "Artifact viewing isn't enabled" }).waitFor();
        expect(await viewer.getAttribute("data-og-artifact-viewer")).toBe("editable-artifact");

        // Every artifact read is scoped to this conversation for the proxy.
        const requests = await page.evaluate(
          () =>
            (
              window as unknown as {
                artifactViewerHarness: { requests: { sessionHeader?: string }[] };
              }
            ).artifactViewerHarness.requests,
        );
        expect(requests.length).toBeGreaterThan(0);
        expect(new Set(requests.map((request) => request.sessionHeader))).toEqual(
          new Set(["22222222-2222-4222-8222-222222222222"]),
        );
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("phones open the viewer as a full-screen sheet with Back", async () => {
    const page = await open(390, "light");
    try {
      await page.getByText("Open the dashboard").click();
      const sheet = page.locator('[data-host-viewer="sheet"]');
      await sheet.waitFor();
      const box = await sheet.boundingBox();
      expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
      await page.getByRole("button", { name: "Back", exact: true }).waitFor();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
      await capture(page, "site-viewer-390-light");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await sheet.waitFor({ state: "detached" });
      await page.getByText("Open the dashboard").waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);

  // Rects of everything a floating pill must not cover: compact controls (links,
  // buttons, their icons and labels) and the text of full-width row controls
  // such as the active turn's "Working" header. Plain prose is allowed.
  async function coveredControls(page: Page, pillSelector: string) {
    return await page.evaluate((selector) => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
      const view = scroller.getBoundingClientRect();
      const pill = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const hits = (rect: DOMRect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > pill.left &&
        rect.left < pill.right &&
        rect.bottom > pill.top &&
        rect.top < pill.bottom &&
        rect.bottom > view.top &&
        rect.top < view.bottom;
      const covered: string[] = [];
      for (const control of scroller.querySelectorAll<HTMLElement>(
        'a[href], button, [role="button"], input, select, textarea',
      )) {
        const wide = control.getBoundingClientRect().width >= view.width * 0.8;
        // A full-width row draws only its icons and label glyphs.
        const parts: DOMRect[] = [];
        if (!wide) parts.push(control.getBoundingClientRect());
        else {
          for (const icon of control.querySelectorAll("svg, img"))
            parts.push(icon.getBoundingClientRect());
          const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            parts.push(...range.getClientRects());
          }
        }
        for (const part of parts) {
          if (hits(part)) {
            covered.push((control.textContent ?? control.tagName).trim().slice(0, 40));
            break;
          }
        }
      }
      return covered;
    }, pillSelector);
  }

  /** The last reading once it is empty, or after five seconds. */
  async function settled(read: () => Promise<string[]>): Promise<string[]> {
    const deadline = Date.now() + 5_000;
    let value = await read();
    while (value.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      value = await read();
    }
    return value;
  }

  async function scrollerGeometry(page: Page) {
    return await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
      return { clientHeight: scroller.clientHeight, scrollTop: Math.round(scroller.scrollTop) };
    });
  }

  for (const width of [1440, 390]) {
    test(`Jump to latest slides clear of the Working row at ${width}px`, async () => {
      const page = await open(width, "light", "&long");
      try {
        await page.locator("[data-og-work-header]").first().waitFor();
        await page.waitForTimeout(600);
        // Opening an artifact from the reply hands the reader the scroll; back
        // in the conversation, Jump to latest shows while the active turn's
        // Working row still sits at the tip, under the pill's resting spot.
        await page.getByText("Open the dashboard").click();
        await page.getByRole("button", { name: width < 768 ? "Back" : "Close" }).click();
        const pill = page.locator("[data-og-jump-to-latest]");
        await pill.waitFor();
        const before = await scrollerGeometry(page);
        expect(await settled(() => coveredControls(page, "[data-og-jump-to-latest]"))).toEqual([]);
        await page.waitForTimeout(300);
        await capture(page, `jump-pill-${width}-light`);
        // Only the pill moved: the scroller kept its size and the reader's place.
        expect(await scrollerGeometry(page)).toEqual(before);
        await pill.click();
        await pill.waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`Latest question slides clear of an inline Site card's controls at ${width}px`, async () => {
      // Short enough that the card's toolbar can scroll up to the pill.
      const page = await open(width, "light", "&long", 560);
      try {
        await page.locator("[data-og-work-header]").first().waitFor();
        await page.waitForTimeout(600);
        const pillTop = width < 768 ? 56 : 44;
        // Scroll the Site card's toolbar under the pill's resting spot; the
        // question above it leaves the viewport, so the pill appears.
        await page.evaluate((top) => {
          const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const reload = [...scroller.querySelectorAll<HTMLElement>("button")].find(
            (button) => button.getAttribute("aria-label") === "Reload Site",
          )!;
          const target = reload.getBoundingClientRect();
          const view = scroller.getBoundingClientRect();
          scroller.scrollTop += target.top + target.height / 2 - (view.top + top + 16);
          scroller.dispatchEvent(new Event("scroll"));
        }, pillTop);
        const pill = page.locator("[data-og-jump-to-question]");
        await pill.waitFor();
        const before = await scrollerGeometry(page);
        expect(await settled(() => coveredControls(page, "[data-og-question-nav] > div"))).toEqual(
          [],
        );
        await page.waitForTimeout(300);
        await capture(page, `question-pill-${width}-light`);
        expect(await scrollerGeometry(page)).toEqual(before);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
