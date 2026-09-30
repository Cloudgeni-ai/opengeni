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

  async function open(width: number, theme: "dark" | "light"): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 900 } });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico"))
        errors.push(`console: ${message.text()}`);
    });
    await page.goto(`${baseUrl}/artifact-viewer.html?theme=${theme}`);
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

  for (const width of [1440, 390]) {
    test(`Jump to latest never covers conversation rows at ${width}px`, async () => {
      const page = await open(width, "light");
      try {
        await page.waitForTimeout(800);
        await page.locator("[data-og-timeline-scroller]").hover();
        await page.mouse.wheel(0, -200);
        const pill = page.locator("[data-og-jump-to-latest]");
        await pill.waitFor();
        const geometry = await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
          const view = scroller.getBoundingClientRect();
          const button = document
            .querySelector("[data-og-jump-to-latest]")!
            .getBoundingClientRect();
          const covered = [...scroller.querySelectorAll("[data-og-group-key], button, a")]
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => {
              const top = Math.max(rect.top, view.top);
              const bottom = Math.min(rect.bottom, view.bottom);
              return bottom > top && bottom > button.top && top < button.bottom;
            }).length;
          return { covered, pillTop: button.top, viewportBottom: view.bottom };
        });
        // The action sits in its own band below the scrolling viewport.
        expect(geometry.covered).toBe(0);
        expect(geometry.pillTop).toBeGreaterThanOrEqual(geometry.viewportBottom - 0.5);
        await capture(page, `jump-to-latest-${width}-light`);
        await pill.click();
        await pill.waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
