const TILE_SIZE = 256;
const MAX_CACHE_PHYSICAL_PIXELS = 32_000_000;
const MAX_CACHE_TILES = 96;
const MAX_DEVICE_PIXEL_RATIO = 4;
const MAX_AXIS_MARKS_PER_PAINT = 8_192;
const MAX_CANVAS_EDGE = 8_192;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_TILES_PER_PAINT = 512;

export type SpreadsheetCanvasCellFormat = {
  fill?: string | undefined;
  font?:
    | {
        name?: string | undefined;
        size?: number | undefined;
        bold?: boolean | undefined;
        italic?: boolean | undefined;
        underline?: boolean | undefined;
        color?: string | undefined;
      }
    | undefined;
  horizontalAlignment?: "left" | "center" | "right" | "justify" | undefined;
  verticalAlignment?: "top" | "center" | "bottom" | undefined;
  wrapText?: boolean | undefined;
};

/** One sparse, already-authorized cell projected into the renderer. */
export type SpreadsheetCanvasCell = {
  row: number;
  col: number;
  value: unknown;
  formula?: string | null | undefined;
  format: SpreadsheetCanvasCellFormat;
};

export type SpreadsheetCanvasCoverage = {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
};

/**
 * A bounded value projection. `coverage` is end-exclusive; omitting it means
 * the source can answer for the entire sheet. A session-backed adapter can
 * replace this object as viewport subscriptions advance without making the
 * React layer or renderer own the canonical workbook model.
 */
export type SpreadsheetCanvasProjection = {
  sheetId: string;
  generationId: string | null;
  revision: string | number;
  coverage?: SpreadsheetCanvasCoverage | undefined;
  cells: SpreadsheetCanvasCellSource;
  valueAt: (cell: SpreadsheetCanvasCell) => unknown;
};

export type SpreadsheetCanvasCellSource = {
  forEachInRange: (
    rowStart: number,
    rowEnd: number,
    columnStart: number,
    columnEnd: number,
    visit: (cell: SpreadsheetCanvasCell) => void,
  ) => void;
};

export type SpreadsheetCanvasAxis = {
  count: number;
  total: number;
  offsetAt: (index: number) => number;
  sizeAt: (index: number) => number;
  indexAtOffset: (offset: number) => number;
};

export type SpreadsheetCanvasSelection = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  focusRow: number;
  focusColumn: number;
};

export type SpreadsheetCanvasTheme = {
  background: string;
  headerBackground: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  accent: string;
  error: string;
  fontFamily: string;
  fontSize: number;
  headerFontSize: number;
  signature: string;
};

export type SpreadsheetCanvasPaint = {
  canvas: HTMLCanvasElement;
  projection: SpreadsheetCanvasProjection;
  rows: SpreadsheetCanvasAxis;
  columns: SpreadsheetCanvasAxis;
  selection: SpreadsheetCanvasSelection;
  logicalScrollLeft: number;
  logicalScrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  rowHeaderWidth: number;
  columnHeaderHeight: number;
  dimensionRevision: string | number;
  devicePixelRatio: number;
  theme: SpreadsheetCanvasTheme;
};

export type SpreadsheetCanvasPaintStats = {
  cacheSize: number;
  paintedTiles: number;
  reusedTiles: number;
  uncachedTiles: number;
  devicePixelRatio: number;
};

type IndexedRow = {
  row: number;
  cells: SpreadsheetCanvasCell[];
};

type Tile = {
  canvas: HTMLCanvasElement;
  lastUsed: number;
};

/**
 * A row-major sparse index over stored worksheet cells. Empty cells never enter
 * this structure, so a tile query costs O(log k + v), where v is the number of
 * stored cells intersecting that tile.
 */
export class SparseSpreadsheetCellIndex {
  readonly size: number;
  private readonly rows: IndexedRow[];

  constructor(entries: Iterable<SpreadsheetCanvasCell>) {
    const sorted = [...entries].sort((left, right) => left.row - right.row || left.col - right.col);
    this.size = sorted.length;
    this.rows = [];
    for (const entry of sorted) {
      const previous = this.rows.at(-1);
      if (previous?.row === entry.row) previous.cells.push(entry);
      else this.rows.push({ row: entry.row, cells: [entry] });
    }
  }

  forEachInRange(
    rowStart: number,
    rowEnd: number,
    columnStart: number,
    columnEnd: number,
    visit: (cell: SpreadsheetCanvasCell) => void,
  ): void {
    let rowIndex = lowerBound(this.rows, rowStart, (row) => row.row);
    while (rowIndex < this.rows.length) {
      const row = this.rows[rowIndex]!;
      if (row.row >= rowEnd) break;
      let cellIndex = lowerBound(row.cells, columnStart, (cell) => cell.col);
      while (cellIndex < row.cells.length) {
        const cell = row.cells[cellIndex]!;
        if (cell.col >= columnEnd) break;
        visit(cell);
        cellIndex += 1;
      }
      rowIndex += 1;
    }
  }
}

function lowerBound<T>(
  values: readonly T[],
  target: number,
  valueAt: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (valueAt(values[middle]!) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function coverageContains(
  coverage: SpreadsheetCanvasCoverage | undefined,
  query: SpreadsheetCanvasCoverage,
): boolean {
  return (
    coverage === undefined ||
    (coverage.rowStart <= query.rowStart &&
      coverage.rowEnd >= query.rowEnd &&
      coverage.columnStart <= query.columnStart &&
      coverage.columnEnd >= query.columnEnd)
  );
}

function intersectCoverage(
  query: SpreadsheetCanvasCoverage,
  coverage: SpreadsheetCanvasCoverage | undefined,
): SpreadsheetCanvasCoverage | null {
  if (coverage === undefined) return query;
  const intersection = {
    rowStart: Math.max(query.rowStart, coverage.rowStart),
    rowEnd: Math.min(query.rowEnd, coverage.rowEnd),
    columnStart: Math.max(query.columnStart, coverage.columnStart),
    columnEnd: Math.min(query.columnEnd, coverage.columnEnd),
  };
  return intersection.rowStart < intersection.rowEnd &&
    intersection.columnStart < intersection.columnEnd
    ? intersection
    : null;
}

export function spreadsheetCanvasDevicePixelRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.min(MAX_DEVICE_PIXEL_RATIO, value));
}

/** Caps backing-store allocation while retaining the full CSS viewport. */
export function spreadsheetCanvasBackingScale(
  width: number,
  height: number,
  devicePixelRatio: number,
): number {
  const safeWidth = finiteExtent(width);
  const safeHeight = finiteExtent(height);
  const requested = spreadsheetCanvasDevicePixelRatio(devicePixelRatio);
  return Math.max(
    Number.EPSILON,
    Math.min(
      requested,
      MAX_CANVAS_EDGE / safeWidth,
      MAX_CANVAS_EDGE / safeHeight,
      Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeHeight)),
    ),
  );
}

/** Retained 2D tile renderer. Dynamic selection and headers are painted above cached body tiles. */
export class SpreadsheetCanvasRenderer {
  private readonly tiles = new Map<string, Tile>();
  private generation = "";
  private clock = 0;

  dispose(): void {
    this.tiles.clear();
    this.generation = "";
  }

  paint(input: SpreadsheetCanvasPaint): SpreadsheetCanvasPaintStats | null {
    const context = safeCanvasContext(input.canvas);
    if (!context) return null;

    const width = finiteExtent(input.viewportWidth);
    const height = finiteExtent(input.viewportHeight);
    const dpr = spreadsheetCanvasBackingScale(width, height, input.devicePixelRatio);
    const pixelWidth = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.round(width * dpr)));
    const pixelHeight = Math.max(1, Math.min(MAX_CANVAS_EDGE, Math.round(height * dpr)));
    if (input.canvas.width !== pixelWidth) input.canvas.width = pixelWidth;
    if (input.canvas.height !== pixelHeight) input.canvas.height = pixelHeight;
    input.canvas.style.width = `${width}px`;
    input.canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const generation = [
      input.projection.sheetId,
      input.projection.generationId ?? "<none>",
      input.projection.revision,
      input.dimensionRevision,
      dpr,
      input.theme.signature,
    ].join("/");
    if (generation !== this.generation) {
      this.tiles.clear();
      this.generation = generation;
    }

    setFill(context, input.theme.background, "#ffffff");
    context.fillRect(0, 0, width, height);

    const bodyLeft = input.rowHeaderWidth;
    const bodyTop = input.columnHeaderHeight;
    const visibleLeft = clamp(input.logicalScrollLeft, 0, input.columns.total);
    const visibleTop = clamp(input.logicalScrollTop, 0, input.rows.total);
    const visibleRight = clamp(
      input.logicalScrollLeft + width - bodyLeft,
      visibleLeft,
      input.columns.total,
    );
    const visibleBottom = clamp(
      input.logicalScrollTop + height - bodyTop,
      visibleTop,
      input.rows.total,
    );
    let paintedTiles = 0;
    let reusedTiles = 0;
    let uncachedTiles = 0;

    context.save();
    context.beginPath();
    context.rect(bodyLeft, bodyTop, Math.max(0, width - bodyLeft), Math.max(0, height - bodyTop));
    context.clip();
    const firstTileColumn = Math.floor(visibleLeft / TILE_SIZE);
    const lastTileColumn = Math.floor(
      Math.max(visibleLeft, visibleRight - Number.EPSILON) / TILE_SIZE,
    );
    const firstTileRow = Math.floor(visibleTop / TILE_SIZE);
    const lastTileRow = Math.floor(
      Math.max(visibleTop, visibleBottom - Number.EPSILON) / TILE_SIZE,
    );
    let visitedTiles = 0;
    tileLoop: for (let tileRow = firstTileRow; tileRow <= lastTileRow; tileRow += 1) {
      for (let tileColumn = firstTileColumn; tileColumn <= lastTileColumn; tileColumn += 1) {
        if (visitedTiles >= MAX_TILES_PER_PAINT) break tileLoop;
        visitedTiles += 1;
        const key = `${tileColumn}:${tileRow}`;
        let tile = this.tiles.get(key);
        if (!tile) {
          const painted = this.paintTile(input, tileColumn, tileRow, dpr);
          tile = {
            canvas: painted.canvas,
            lastUsed: ++this.clock,
          };
          if (painted.cacheable) this.tiles.set(key, tile);
          else uncachedTiles += 1;
          paintedTiles += 1;
        } else {
          tile.lastUsed = ++this.clock;
          reusedTiles += 1;
        }
        const logicalX = tileColumn * TILE_SIZE;
        const logicalY = tileRow * TILE_SIZE;
        context.drawImage(
          tile.canvas,
          bodyLeft + logicalX - input.logicalScrollLeft,
          bodyTop + logicalY - input.logicalScrollTop,
          TILE_SIZE,
          TILE_SIZE,
        );
      }
    }

    paintSelection(context, input);
    paintVisibleGrid(context, input, visibleLeft, visibleTop, visibleRight, visibleBottom);
    context.restore();
    paintHeaders(
      context,
      input,
      width,
      height,
      visibleLeft,
      visibleTop,
      visibleRight,
      visibleBottom,
    );

    this.evictTiles(dpr);
    return {
      cacheSize: this.tiles.size,
      paintedTiles,
      reusedTiles,
      uncachedTiles,
      devicePixelRatio: dpr,
    };
  }

  private paintTile(
    input: SpreadsheetCanvasPaint,
    tileColumn: number,
    tileRow: number,
    dpr: number,
  ): { canvas: HTMLCanvasElement; cacheable: boolean } {
    const tile = input.canvas.ownerDocument.createElement("canvas");
    tile.width = Math.max(1, Math.round(TILE_SIZE * dpr));
    tile.height = Math.max(1, Math.round(TILE_SIZE * dpr));
    const context = safeCanvasContext(tile);
    if (!context) return { canvas: tile, cacheable: false };
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    setFill(context, input.theme.background, "#ffffff");
    context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

    const tileLeft = tileColumn * TILE_SIZE;
    const tileTop = tileRow * TILE_SIZE;
    const tileRight = Math.min(input.columns.total, tileLeft + TILE_SIZE);
    const tileBottom = Math.min(input.rows.total, tileTop + TILE_SIZE);
    const firstColumn = input.columns.indexAtOffset(tileLeft);
    const lastColumn = input.columns.indexAtOffset(Math.max(tileLeft, tileRight - Number.EPSILON));
    const firstRow = input.rows.indexAtOffset(tileTop);
    const lastRow = input.rows.indexAtOffset(Math.max(tileTop, tileBottom - Number.EPSILON));
    const query = {
      rowStart: firstRow,
      rowEnd: Math.min(input.rows.count, lastRow + 1),
      columnStart: firstColumn,
      columnEnd: Math.min(input.columns.count, lastColumn + 1),
    };
    const coveredQuery = intersectCoverage(query, input.projection.coverage);
    const cacheable = coverageContains(input.projection.coverage, query);
    const cells: SpreadsheetCanvasCell[] = [];
    if (coveredQuery) {
      input.projection.cells.forEachInRange(
        coveredQuery.rowStart,
        coveredQuery.rowEnd,
        coveredQuery.columnStart,
        coveredQuery.columnEnd,
        (cell) => cells.push(cell),
      );
    }

    for (const cell of cells) {
      const fill = cell.format.fill;
      if (!fill) continue;
      const x = input.columns.offsetAt(cell.col) - tileLeft;
      const y = input.rows.offsetAt(cell.row) - tileTop;
      const width = input.columns.sizeAt(cell.col);
      const height = input.rows.sizeAt(cell.row);
      setFill(context, fill, input.theme.background);
      context.fillRect(x, y, width, height);
    }

    paintTileGrid(context, input, tileLeft, tileTop, tileRight, tileBottom);

    for (const cell of cells) {
      const value = input.projection.valueAt(cell);
      const text = displayValue(value);
      if (!text) continue;
      paintCellText(context, input, cell, text, tileLeft, tileTop);
    }

    return { canvas: tile, cacheable };
  }

  private evictTiles(dpr: number): void {
    const pixelsPerTile = Math.max(1, Math.round(TILE_SIZE * dpr)) ** 2;
    const maximum = Math.max(
      4,
      Math.min(MAX_CACHE_TILES, Math.floor(MAX_CACHE_PHYSICAL_PIXELS / pixelsPerTile)),
    );
    if (this.tiles.size <= maximum) return;
    const oldest = [...this.tiles.entries()].sort(
      (left, right) => left[1].lastUsed - right[1].lastUsed,
    );
    for (let index = 0; index < oldest.length - maximum; index += 1) {
      this.tiles.delete(oldest[index]![0]);
    }
  }
}

function finiteExtent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

function safeCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d", { alpha: false });
  } catch {
    return null;
  }
}

function setFill(context: CanvasRenderingContext2D, value: string, fallback: string): void {
  context.fillStyle = fallback;
  try {
    context.fillStyle = value;
  } catch {
    // Invalid workbook colors behave like invalid CSS declarations: ignore them.
  }
}

function setStroke(context: CanvasRenderingContext2D, value: string, fallback: string): void {
  context.strokeStyle = fallback;
  try {
    context.strokeStyle = value;
  } catch {
    // Invalid workbook colors behave like invalid CSS declarations: ignore them.
  }
}

function paintTileGrid(
  context: CanvasRenderingContext2D,
  input: SpreadsheetCanvasPaint,
  tileLeft: number,
  tileTop: number,
  tileRight: number,
  tileBottom: number,
): void {
  setFill(context, input.theme.border, "#d1d5db");
  visitAxisBoundaries(input.columns, tileLeft, tileRight, (offset) => {
    context.fillRect(offset - tileLeft - 1, 0, 1, TILE_SIZE);
  });
  visitAxisBoundaries(input.rows, tileTop, tileBottom, (offset) => {
    context.fillRect(0, offset - tileTop - 1, TILE_SIZE, 1);
  });
}

function paintVisibleGrid(
  context: CanvasRenderingContext2D,
  input: SpreadsheetCanvasPaint,
  visibleLeft: number,
  visibleTop: number,
  visibleRight: number,
  visibleBottom: number,
): void {
  setFill(context, input.theme.border, "#d1d5db");
  visitAxisBoundaries(input.columns, visibleLeft, visibleRight, (offset) => {
    const x = input.rowHeaderWidth + offset - input.logicalScrollLeft;
    context.fillRect(x - 1, input.columnHeaderHeight, 1, input.viewportHeight);
  });
  visitAxisBoundaries(input.rows, visibleTop, visibleBottom, (offset) => {
    const y = input.columnHeaderHeight + offset - input.logicalScrollTop;
    context.fillRect(input.rowHeaderWidth, y - 1, input.viewportWidth, 1);
  });
}

function visitAxisBoundaries(
  axis: SpreadsheetCanvasAxis,
  start: number,
  end: number,
  visit: (offset: number) => void,
): void {
  if (axis.count <= 0 || end < start) return;
  let index = axis.indexAtOffset(start);
  let visits = 0;
  while (index < axis.count && visits < MAX_AXIS_MARKS_PER_PAINT) {
    const boundary = axis.offsetAt(index + 1);
    if (boundary > end + 1) break;
    if (boundary >= start) visit(boundary);
    index += 1;
    visits += 1;
  }
}

function paintSelection(context: CanvasRenderingContext2D, input: SpreadsheetCanvasPaint): void {
  const { selection } = input;
  const left =
    input.rowHeaderWidth + input.columns.offsetAt(selection.left) - input.logicalScrollLeft;
  const right =
    input.rowHeaderWidth + input.columns.offsetAt(selection.right + 1) - input.logicalScrollLeft;
  const top =
    input.columnHeaderHeight + input.rows.offsetAt(selection.top) - input.logicalScrollTop;
  const bottom =
    input.columnHeaderHeight + input.rows.offsetAt(selection.bottom + 1) - input.logicalScrollTop;
  context.save();
  setFill(context, input.theme.accent, "#3b82f6");
  context.globalAlpha = 0.1;
  context.fillRect(left, top, right - left, bottom - top);
  context.restore();

  const activeLeft =
    input.rowHeaderWidth + input.columns.offsetAt(selection.focusColumn) - input.logicalScrollLeft;
  const activeTop =
    input.columnHeaderHeight + input.rows.offsetAt(selection.focusRow) - input.logicalScrollTop;
  const activeWidth = input.columns.sizeAt(selection.focusColumn);
  const activeHeight = input.rows.sizeAt(selection.focusRow);
  context.save();
  setStroke(context, input.theme.accent, "#3b82f6");
  context.lineWidth = 2;
  context.strokeRect(
    activeLeft + 1,
    activeTop + 1,
    Math.max(0, activeWidth - 2),
    Math.max(0, activeHeight - 2),
  );
  context.restore();
}

function paintHeaders(
  context: CanvasRenderingContext2D,
  input: SpreadsheetCanvasPaint,
  width: number,
  height: number,
  visibleLeft: number,
  visibleTop: number,
  visibleRight: number,
  visibleBottom: number,
): void {
  setFill(context, input.theme.headerBackground, "#f3f4f6");
  context.fillRect(0, 0, width, input.columnHeaderHeight);
  context.fillRect(0, input.columnHeaderHeight, input.rowHeaderWidth, height);
  setFill(context, input.theme.border, "#d1d5db");
  context.fillRect(0, input.columnHeaderHeight - 1, width, 1);
  context.fillRect(input.rowHeaderWidth - 1, 0, 1, height);

  context.save();
  context.beginPath();
  context.rect(
    input.rowHeaderWidth,
    0,
    Math.max(0, width - input.rowHeaderWidth),
    input.columnHeaderHeight,
  );
  context.clip();
  setFill(context, input.theme.mutedForeground, "#6b7280");
  context.font = `600 ${input.theme.headerFontSize}px ${input.theme.fontFamily}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  visitAxisItems(input.columns, visibleLeft, visibleRight, (column, offset, size) => {
    const x = input.rowHeaderWidth + offset - input.logicalScrollLeft;
    setFill(context, input.theme.border, "#d1d5db");
    context.fillRect(x + size - 1, 0, 1, input.columnHeaderHeight);
    if (size >= 8) {
      setFill(context, input.theme.mutedForeground, "#6b7280");
      context.fillText(columnName(column), x + size / 2, input.columnHeaderHeight / 2);
    }
  });
  context.restore();

  context.save();
  context.beginPath();
  context.rect(
    0,
    input.columnHeaderHeight,
    input.rowHeaderWidth,
    Math.max(0, height - input.columnHeaderHeight),
  );
  context.clip();
  setFill(context, input.theme.mutedForeground, "#6b7280");
  context.font = `400 ${input.theme.headerFontSize}px ${input.theme.fontFamily}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  visitAxisItems(input.rows, visibleTop, visibleBottom, (row, offset, size) => {
    const y = input.columnHeaderHeight + offset - input.logicalScrollTop;
    setFill(context, input.theme.border, "#d1d5db");
    context.fillRect(0, y + size - 1, input.rowHeaderWidth, 1);
    if (size >= 8) {
      setFill(context, input.theme.mutedForeground, "#6b7280");
      context.fillText(String(row + 1), input.rowHeaderWidth / 2, y + size / 2);
    }
  });
  context.restore();
}

function visitAxisItems(
  axis: SpreadsheetCanvasAxis,
  start: number,
  end: number,
  visit: (index: number, offset: number, size: number) => void,
): void {
  if (axis.count <= 0 || end < start) return;
  let index = axis.indexAtOffset(start);
  let visits = 0;
  while (index < axis.count && visits < MAX_AXIS_MARKS_PER_PAINT) {
    const offset = axis.offsetAt(index);
    if (offset > end) break;
    visit(index, offset, axis.sizeAt(index));
    index += 1;
    visits += 1;
  }
}

function paintCellText(
  context: CanvasRenderingContext2D,
  input: SpreadsheetCanvasPaint,
  cell: SpreadsheetCanvasCell,
  text: string,
  tileLeft: number,
  tileTop: number,
): void {
  const format = cell.format;
  const x = input.columns.offsetAt(cell.col) - tileLeft;
  const y = input.rows.offsetAt(cell.row) - tileTop;
  const width = input.columns.sizeAt(cell.col);
  const height = input.rows.sizeAt(cell.row);
  if (width <= 2 || height <= 2) return;
  const fontSize = finitePositive(format.font?.size, input.theme.fontSize);
  const fontFamily = format.font?.name || input.theme.fontFamily;
  const weight = format.font?.bold ? 600 : 400;
  const italic = format.font?.italic ? "italic " : "";
  context.save();
  context.beginPath();
  context.rect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
  context.clip();
  context.font = `${italic}${weight} ${fontSize}px ${fontFamily}`;
  setFill(
    context,
    format.font?.color ?? (text.startsWith("#") ? input.theme.error : input.theme.foreground),
    input.theme.foreground,
  );
  const alignment = format.horizontalAlignment;
  context.textAlign = alignment === "center" ? "center" : alignment === "right" ? "right" : "left";
  context.textBaseline = "alphabetic";
  const padding = 6;
  const textX =
    alignment === "center"
      ? x + width / 2
      : alignment === "right"
        ? x + width - padding
        : x + padding;
  const lineHeight = fontSize * 1.5;
  const availableWidth = Math.max(0, width - padding * 2);
  const lines = format.wrapText
    ? wrapText(context, text, availableWidth, Math.max(1, Math.floor(height / lineHeight)))
    : [ellipsize(context, text.replaceAll(/\r?\n/g, " "), availableWidth)];
  const blockHeight = lines.length * lineHeight;
  const vertical = format.verticalAlignment;
  const firstBaseline =
    vertical === "top"
      ? y + Math.min(height, padding + fontSize)
      : vertical === "bottom"
        ? y + height - padding - blockHeight + fontSize
        : y + (height - blockHeight) / 2 + fontSize;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const baseline = firstBaseline + index * lineHeight;
    context.fillText(line, textX, baseline);
    if (format.font?.underline && line) {
      const metrics = context.measureText(line);
      const textWidth = metrics.width;
      const startX =
        alignment === "center"
          ? textX - textWidth / 2
          : alignment === "right"
            ? textX - textWidth
            : textX;
      setFill(context, format.font.color ?? input.theme.foreground, input.theme.foreground);
      context.fillRect(startX, baseline + 1, textWidth, Math.max(1, fontSize / 14));
    }
  }
  context.restore();
}

function wrapText(
  context: CanvasRenderingContext2D,
  input: string,
  maximumWidth: number,
  maximumLines: number,
): string[] {
  if (maximumWidth <= 0) return [""];
  const output: string[] = [];
  for (const paragraph of input.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) output.push("");
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || context.measureText(next).width <= maximumWidth) line = next;
      else {
        output.push(ellipsize(context, line, maximumWidth));
        line = word;
      }
      if (output.length >= maximumLines) break;
    }
    if (output.length < maximumLines && line) output.push(ellipsize(context, line, maximumWidth));
    if (output.length >= maximumLines) break;
  }
  return output.slice(0, maximumLines);
}

function ellipsize(context: CanvasRenderingContext2D, input: string, maximumWidth: number): string {
  if (!input || maximumWidth <= 0) return "";
  if (context.measureText(input).width <= maximumWidth) return input;
  const suffix = "…";
  const suffixWidth = context.measureText(suffix).width;
  if (suffixWidth > maximumWidth) return "";
  let low = 0;
  let high = input.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(`${input.slice(0, middle)}${suffix}`).width <= maximumWidth)
      low = middle;
    else high = middle - 1;
  }
  return `${input.slice(0, low)}${suffix}`;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
