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
    hasTouch = false,
  ): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch });
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

  /** Where the floating navigation buttons sit, relative to the conversation frame. */
  async function navigationGeometry(page: Page) {
    return await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
      const frame = scroller.parentElement!.getBoundingClientRect();
      const read = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return {
          centerOffset: Math.round(box.left + box.width / 2 - (frame.left + frame.width / 2)),
          topGap: Math.round(box.top - frame.top),
          bottomGap: Math.round(frame.bottom - box.bottom),
          width: Math.round(box.width),
          height: Math.round(box.height),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          left: Math.round(box.left - frame.left),
          right: Math.round(frame.right - box.right),
        };
      };
      return {
        coarse: window.matchMedia("(pointer: coarse)").matches,
        latest: read("[data-og-jump-to-latest]"),
        question: read("[data-og-jump-to-question]"),
      };
    });
  }

  for (const width of [1440, 390, 320]) {
    test(`timeline navigation buttons stay small and fixed at ${width}px`, async () => {
      const page = await open(width, "light", "&long", 560, width < 768);
      try {
        await page.locator("[data-og-work-header]").first().waitFor();
        await page.waitForTimeout(600);
        // Read just past the start of the longest exchange: the reader's message
        // is above and the latest activity below, so both navigation buttons show.
        const scroller = page.locator("[data-og-timeline-scroller]");
        await scroller.evaluate((node) => {
          const origin = node.getBoundingClientRect().top - node.scrollTop;
          const prompts = [...node.querySelectorAll<HTMLElement>("[data-og-prompt]")];
          const spans = prompts.map((prompt, index) => ({
            bottom: prompt.getBoundingClientRect().bottom - origin,
            next: (prompts[index + 1]?.getBoundingClientRect().top ?? Infinity) - origin,
          }));
          const longest = spans.reduce((a, b) => (b.next - b.bottom > a.next - a.bottom ? b : a));
          node.scrollTop = Math.round(longest.bottom + 60);
        });
        await page.locator("[data-og-jump-to-latest]").waitFor();
        await page.locator("[data-og-jump-to-question]").waitFor();
        await page.waitForTimeout(300);
        const rest = await navigationGeometry(page);
        await capture(page, `timeline-navigation-${width}-light`);
        const latest = rest.latest!;
        const question = rest.question!;
        // Both buttons are the same small circle, centered in the conversation.
        expect(Math.abs(latest.centerOffset)).toBeLessThanOrEqual(1);
        expect(Math.abs(question.centerOffset)).toBeLessThanOrEqual(1);
        for (const button of [latest, question]) {
          expect(button.width).toBe(32);
          expect(button.height).toBe(32);
        }
        // Back to your message floats just below the pinned work-header strip
        // (taller on coarse pointers), Jump to latest just above the bottom edge.
        expect(question.topGap).toBe(rest.coarse ? 52 : 40);
        expect(latest.bottomGap).toBe(12);

        // Reading on (different rows under the buttons, time passing) never moves them.
        for (const delta of [-90, -90, 60]) {
          await scroller.evaluate((node, by) => {
            node.scrollTop += by;
          }, delta);
          await page.waitForTimeout(700);
          const next = await navigationGeometry(page);
          if (next.latest) expect(next.latest).toEqual(latest);
          if (next.question) expect(next.question).toEqual(question);
        }

        await page.locator("[data-og-jump-to-latest]").click();
        await page.locator("[data-og-jump-to-latest]").waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
