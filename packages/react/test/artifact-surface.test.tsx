import { describe, expect, test } from "bun:test";
import { Workbook } from "@opengeni/artifact-tool/reference";

import {
  SpreadsheetArtifactSurface,
  SpreadsheetGrid,
  type SpreadsheetCommit,
  type SpreadsheetSelection,
} from "../src/artifacts-spreadsheet";
import {
  SpreadsheetProjectionGrid,
  type SpreadsheetGridProjection,
  type SpreadsheetViewport,
} from "../src/artifacts-spreadsheet";
import { SparseSpreadsheetCellIndex } from "../src/components/artifacts/spreadsheet-canvas";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function makeWorkbook() {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("Data");
  sheet.getRange("A1:C2").values = [
    [2, 3, null],
    ["alpha", true, null],
  ];
  sheet.getRange("C1").formulas = [["=A1+B1"]];
  return { workbook, sheet };
}

function replaceInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function indexedPhysicalScrollForLogical(
  logicalOffset: number,
  overrides: readonly (readonly [number, number])[],
  viewportSize: number,
): number {
  const count = 1_048_576;
  const defaultSize = 24;
  const headerSize = 28;
  const physicalTotal = 8_000_000;
  const total =
    count * defaultSize + overrides.reduce((delta, [, size]) => delta + size - defaultSize, 0);
  const physicalMax = physicalTotal - viewportSize;
  const logicalMax = headerSize + total - viewportSize;
  const baseItemSpan = Math.min(4, (physicalTotal - headerSize) / count);
  const proportionalSpan = physicalTotal - headerSize - baseItemSpan * count;

  const locate = (input: number) => {
    const target = Math.max(0, Math.min(total - 1, input));
    let index = 0;
    let start = 0;
    for (const [overrideIndex, overrideSize] of overrides) {
      const defaultRunEnd = start + (overrideIndex - index) * defaultSize;
      if (target < defaultRunEnd) {
        const distance = Math.floor((target - start) / defaultSize);
        return {
          index: index + distance,
          start: start + distance * defaultSize,
          size: defaultSize,
        };
      }
      start = defaultRunEnd;
      index = overrideIndex;
      if (target < start + overrideSize) return { index, start, size: overrideSize };
      start += overrideSize;
      index += 1;
    }
    const distance = Math.floor((target - start) / defaultSize);
    return { index: index + distance, start: start + distance * defaultSize, size: defaultSize };
  };
  const rawAt = (input: number) => {
    const logical = Math.max(0, Math.min(total, input));
    if (logical === total) return count * baseItemSpan + proportionalSpan;
    const location = locate(logical);
    const rawStart = location.index * baseItemSpan + (location.start / total) * proportionalSpan;
    const rawSize = baseItemSpan + (location.size / total) * proportionalSpan;
    return rawStart + ((logical - location.start) / location.size) * rawSize;
  };

  return (rawAt(logicalOffset) / rawAt(logicalMax)) * physicalMax;
}

describe("artifact spreadsheet surface", () => {
  test("generic projection keeps canonical state external and reports bounded viewports", async () => {
    const values = new Map<string, string>([["0:0", "before"]]);
    const viewportEvents: SpreadsheetViewport[] = [];
    let resolveCommit: (() => void) | undefined;
    const commits: SpreadsheetCommit[] = [];
    const makeProjection = (revision: number): SpreadsheetGridProjection => {
      const cells = new SparseSpreadsheetCellIndex([
        { row: 0, col: 0, value: values.get("0:0"), formula: null, format: {} },
      ]);
      return {
        sheetId: "projected-sheet",
        sheetName: "Projected",
        generationId: null,
        revision,
        rowCount: 1_048_576,
        columnCount: 16_384,
        cells,
        valueAt: (cell) => cell.value,
        readCell: (row, col) => {
          const value = values.get(`${row}:${col}`) ?? null;
          return { value, input: value ?? "", format: {} };
        },
      };
    };
    const commit = (next: SpreadsheetCommit) => {
      commits.push(next);
      return new Promise<void>((resolve) => {
        resolveCommit = resolve;
      });
    };
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={makeProjection(1)}
        commit={commit}
        clear={() => {}}
        onViewportChange={(viewport) => viewportEvents.push(viewport)}
      />,
    );
    await flush(20);

    const grid = rendered.container.querySelector('[role="grid"]') as HTMLDivElement;
    expect(grid.getAttribute("aria-label")).toBe("Projected spreadsheet");
    expect(viewportEvents.at(-1)).toMatchObject({
      sheetId: "projected-sheet",
      rowStart: 0,
      columnStart: 0,
    });
    expect(viewportEvents.at(-1)!.rowEnd).toBeLessThan(100);
    expect(viewportEvents.at(-1)!.columnEnd).toBeLessThan(100);

    await actRun(() => grid.focus());
    await actRun(() =>
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const editor = rendered.container.querySelector('[aria-label="Edit A1"]') as HTMLInputElement;
    await actRun(() => replaceInputValue(editor, "after"));
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();
    expect(commits).toEqual([
      {
        sheetId: "projected-sheet",
        cell: { row: 0, col: 0 },
        input: "after",
        kind: "value",
      },
    ]);
    expect(values.get("0:0")).toBe("before");
    expect(rendered.container.firstElementChild?.getAttribute("data-og-command-state")).toBe(
      "pending",
    );
    expect(grid.getAttribute("aria-busy")).toBe("true");
    expect(
      (rendered.container.querySelector('[aria-label="Formula or value"]') as HTMLInputElement)
        .value,
    ).toBe("after");

    await actRun(() => resolveCommit?.());
    await flush();
    expect(rendered.container.firstElementChild?.getAttribute("data-og-command-state")).toBe(
      "idle",
    );
    values.set("0:0", "after");
    await rendered.rerender(
      <SpreadsheetProjectionGrid
        projection={makeProjection(2)}
        commit={commit}
        clear={() => {}}
        onViewportChange={(viewport) => viewportEvents.push(viewport)}
      />,
    );
    await flush();
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("after");

    await rendered.unmount();
  });

  test("generic projection reports command failure and retries without stale optimistic state", async () => {
    const value = { current: "before" };
    const projection = (revision: number): SpreadsheetGridProjection => {
      const cells = new SparseSpreadsheetCellIndex([
        { row: 0, col: 0, value: value.current, formula: null, format: {} },
      ]);
      return {
        sheetId: "retry-sheet",
        sheetName: "Retry",
        generationId: "retry-generation",
        revision,
        rowCount: 100,
        columnCount: 20,
        cells,
        valueAt: (cell) => cell.value,
        readCell: (row, col) => ({
          value: row === 0 && col === 0 ? value.current : null,
          input: row === 0 && col === 0 ? value.current : "",
          format: {},
        }),
      };
    };
    const commits: SpreadsheetCommit[] = [];
    let attempt = 0;
    let resolveRetry: (() => void) | undefined;
    const rendered = await renderComponent(
      <SpreadsheetProjectionGrid
        projection={projection(1)}
        commit={(command) => {
          commits.push(command);
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error("Write failed"));
          return new Promise<void>((resolve) => {
            resolveRetry = resolve;
          });
        }}
      />,
    );
    await flush();
    const grid = rendered.container.querySelector<HTMLDivElement>('[role="grid"]')!;
    await actRun(() => grid.focus());
    await actRun(() =>
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const editor = rendered.container.querySelector<HTMLInputElement>('[aria-label="Edit A1"]')!;
    await actRun(() => replaceInputValue(editor, "after"));
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();

    expect(rendered.container.firstElementChild?.getAttribute("data-og-command-state")).toBe(
      "error",
    );
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Write failed",
    );
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')?.value,
    ).toBe("before");

    await actRun(() =>
      rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await flush();
    expect(commits).toHaveLength(2);
    expect(rendered.container.firstElementChild?.getAttribute("data-og-command-state")).toBe(
      "pending",
    );
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')?.value,
    ).toBe("after");

    await actRun(() => resolveRetry?.());
    value.current = "after";
    await rendered.rerender(
      <SpreadsheetProjectionGrid projection={projection(2)} commit={() => {}} />,
    );
    await flush();
    expect(rendered.container.firstElementChild?.getAttribute("data-og-command-state")).toBe(
      "idle",
    );
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await rendered.unmount();
  });

  test("two-axis virtualization mounts a bounded viewport for a large sheet", async () => {
    const { workbook, sheet } = makeWorkbook();
    const rendered = await renderComponent(
      <SpreadsheetGrid
        workbook={workbook}
        worksheet={sheet}
        rowCount={100_000}
        columnCount={1_000}
      />,
    );
    await flush();

    const grid = rendered.container.querySelector('[role="grid"]');
    const cells = rendered.container.querySelectorAll('[role="gridcell"]');
    expect(grid?.getAttribute("aria-rowcount")).toBe("100000");
    expect(grid?.getAttribute("aria-colcount")).toBe("1000");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(1_000);
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("2");
    expect(
      [...(grid?.children ?? [])].some((child) => child.getAttribute("role") === "rowgroup"),
    ).toBe(true);
    expect(
      rendered.container
        .querySelector('[role="columnheader"]')
        ?.parentElement?.getAttribute("role"),
    ).toBe("row");

    const viewport = grid as HTMLDivElement;
    viewport.scrollTop = 500_000;
    viewport.scrollLeft = 50_000;
    await actRun(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    const activeId = viewport.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(rendered.container.querySelector(`[id="${activeId}"]`)).toBeTruthy();
    expect(rendered.container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(1_000);

    await rendered.unmount();
  });

  test("full XLSX bounds index sparse dimensions without scanning a million addresses", async () => {
    const { workbook, sheet } = makeWorkbook();
    const customRow = 500_000;
    const customColumn = 10_000;
    sheet.setRowHeight(customRow, 41);
    sheet.setRowHeight(700_000, 12);
    sheet.setColumnWidth(customColumn, 140);
    sheet.setColumnWidth(12_000, 50);
    expect(sheet.defaultRowHeight).toBe(24);
    expect(sheet.defaultColumnWidth).toBe(96);
    const detachedRowEntry = [...sheet.rowHeightEntries()][0] as [number, number];
    detachedRowEntry[1] = 999;
    expect(sheet.rowHeight(customRow)).toBe(41);

    let rowHeightReads = 0;
    let columnWidthReads = 0;
    let cellReads = 0;
    let usedRangeReads = 0;
    let rowDimensionEntries = 0;
    let columnDimensionEntries = 0;
    const readRowHeight = sheet.rowHeight.bind(sheet);
    const readColumnWidth = sheet.columnWidth.bind(sheet);
    const readCell = sheet.cellData.bind(sheet);
    const readUsedRange = sheet.usedRangeAddress.bind(sheet);
    const readRowEntries = sheet.rowHeightEntries.bind(sheet);
    const readColumnEntries = sheet.columnWidthEntries.bind(sheet);
    Object.defineProperties(sheet, {
      rowHeight: {
        configurable: true,
        value: (row: number) => {
          rowHeightReads += 1;
          return readRowHeight(row);
        },
      },
      columnWidth: {
        configurable: true,
        value: (column: number) => {
          columnWidthReads += 1;
          return readColumnWidth(column);
        },
      },
      cellData: {
        configurable: true,
        value: (row: number, column: number) => {
          cellReads += 1;
          return readCell(row, column);
        },
      },
      usedRangeAddress: {
        configurable: true,
        value: (valuesOnly?: boolean) => {
          usedRangeReads += 1;
          return readUsedRange(valuesOnly);
        },
      },
      rowHeightEntries: {
        configurable: true,
        value: function* () {
          for (const entry of readRowEntries()) {
            rowDimensionEntries += 1;
            yield entry;
          }
        },
      },
      columnWidthEntries: {
        configurable: true,
        value: function* () {
          for (const entry of readColumnEntries()) {
            columnDimensionEntries += 1;
            yield entry;
          }
        },
      },
    });

    const rendered = await renderComponent(
      <SpreadsheetGrid workbook={workbook} worksheet={sheet} />,
    );
    await flush();

    const grid = rendered.container.querySelector('[role="grid"]') as HTMLDivElement;
    const canvas = grid.firstElementChild as HTMLDivElement;
    expect(grid.getAttribute("aria-rowcount")).toBe("1048576");
    expect(grid.getAttribute("aria-colcount")).toBe("16384");
    expect(canvas.style.height).toBe("8000000px");
    expect(canvas.style.width).toBe("1572910px");
    expect(rowHeightReads).toBe(0);
    expect(columnWidthReads).toBe(0);
    expect(rowDimensionEntries).toBe(2);
    expect(columnDimensionEntries).toBe(2);
    expect(usedRangeReads).toBe(0);
    expect(cellReads).toBeLessThan(5_000);
    expect(rendered.container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(1_000);

    await actRun(() => {
      sheet.getRange("A1").format = { fill: "#eef2ff" };
    });
    await flush();
    expect(rowDimensionEntries).toBe(2);
    expect(columnDimensionEntries).toBe(2);

    grid.scrollTop = indexedPhysicalScrollForLogical(
      customRow * 24,
      [
        [customRow, 41],
        [700_000, 12],
      ],
      480,
    );
    grid.scrollLeft = customColumn * 96;
    await actRun(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    const customRowElement = rendered.container.querySelector(
      `[role="row"][aria-rowindex="${customRow + 1}"]`,
    ) as HTMLDivElement;
    const customColumnElement = rendered.container.querySelector(
      `[role="columnheader"][aria-colindex="${customColumn + 1}"]`,
    ) as HTMLDivElement;
    expect(customRowElement).toBeTruthy();
    expect(customRowElement.style.height).toBe("41px");
    expect(
      Math.abs(Number.parseFloat(customRowElement.style.top) - grid.scrollTop - 28),
    ).toBeLessThan(0.001);
    expect(customColumnElement).toBeTruthy();
    expect(customColumnElement.style.width).toBe("140px");
    expect(
      Math.abs(Number.parseFloat(customColumnElement.style.left) - grid.scrollLeft - 48),
    ).toBeLessThan(0.001);
    expect(rowHeightReads).toBe(0);
    expect(columnWidthReads).toBe(0);
    expect(usedRangeReads).toBe(0);
    expect(cellReads).toBeLessThan(5_000);
    expect(rendered.container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(1_000);

    grid.scrollTop = 8_000_000 - 480;
    grid.scrollLeft = 1_572_910 - 880;
    await actRun(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    expect(rendered.container.querySelector('[role="row"][aria-rowindex="1048576"]')).toBeTruthy();
    expect(
      rendered.container.querySelector('[role="columnheader"][aria-colindex="16384"]'),
    ).toBeTruthy();
    expect(usedRangeReads).toBe(0);
    expect(rendered.container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(1_000);

    await rendered.unmount();
  });

  test("extreme custom dimensions retain distinct physical addresses for ordinary rows", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Extreme");
    const overrides = Array.from({ length: 65 }, (_, row) => [row, 1_000_000] as const);
    for (const [row, height] of overrides) sheet.setRowHeight(row, height);
    const rendered = await renderComponent(
      <SpreadsheetGrid workbook={workbook} worksheet={sheet} />,
    );
    await flush();

    const grid = rendered.container.querySelector('[role="grid"]') as HTMLDivElement;
    const row65Scroll = indexedPhysicalScrollForLogical(65_000_000, overrides, 480);
    const row66Scroll = indexedPhysicalScrollForLogical(65_000_024, overrides, 480);
    expect(row66Scroll - row65Scroll).toBeGreaterThan(3.5);

    grid.scrollTop = row65Scroll;
    await actRun(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    const firstNarrowRow = rendered.container.querySelector(
      '[role="row"][aria-rowindex="66"]',
    ) as HTMLDivElement;
    expect(firstNarrowRow).toBeTruthy();
    expect(firstNarrowRow.style.height).toBe("24px");
    expect(
      Math.abs(Number.parseFloat(firstNarrowRow.style.top) - grid.scrollTop - 28),
    ).toBeLessThan(0.001);

    grid.scrollTop = row66Scroll;
    await actRun(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    const secondNarrowRow = rendered.container.querySelector(
      '[role="row"][aria-rowindex="67"]',
    ) as HTMLDivElement;
    expect(secondNarrowRow).toBeTruthy();
    expect(secondNarrowRow.style.height).toBe("24px");
    expect(
      Math.abs(Number.parseFloat(secondNarrowRow.style.top) - grid.scrollTop - 28),
    ).toBeLessThan(0.001);

    await rendered.unmount();
  });

  test("malformed subpixel dimensions cannot expand the mounted grid", async () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Defensive projection");
    Object.defineProperty(sheet, "rowHeightEntries", {
      configurable: true,
      value: function* () {
        for (let row = 0; row < 10_000; row += 1) yield [row, 0.000_1] as const;
      },
    });

    const rendered = await renderComponent(
      <SpreadsheetGrid workbook={workbook} worksheet={sheet} />,
    );
    await flush();

    expect(rendered.container.querySelectorAll('[role="row"]').length).toBeLessThanOrEqual(512);
    expect(rendered.container.querySelectorAll('[role="gridcell"]').length).toBeLessThanOrEqual(
      2_048,
    );

    await rendered.unmount();
  });

  test("keyboard selection and the active-cell editor commit formulas to the model", async () => {
    const { workbook, sheet } = makeWorkbook();
    const selections: SpreadsheetSelection[] = [];
    const commits: SpreadsheetCommit[] = [];
    const rendered = await renderComponent(
      <SpreadsheetGrid
        workbook={workbook}
        worksheet={sheet}
        onSelectionChange={(selection) => selections.push(selection)}
        onCommit={(commit) => commits.push(commit)}
      />,
    );
    await flush();

    const grid = rendered.container.querySelector('[role="grid"]') as HTMLDivElement;
    await actRun(() => grid.focus());
    await actRun(() =>
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush();
    expect(rendered.container.querySelector('[aria-label="Selected range"]')?.textContent).toBe(
      "B1",
    );
    expect(selections.at(-1)?.focus).toEqual({ row: 0, col: 1 });

    await actRun(() =>
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();
    const editor = rendered.container.querySelector('[aria-label="Edit B1"]') as HTMLInputElement;
    expect(editor).toBeTruthy();
    await actRun(() => replaceInputValue(editor, "=A1*10"));
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await flush();

    expect(sheet.getRange("B1").formulas).toEqual([["=A1*10"]]);
    expect(sheet.getRange("B1").values).toEqual([[20]]);
    expect(commits).toEqual([
      {
        sheetId: sheet.id,
        cell: { row: 0, col: 1 },
        input: "=A1*10",
        kind: "formula",
      },
    ]);
    expect(rendered.container.querySelector('[data-og-cell="B1"]')?.textContent).toBe("20");

    await rendered.unmount();
  });

  test("external workbook changes project immediately without replacing the workbook", async () => {
    const { workbook, sheet } = makeWorkbook();
    const rendered = await renderComponent(
      <SpreadsheetGrid workbook={workbook} worksheet={sheet} />,
    );
    await flush();

    const revisionBeforeFocus = workbook.revision;
    const formulaBar = rendered.container.querySelector(
      '[aria-label="Formula or value"]',
    ) as HTMLInputElement;
    const grid = rendered.container.querySelector('[role="grid"]') as HTMLDivElement;
    await actRun(() => formulaBar.focus());
    await actRun(() => grid.focus());
    await flush();
    expect(workbook.revision).toBe(revisionBeforeFocus);

    expect(rendered.container.querySelector('[data-og-cell="B2"]')?.textContent).toBe("TRUE");
    await actRun(() => {
      sheet.getRange("B2").values = [[42]];
      sheet.setRowHeight(1, 33);
    });
    await flush();
    expect(rendered.container.querySelector('[data-og-cell="B2"]')?.textContent).toBe("42");
    expect(
      (rendered.container.querySelector('[role="row"][aria-rowindex="2"]') as HTMLDivElement).style
        .height,
    ).toBe("33px");

    await rendered.unmount();
  });

  test("read-only mode keeps navigation live while rejecting every edit affordance", async () => {
    const { workbook, sheet } = makeWorkbook();
    const revision = workbook.revision;
    const rendered = await renderComponent(
      <SpreadsheetGrid workbook={workbook} worksheet={sheet} readOnly />,
    );
    await flush();

    const grid = rendered.container.querySelector('[role="grid"]') as HTMLDivElement;
    const formulaBar = rendered.container.querySelector(
      '[aria-label="Formula or value"]',
    ) as HTMLInputElement;
    expect(grid.getAttribute("aria-readonly")).toBe("true");
    expect(formulaBar.readOnly).toBe(true);
    await actRun(() => grid.focus());
    await actRun(() =>
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })),
    );
    await actRun(() =>
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true })),
    );
    await flush();
    expect(sheet.getRange("A1").values).toEqual([[2]]);
    expect(workbook.revision).toBe(revision);
    expect(rendered.container.querySelector('[aria-label="Edit A1"]')).toBeNull();

    await rendered.unmount();
  });

  test("modality shell switches worksheets and preserves one authoritative workbook", async () => {
    const { workbook } = makeWorkbook();
    const second = workbook.worksheets.add("Forecast");
    second.getRange("A1").values = [["Next quarter"]];
    const rendered = await renderComponent(
      <SpreadsheetArtifactSurface workbook={workbook} title="Operating plan" />,
    );
    await flush();

    expect(
      rendered.container.querySelector("section")?.getAttribute("data-og-artifact-modality"),
    ).toBe("spreadsheet");
    expect(rendered.container.querySelector("section")?.classList.contains("og-root")).toBe(true);
    expect(rendered.container.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe(
      "Data spreadsheet",
    );
    const forecastTab = [
      ...rendered.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((button) => button.textContent === "Forecast");
    await actRun(() => forecastTab?.click());
    await flush();
    expect(rendered.container.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe(
      "Forecast spreadsheet",
    );
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe(
      "Next quarter",
    );
    expect(workbook.worksheets.getActiveWorksheet()).toBe(second);

    await rendered.unmount();
  });
});
