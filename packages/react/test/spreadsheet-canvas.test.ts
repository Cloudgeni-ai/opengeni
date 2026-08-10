import { describe, expect, test } from "bun:test";

import {
  SparseSpreadsheetCellIndex,
  SpreadsheetCanvasRenderer,
  spreadsheetCanvasBackingScale,
  spreadsheetCanvasDevicePixelRatio,
  type SpreadsheetCanvasAxis,
  type SpreadsheetCanvasPaint,
} from "../src/components/artifacts/spreadsheet-canvas";

type FakeContext = CanvasRenderingContext2D;

function fakeContext(): FakeContext {
  return {
    fillStyle: "#000",
    strokeStyle: "#000",
    font: "12px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    lineWidth: 1,
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    rect() {},
    clip() {},
    save() {},
    restore() {},
    fillText() {},
    drawImage() {},
    measureText(input: string) {
      return { width: input.length * 7 } as TextMetrics;
    },
  } as unknown as FakeContext;
}

function fakeCanvas(): HTMLCanvasElement & { context: FakeContext } {
  const context = fakeContext();
  const ownerDocument = {
    createElement: () => fakeCanvas(),
  } as unknown as Document;
  return {
    width: 0,
    height: 0,
    style: {},
    ownerDocument,
    context,
    getContext: () => context,
  } as unknown as HTMLCanvasElement & { context: FakeContext };
}

function uniformAxis(count: number, size: number): SpreadsheetCanvasAxis {
  return {
    count,
    total: count * size,
    offsetAt: (index) => Math.max(0, Math.min(count, index)) * size,
    sizeAt: () => size,
    indexAtOffset: (offset) =>
      Math.max(0, Math.min(count - 1, Math.floor(Math.max(0, offset) / size))),
  };
}

function paintInput(canvas: HTMLCanvasElement): SpreadsheetCanvasPaint {
  const cells = new SparseSpreadsheetCellIndex([
    { row: 0, col: 0, value: "retained", formula: null, format: {} },
    { row: 500_000, col: 10_000, value: "sparse", formula: null, format: {} },
  ]);
  return {
    canvas,
    projection: {
      sheetId: "sheet/1",
      generationId: "generation/1",
      revision: 1,
      cells,
      valueAt: (cell) => cell.value,
    },
    rows: uniformAxis(1_048_576, 1),
    columns: uniformAxis(16_384, 1),
    selection: { top: 0, bottom: 0, left: 0, right: 0, focusRow: 0, focusColumn: 0 },
    logicalScrollLeft: 0,
    logicalScrollTop: 0,
    viewportWidth: 880,
    viewportHeight: 480,
    rowHeaderWidth: 48,
    columnHeaderHeight: 28,
    dimensionRevision: 0,
    devicePixelRatio: 2,
    theme: {
      background: "#fff",
      headerBackground: "#eee",
      border: "#ddd",
      foreground: "#111",
      mutedForeground: "#666",
      accent: "#36f",
      error: "#c00",
      fontFamily: "sans-serif",
      fontSize: 12,
      headerFontSize: 11,
      signature: "test-theme",
    },
  };
}

describe("spreadsheet retained canvas", () => {
  test("sparse index range lookup visits only intersecting stored cells", () => {
    const index = new SparseSpreadsheetCellIndex([
      { row: 1, col: 2, value: "a", formula: null, format: {} },
      { row: 1, col: 9, value: "b", formula: null, format: {} },
      { row: 50_000, col: 2, value: "c", formula: null, format: {} },
      { row: 900_000, col: 16_000, value: "d", formula: null, format: {} },
    ]);
    const found: string[] = [];
    index.forEachInRange(0, 10, 0, 5, (cell) => found.push(String(cell.value)));
    expect(index.size).toBe(4);
    expect(found).toEqual(["a"]);
  });

  test("retains overlapping tiles and repaints them only when the generation changes", () => {
    const canvas = fakeCanvas();
    const renderer = new SpreadsheetCanvasRenderer();
    const input = paintInput(canvas);
    const first = renderer.paint(input);
    expect(first).not.toBeNull();
    expect(first!.paintedTiles).toBeGreaterThan(0);
    expect(first!.reusedTiles).toBe(0);
    expect(first!.devicePixelRatio).toBe(2);
    expect(canvas.width).toBe(1_760);
    expect(canvas.height).toBe(960);

    const second = renderer.paint(input);
    expect(second!.paintedTiles).toBe(0);
    expect(second!.reusedTiles).toBe(first!.cacheSize);

    const scrolled = renderer.paint({ ...input, logicalScrollLeft: 260 });
    expect(scrolled!.reusedTiles).toBeGreaterThan(0);
    expect(scrolled!.paintedTiles).toBeGreaterThan(0);

    const revised = renderer.paint({
      ...input,
      projection: { ...input.projection, revision: 2 },
    });
    expect(revised!.reusedTiles).toBe(0);
    expect(revised!.paintedTiles).toBeGreaterThan(0);
  });

  test("never retains a tile assembled from a partial bounded projection", () => {
    const canvas = fakeCanvas();
    const renderer = new SpreadsheetCanvasRenderer();
    const input = paintInput(canvas);
    const bounded = {
      ...input,
      projection: {
        ...input.projection,
        coverage: { rowStart: 0, rowEnd: 100, columnStart: 0, columnEnd: 100 },
      },
    };
    const first = renderer.paint(bounded);
    expect(first!.paintedTiles).toBeGreaterThan(0);
    expect(first!.uncachedTiles).toBe(first!.paintedTiles);
    expect(first!.cacheSize).toBe(0);

    const second = renderer.paint(bounded);
    expect(second!.paintedTiles).toBe(first!.paintedTiles);
    expect(second!.reusedTiles).toBe(0);

    const complete = renderer.paint({
      ...input,
      projection: {
        ...input.projection,
        coverage: { rowStart: 0, rowEnd: 2_000, columnStart: 0, columnEnd: 2_000 },
      },
    });
    expect(complete!.uncachedTiles).toBe(0);
    expect(complete!.cacheSize).toBeGreaterThan(0);
    expect(renderer.paint({ ...input, projection: completeProjection(input) })!.reusedTiles).toBe(
      complete!.cacheSize,
    );
  });

  test("bounds abusive DPR while preserving ordinary Retina density", () => {
    expect(spreadsheetCanvasDevicePixelRatio(2)).toBe(2);
    expect(spreadsheetCanvasDevicePixelRatio(0)).toBe(1);
    expect(spreadsheetCanvasDevicePixelRatio(Number.POSITIVE_INFINITY)).toBe(1);
    expect(spreadsheetCanvasDevicePixelRatio(100)).toBe(4);
  });

  test("caps extreme backing stores without shrinking the CSS viewport", () => {
    const canvas = fakeCanvas();
    const renderer = new SpreadsheetCanvasRenderer();
    const input = {
      ...paintInput(canvas),
      viewportWidth: 100_000,
      viewportHeight: 50_000,
      devicePixelRatio: 4,
    };
    const scale = spreadsheetCanvasBackingScale(
      input.viewportWidth,
      input.viewportHeight,
      input.devicePixelRatio,
    );
    const stats = renderer.paint(input);

    expect(stats?.devicePixelRatio).toBe(scale);
    expect(canvas.width).toBeLessThanOrEqual(8_192);
    expect(canvas.height).toBeLessThanOrEqual(8_192);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000);
    expect(canvas.style.width).toBe("100000px");
    expect(canvas.style.height).toBe("50000px");
    expect(stats!.paintedTiles + stats!.uncachedTiles).toBeLessThanOrEqual(512);
  });
});

function completeProjection(input: SpreadsheetCanvasPaint): SpreadsheetCanvasPaint["projection"] {
  return {
    ...input.projection,
    coverage: { rowStart: 0, rowEnd: 2_000, columnStart: 0, columnEnd: 2_000 },
  };
}
