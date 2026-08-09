import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { firefox, type Browser, type Page } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("artifact spreadsheet full-sheet scrolling in Firefox", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const webPort = await freePort();
    baseUrl = `http://127.0.0.1:${webPort}`;
    browser = await firefox.launch({ headless: true });
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "--config",
        `${repoRoot}/packages/react/test/artifact-spreadsheet.vite.config.ts`,
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(baseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    page = await browser.newPage({ viewport: { width: 1_200, height: 800 } });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([web?.stop(), browser?.close()]);
  }, 60_000);

  test("keeps a nonzero bounded spacer and reaches XLSX row 1,048,576", async () => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const fixtureUrl = "/artifact-spreadsheet-scroll-fixture.tsx";
      const { mountFullSpreadsheet } = (await import(/* @vite-ignore */ fixtureUrl)) as {
        mountFullSpreadsheet: (target: HTMLElement) => void;
      };
      document.body.replaceChildren();
      const target = document.createElement("div");
      Object.assign(target.style, { width: "900px", height: "516px" });
      document.body.append(target);
      mountFullSpreadsheet(target);
    });

    const grid = page.getByRole("grid", { name: "Full sheet spreadsheet" });
    await grid.waitFor();
    const initial = await grid.evaluate((element) => {
      const canvas = element.firstElementChild as HTMLElement;
      return {
        ariaRows: element.getAttribute("aria-rowcount"),
        canvasHeight: canvas.getBoundingClientRect().height,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(initial.ariaRows).toBe("1048576");
    expect(initial.canvasHeight).toBe(8_000_000);
    expect(initial.scrollHeight).toBe(8_000_000);
    expect(initial.clientHeight).toBeGreaterThan(0);

    const narrowScrolls = await page.evaluate(async (viewportHeight) => {
      const fixtureUrl = "/artifact-spreadsheet-scroll-fixture.tsx";
      const { physicalScrollForFixtureRow } = (await import(/* @vite-ignore */ fixtureUrl)) as {
        physicalScrollForFixtureRow: (row: number, viewportHeight: number) => number;
      };
      return [
        physicalScrollForFixtureRow(65, viewportHeight),
        physicalScrollForFixtureRow(66, viewportHeight),
      ];
    }, initial.clientHeight);
    await grid.evaluate((element, top) => {
      element.scrollTop = top;
    }, narrowScrolls[0]!);
    const firstNarrowRow = page.locator('[role="row"][aria-rowindex="66"]');
    await firstNarrowRow.waitFor();
    await page.waitForFunction(() => {
      const gridElement = document.querySelector<HTMLElement>('[role="grid"]')!;
      const row = document.querySelector<HTMLElement>('[role="row"][aria-rowindex="66"]')!;
      return (
        Math.abs(row.getBoundingClientRect().top - gridElement.getBoundingClientRect().top - 28) < 4
      );
    });
    const firstPhysicalTop = await grid.evaluate((element) => element.scrollTop);

    await grid.evaluate((element, top) => {
      element.scrollTop = top;
    }, narrowScrolls[1]!);
    const secondNarrowRow = page.locator('[role="row"][aria-rowindex="67"]');
    await secondNarrowRow.waitFor();
    await page.waitForFunction(() => {
      const gridElement = document.querySelector<HTMLElement>('[role="grid"]')!;
      const row = document.querySelector<HTMLElement>('[role="row"][aria-rowindex="67"]')!;
      return (
        Math.abs(row.getBoundingClientRect().top - gridElement.getBoundingClientRect().top - 28) < 4
      );
    });
    const secondPhysicalTop = await grid.evaluate((element) => element.scrollTop);
    expect(secondPhysicalTop - firstPhysicalTop).toBeGreaterThan(3.5);

    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const lastRow = page.locator('[role="row"][aria-rowindex="1048576"]');
    await lastRow.waitFor();

    const terminal = await grid.evaluate((element) => {
      const row = document.querySelector<HTMLElement>('[role="row"][aria-rowindex="1048576"]')!;
      const gridRect = element.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        atPhysicalEnd: element.scrollTop === element.scrollHeight - element.clientHeight,
        rowVisible: rowRect.bottom <= gridRect.bottom + 1 && rowRect.bottom > gridRect.top,
        mountedCells: element.querySelectorAll('[role="gridcell"]').length,
      };
    });
    expect(terminal.atPhysicalEnd).toBe(true);
    expect(terminal.rowVisible).toBe(true);
    expect(terminal.mountedCells).toBeLessThan(1_000);
  }, 30_000);
});
