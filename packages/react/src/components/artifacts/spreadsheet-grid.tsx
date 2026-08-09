import type { Workbook, WorkbookChange, Worksheet } from "@opengeni/artifact-tool/reference";
import { PlusIcon } from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/cn";
import { ArtifactSurface } from "./artifact-surface";
import {
  SparseSpreadsheetCellIndex,
  SpreadsheetCanvasRenderer,
  spreadsheetCanvasDevicePixelRatio,
  type SpreadsheetCanvasAxis,
  type SpreadsheetCanvasCellFormat,
  type SpreadsheetCanvasProjection,
  type SpreadsheetCanvasTheme,
} from "./spreadsheet-canvas";

const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
const ROW_HEADER_WIDTH = 48;
const COLUMN_HEADER_HEIGHT = 28;
const FALLBACK_VIEWPORT_WIDTH = 880;
const FALLBACK_VIEWPORT_HEIGHT = 480;
// Firefox collapses oversized layout boxes rather than merely clamping them.
// Keep the native scroll surface comfortably below every supported engine's
// limit, then project that bounded physical range over the full logical sheet.
const MAX_PHYSICAL_SCROLL_SPAN = 8_000_000;
// Purely proportional compression can assign short rows after tall overrides
// to the same browser scroll pixel. Every compressed axis therefore reserves
// physical address space per item as well as a proportional share.
const MIN_PHYSICAL_ITEM_SPAN = 4;
const MAX_MOUNTED_AXIS_ITEMS = 512;
const MAX_MOUNTED_GRID_CELLS = 2_048;
const MAX_CLIPBOARD_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CLIPBOARD_CELLS = 65_536;

type CellCoordinate = { row: number; col: number };

export type SpreadsheetSelection = {
  sheetId: string;
  anchor: CellCoordinate;
  focus: CellCoordinate;
};

export type SpreadsheetCommit = {
  sheetId: string;
  cell: CellCoordinate;
  input: string;
  kind: "formula" | "value";
};

/** Row-major rectangular input submitted as one durable spreadsheet command. */
export type SpreadsheetRangeCommit = {
  sheetId: string;
  anchor: CellCoordinate;
  rows: number;
  columns: number;
  inputs: readonly string[];
};

/** End-exclusive logical windows emitted at most once per animation frame. */
export type SpreadsheetViewport = {
  sheetId: string;
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
  overscanRowStart: number;
  overscanRowEnd: number;
  overscanColumnStart: number;
  overscanColumnEnd: number;
  logicalScrollLeft: number;
  logicalScrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type SpreadsheetGridProps = {
  workbook: Workbook;
  worksheet: Worksheet;
  readOnly?: boolean | undefined;
  /** Addressable rows in the interactive projection. Grows to include used data. */
  rowCount?: number | undefined;
  /** Addressable columns in the interactive projection. Grows to include used data. */
  columnCount?: number | undefined;
  overscanRows?: number | undefined;
  overscanColumns?: number | undefined;
  onSelectionChange?: ((selection: SpreadsheetSelection) => void) | undefined;
  onCommit?: ((commit: SpreadsheetCommit) => void) | undefined;
  onViewportChange?: ((viewport: SpreadsheetViewport) => void) | undefined;
  className?: string | undefined;
};

export type SpreadsheetProjectionCell = {
  value: unknown;
  input: string;
  format: SpreadsheetCanvasCellFormat;
};

/**
 * Synchronous, bounded view state consumed by the React editor. Durable model
 * ownership stays with the caller (legacy Workbook, SDK Worker, or another
 * projection adapter); edits return through `commit` / `clear` ports.
 */
export type SpreadsheetGridProjection = SpreadsheetCanvasProjection & {
  sheetName: string;
  rowCount: number;
  columnCount: number;
  defaultRowHeight?: number | undefined;
  defaultColumnWidth?: number | undefined;
  rowHeights?: readonly (readonly [number, number])[] | undefined;
  columnWidths?: readonly (readonly [number, number])[] | undefined;
  dimensionRevision?: string | number | undefined;
  usedRange?: { row: number; col: number; rowCount: number; colCount: number } | null | undefined;
  readCell: (row: number, column: number) => SpreadsheetProjectionCell | null;
};

export type SpreadsheetProjectionGridProps = {
  projection: SpreadsheetGridProjection;
  readOnly?: boolean | undefined;
  overscanRows?: number | undefined;
  overscanColumns?: number | undefined;
  onSelectionChange?: ((selection: SpreadsheetSelection) => void) | undefined;
  commit?: ((commit: SpreadsheetCommit) => void | Promise<void>) | undefined;
  commitRange?: ((commit: SpreadsheetRangeCommit) => void | Promise<void>) | undefined;
  clear?: ((selection: SpreadsheetSelection) => void | Promise<void>) | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onViewportChange?: ((viewport: SpreadsheetViewport) => void) | undefined;
  className?: string | undefined;
};

export type SpreadsheetArtifactSurfaceProps = Omit<SpreadsheetGridProps, "worksheet"> & {
  title?: string | undefined;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  initialSheetId?: string | undefined;
  allowAddSheet?: boolean | undefined;
};

type AxisGeometry = {
  count: number;
  defaultSize: number;
  overrides: readonly AxisOverride[];
  total: number;
};

type AxisOverride = {
  index: number;
  size: number;
  start: number;
  end: number;
  cumulativeDelta: number;
};

type ViewportState = {
  width: number;
  height: number;
  scrollLeft: number;
  scrollTop: number;
  devicePixelRatio: number;
};

type SelectingState = {
  pointerId: number;
  anchor: CellCoordinate;
};

type ScrollProjection = {
  axis: AxisGeometry;
  mode: "identity" | "indexed";
  physicalTotal: number;
  logicalMax: number;
  physicalMax: number;
  baseItemSpan: number;
  proportionalSpan: number;
  rawMax: number;
};

type WorkbookViewState = {
  revision: number;
  dimensionRevision: number;
};

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function buildAxis(
  count: number,
  defaultSize: number,
  entries: Iterable<readonly [number, number]>,
): AxisGeometry {
  const normalizedDefault = Number.isFinite(defaultSize) && defaultSize > 0 ? defaultSize : 1;
  const sorted = [...entries]
    .filter(
      ([index, size]) =>
        Number.isInteger(index) && index >= 0 && index < count && Number.isFinite(size) && size > 0,
    )
    .sort(([left], [right]) => left - right);
  const overrides: AxisOverride[] = [];
  let cumulativeDelta = 0;
  for (const [index, size] of sorted) {
    // A Map-backed source is unique. Last-write-wins also makes this robust to
    // custom adapters that repeat an index.
    const previous = overrides.at(-1);
    if (previous?.index === index) {
      cumulativeDelta -= previous.size - normalizedDefault;
      overrides.pop();
    }
    if (size === normalizedDefault) continue;
    const start = index * normalizedDefault + cumulativeDelta;
    cumulativeDelta += size - normalizedDefault;
    overrides.push({
      index,
      size,
      start,
      end: start + size,
      cumulativeDelta,
    });
  }
  return {
    count,
    defaultSize: normalizedDefault,
    overrides,
    total: count * normalizedDefault + cumulativeDelta,
  };
}

function lowerBoundOverrideIndex(axis: AxisGeometry, index: number): number {
  let low = 0;
  let high = axis.overrides.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (axis.overrides[middle]!.index < index) low = middle + 1;
    else high = middle;
  }
  return low;
}

function axisOffsetAt(axis: AxisGeometry, index: number): number {
  if (index <= 0) return 0;
  if (index >= axis.count) return axis.total;
  const insertion = lowerBoundOverrideIndex(axis, index);
  const delta = insertion > 0 ? axis.overrides[insertion - 1]!.cumulativeDelta : 0;
  return index * axis.defaultSize + delta;
}

function axisSizeAt(axis: AxisGeometry, index: number): number {
  const candidate = axis.overrides[lowerBoundOverrideIndex(axis, index)];
  return candidate?.index === index ? candidate.size : axis.defaultSize;
}

function upperBoundOverrideStart(axis: AxisGeometry, offset: number): number {
  let low = 0;
  let high = axis.overrides.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (axis.overrides[middle]!.start <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexAtOffset(axis: AxisGeometry, offset: number): number {
  if (axis.count <= 1) return 0;
  const target = Math.max(0, Math.min(axis.total - 1, offset));
  const previousIndex = upperBoundOverrideStart(axis, target) - 1;
  if (previousIndex < 0) {
    return Math.min(
      (axis.overrides[0]?.index ?? axis.count) - 1,
      Math.floor(target / axis.defaultSize),
    );
  }
  const previous = axis.overrides[previousIndex]!;
  if (target < previous.end) return previous.index;
  const nextOverrideIndex = axis.overrides[previousIndex + 1]?.index ?? axis.count;
  return Math.min(
    axis.count - 1,
    nextOverrideIndex - 1,
    previous.index + 1 + Math.floor((target - previous.end) / axis.defaultSize),
  );
}

function visibleInterval(
  axis: AxisGeometry,
  startOffset: number,
  viewportSize: number,
  overscan: number,
): { start: number; end: number } {
  const start = Math.max(0, indexAtOffset(axis, startOffset) - overscan);
  const end = Math.min(
    axis.count,
    indexAtOffset(axis, startOffset + Math.max(1, viewportSize)) + overscan + 1,
  );
  return { start, end };
}

function boundVisibleWindows(
  rows: { start: number; end: number },
  columns: { start: number; end: number },
  focus: CellCoordinate,
): {
  rows: { start: number; end: number };
  columns: { start: number; end: number };
} {
  let rowCount = Math.min(MAX_MOUNTED_AXIS_ITEMS, rows.end - rows.start);
  let columnCount = Math.min(MAX_MOUNTED_AXIS_ITEMS, columns.end - columns.start);
  if (rowCount * columnCount > MAX_MOUNTED_GRID_CELLS) {
    const balancedLimit = Math.floor(Math.sqrt(MAX_MOUNTED_GRID_CELLS));
    if (rowCount > balancedLimit && columnCount > balancedLimit) {
      rowCount = balancedLimit;
      columnCount = balancedLimit;
    } else if (rowCount >= columnCount) {
      rowCount = Math.max(1, Math.floor(MAX_MOUNTED_GRID_CELLS / columnCount));
    } else {
      columnCount = Math.max(1, Math.floor(MAX_MOUNTED_GRID_CELLS / rowCount));
    }
  }
  return {
    rows: centeredInterval(rows, rowCount, focus.row),
    columns: centeredInterval(columns, columnCount, focus.col),
  };
}

function centeredInterval(
  interval: { start: number; end: number },
  count: number,
  focus: number,
): { start: number; end: number } {
  if (count >= interval.end - interval.start) return interval;
  if (focus < interval.start || focus >= interval.end) {
    return { start: interval.start, end: interval.start + count };
  }
  const start = Math.max(
    interval.start,
    Math.min(interval.end - count, focus - Math.floor(count / 2)),
  );
  return { start, end: start + count };
}

function indexesBetween(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function rawBoundaryAt(projection: ScrollProjection, index: number): number {
  if (index <= 0) return 0;
  if (index >= projection.axis.count) {
    return projection.axis.count * projection.baseItemSpan + projection.proportionalSpan;
  }
  return (
    index * projection.baseItemSpan +
    (axisOffsetAt(projection.axis, index) / projection.axis.total) * projection.proportionalSpan
  );
}

function rawOffsetAtLogical(projection: ScrollProjection, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= projection.axis.total) {
    return rawBoundaryAt(projection, projection.axis.count);
  }
  const index = indexAtOffset(projection.axis, offset);
  const logicalStart = axisOffsetAt(projection.axis, index);
  const logicalSize = axisSizeAt(projection.axis, index);
  const fraction = Math.max(0, Math.min(1, (offset - logicalStart) / logicalSize));
  const rawStart = rawBoundaryAt(projection, index);
  const rawEnd = rawBoundaryAt(projection, index + 1);
  return rawStart + fraction * (rawEnd - rawStart);
}

function logicalOffsetAtRaw(projection: ScrollProjection, rawOffset: number): number {
  const target = Math.max(0, Math.min(projection.rawMax, rawOffset));
  let low = 0;
  let high = projection.axis.count;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rawBoundaryAt(projection, middle) <= target) low = middle;
    else high = middle - 1;
  }
  const index = Math.min(projection.axis.count - 1, low);
  const rawStart = rawBoundaryAt(projection, index);
  const rawEnd = rawBoundaryAt(projection, index + 1);
  const fraction = rawEnd === rawStart ? 0 : (target - rawStart) / (rawEnd - rawStart);
  return Math.min(
    projection.logicalMax,
    axisOffsetAt(projection.axis, index) + fraction * axisSizeAt(projection.axis, index),
  );
}

function buildScrollProjection(
  axis: AxisGeometry,
  headerSize: number,
  viewportSize: number,
): ScrollProjection {
  const logicalTotal = headerSize + axis.total;
  const physicalTotal = Math.min(logicalTotal, MAX_PHYSICAL_SCROLL_SPAN);
  const logicalMax = Math.max(0, logicalTotal - viewportSize);
  const physicalMax = Math.max(0, physicalTotal - viewportSize);
  const mode = physicalTotal === logicalTotal ? "identity" : "indexed";
  const physicalAxisCapacity = Math.max(0, physicalTotal - headerSize);
  const baseItemSpan =
    mode === "indexed" ? Math.min(MIN_PHYSICAL_ITEM_SPAN, physicalAxisCapacity / axis.count) : 0;
  const projection: ScrollProjection = {
    axis,
    mode,
    physicalTotal,
    logicalMax,
    physicalMax,
    baseItemSpan,
    proportionalSpan: Math.max(0, physicalAxisCapacity - baseItemSpan * axis.count),
    rawMax: 0,
  };
  projection.rawMax = rawOffsetAtLogical(projection, logicalMax);
  return projection;
}

function clampPhysicalScroll(offset: number, projection: ScrollProjection): number {
  return Math.max(0, Math.min(projection.physicalMax, offset));
}

function physicalToLogicalScroll(offset: number, projection: ScrollProjection): number {
  if (projection.logicalMax === 0 || projection.physicalMax === 0) return 0;
  if (projection.mode === "indexed") {
    return logicalOffsetAtRaw(
      projection,
      (clampPhysicalScroll(offset, projection) / projection.physicalMax) * projection.rawMax,
    );
  }
  return (clampPhysicalScroll(offset, projection) / projection.physicalMax) * projection.logicalMax;
}

function logicalToPhysicalScroll(offset: number, projection: ScrollProjection): number {
  if (projection.logicalMax === 0 || projection.physicalMax === 0) return 0;
  const logical = Math.max(0, Math.min(projection.logicalMax, offset));
  if (projection.mode === "indexed") {
    return (rawOffsetAtLogical(projection, logical) / projection.rawMax) * projection.physicalMax;
  }
  return (logical / projection.logicalMax) * projection.physicalMax;
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

function cellName(cell: CellCoordinate): string {
  return `${columnName(cell.col)}${cell.row + 1}`;
}

function normalizeSelection(selection: SpreadsheetSelection) {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.col, selection.focus.col),
    right: Math.max(selection.anchor.col, selection.focus.col),
  };
}

function selectionName(selection: SpreadsheetSelection): string {
  const normalized = normalizeSelection(selection);
  const first = cellName({ row: normalized.top, col: normalized.left });
  const last = cellName({ row: normalized.bottom, col: normalized.right });
  return first === last ? first : `${first}:${last}`;
}

function isCellSelected(selection: SpreadsheetSelection, row: number, col: number): boolean {
  const normalized = normalizeSelection(selection);
  return (
    row >= normalized.top &&
    row <= normalized.bottom &&
    col >= normalized.left &&
    col <= normalized.right
  );
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function parseCellInput(input: string): string | number | boolean | null {
  if (input === "") return null;
  const normalized = input.trim();
  if (/^(?:true|false)$/i.test(normalized)) return normalized.toLowerCase() === "true";
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    const number = Number(normalized);
    if (Number.isFinite(number)) return number;
  }
  return input;
}

type ParsedSpreadsheetClipboard = Readonly<{
  rows: number;
  columns: number;
  inputs: readonly string[];
}>;

/** Bounded RFC-4180-style TSV parser for Excel/Sheets `text/plain` clipboard data. */
function parseSpreadsheetClipboard(input: string): ParsedSpreadsheetClipboard {
  if (new TextEncoder().encode(input).byteLength > MAX_CLIPBOARD_INPUT_BYTES) {
    throw new Error("Clipboard data is too large to paste");
  }
  const records: string[][] = [[]];
  let field = "";
  let quoted = false;
  let endedWithRecordSeparator = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      endedWithRecordSeparator = false;
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
      endedWithRecordSeparator = false;
    } else if (character === "\t") {
      records.at(-1)!.push(field);
      field = "";
      endedWithRecordSeparator = false;
    } else if (character === "\r" || character === "\n") {
      records.at(-1)!.push(field);
      field = "";
      records.push([]);
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      endedWithRecordSeparator = true;
    } else {
      field += character;
      endedWithRecordSeparator = false;
    }
  }
  if (quoted) throw new Error("Clipboard data contains an unterminated quoted cell");
  if (endedWithRecordSeparator) records.pop();
  else records.at(-1)!.push(field);
  if (records.length === 0) records.push([""]);
  const columns = Math.max(1, ...records.map((record) => record.length));
  const cellCount = records.length * columns;
  if (cellCount > MAX_CLIPBOARD_CELLS) {
    throw new Error("Clipboard range is too large to paste");
  }
  const inputs = records.flatMap((record) => [
    ...record,
    ...Array.from({ length: columns - record.length }, () => ""),
  ]);
  return Object.freeze({ rows: records.length, columns, inputs: Object.freeze(inputs) });
}

function escapeSpreadsheetClipboardField(input: string): string {
  return /["\t\r\n]/u.test(input) ? `"${input.replaceAll('"', '""')}"` : input;
}

function cellStyle(format: SpreadsheetCanvasCellFormat): CSSProperties {
  return {
    background: format.fill,
    color: format.font?.color,
    fontFamily: format.font?.name,
    fontSize: format.font?.size,
    fontWeight: format.font?.bold ? 600 : undefined,
    fontStyle: format.font?.italic ? "italic" : undefined,
    textDecoration: format.font?.underline ? "underline" : undefined,
    textAlign: format.horizontalAlignment,
    justifyContent:
      format.horizontalAlignment === "center"
        ? "center"
        : format.horizontalAlignment === "right"
          ? "flex-end"
          : "flex-start",
    alignItems:
      format.verticalAlignment === "top"
        ? "flex-start"
        : format.verticalAlignment === "bottom"
          ? "flex-end"
          : "center",
    whiteSpace: format.wrapText ? "normal" : "nowrap",
  };
}

function canvasAxis(axis: AxisGeometry): SpreadsheetCanvasAxis {
  return {
    count: axis.count,
    total: axis.total,
    offsetAt: (index) => axisOffsetAt(axis, index),
    sizeAt: (index) => axisSizeAt(axis, index),
    indexAtOffset: (offset) => indexAtOffset(axis, offset),
  };
}

function computedToken(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function computedPixels(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function spreadsheetCanvasTheme(element: HTMLElement): SpreadsheetCanvasTheme {
  const style = getComputedStyle(element);
  const background =
    style.backgroundColor || computedToken(style, "--og-color-surface-1", "#ffffff");
  const headerBackground = computedToken(style, "--og-color-surface-2", "#f3f4f6");
  const border = computedToken(style, "--og-color-border", "#d1d5db");
  const foreground = style.color || computedToken(style, "--og-color-fg", "#111827");
  const mutedForeground = computedToken(style, "--og-color-fg-muted", "#6b7280");
  const accent = computedToken(style, "--og-color-accent", "#3b82f6");
  const error = computedToken(style, "--og-color-status-failed", "#dc2626");
  const fontFamily =
    style.fontFamily ||
    computedToken(
      style,
      "--og-font-sans",
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );
  const fontSize =
    Number.parseFloat(style.fontSize) || computedPixels(style, "--og-font-size-sm", 12);
  const headerFontSize = computedPixels(style, "--og-font-size-xs", 11);
  return {
    background,
    headerBackground,
    border,
    foreground,
    mutedForeground,
    accent,
    error,
    fontFamily,
    fontSize,
    headerFontSize,
    signature: [
      background,
      headerBackground,
      border,
      foreground,
      mutedForeground,
      accent,
      error,
      fontFamily,
      fontSize,
      headerFontSize,
    ].join("\u001f"),
  };
}

function useWorkbookViewState(workbook: Workbook): WorkbookViewState {
  const [view, setView] = useState<WorkbookViewState>(() => ({
    revision: workbook.revision,
    dimensionRevision: 0,
  }));

  useEffect(() => {
    setView((current) =>
      current.revision === workbook.revision
        ? current
        : { revision: workbook.revision, dimensionRevision: current.dimensionRevision + 1 },
    );
    return workbook.onChange((change: WorkbookChange) => {
      setView((current) => ({
        revision: change.revision,
        dimensionRevision:
          change.reason === "dimension" || change.reason === "structure"
            ? current.dimensionRevision + 1
            : current.dimensionRevision,
      }));
    });
  }, [workbook]);

  return view;
}

function nextAvailableSheetName(workbook: Workbook): string {
  let index = workbook.worksheets.items.length + 1;
  while (workbook.worksheets.items.some((sheet) => sheet.name === `Sheet${index}`)) index += 1;
  return `Sheet${index}`;
}

/** A reusable workbook shell with first-class sheet switching. */
export function SpreadsheetArtifactSurface({
  workbook,
  title = "Workbook",
  subtitle,
  actions,
  initialSheetId,
  allowAddSheet = true,
  readOnly = false,
  ...gridProps
}: SpreadsheetArtifactSurfaceProps) {
  const { revision } = useWorkbookViewState(workbook);
  const availableSheets = workbook.worksheets.items;
  const initial =
    (initialSheetId ? availableSheets.find((sheet) => sheet.id === initialSheetId) : undefined) ??
    (() => {
      try {
        return workbook.worksheets.getActiveWorksheet();
      } catch {
        return availableSheets[0];
      }
    })();
  const [activeSheetId, setActiveSheetId] = useState<string | null>(initial?.id ?? null);
  const activeSheet =
    availableSheets.find((sheet) => sheet.id === activeSheetId) ?? availableSheets[0] ?? null;

  useEffect(() => {
    if (!activeSheet && activeSheetId !== null) setActiveSheetId(null);
    else if (activeSheet && activeSheet.id !== activeSheetId) setActiveSheetId(activeSheet.id);
  }, [activeSheet, activeSheetId, revision]);

  const selectSheet = useCallback(
    (sheet: Worksheet) => {
      workbook.worksheets.setActiveWorksheet(sheet);
      setActiveSheetId(sheet.id);
    },
    [workbook],
  );

  const addSheet = useCallback(() => {
    const sheet = workbook.worksheets.add(nextAvailableSheetName(workbook));
    selectSheet(sheet);
  }, [selectSheet, workbook]);

  const footer = (
    <div
      className="flex min-h-9 items-center gap-1 overflow-x-auto px-2"
      role="tablist"
      aria-label="Worksheets"
    >
      {availableSheets.map((sheet) => (
        <button
          key={sheet.id}
          type="button"
          role="tab"
          aria-selected={sheet.id === activeSheet?.id}
          onClick={() => selectSheet(sheet)}
          className={cn(
            "h-7 shrink-0 rounded-og-sm px-2.5 text-og-sm transition-colors",
            sheet.id === activeSheet?.id
              ? "bg-og-surface-3 font-medium text-og-fg"
              : "text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg",
          )}
        >
          {sheet.name}
        </button>
      ))}
      {!readOnly && allowAddSheet ? (
        <button
          type="button"
          onClick={addSheet}
          aria-label="Add worksheet"
          className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg [&>svg]:size-3.5"
        >
          <PlusIcon />
        </button>
      ) : null}
    </div>
  );

  return (
    <ArtifactSurface
      modality="spreadsheet"
      title={title}
      subtitle={
        subtitle ??
        (activeSheet
          ? `${availableSheets.length} sheet${availableSheets.length === 1 ? "" : "s"}`
          : "Empty workbook")
      }
      actions={actions}
      footer={footer}
    >
      {activeSheet ? (
        <SpreadsheetGrid
          key={activeSheet.id}
          {...gridProps}
          workbook={workbook}
          worksheet={activeSheet}
          readOnly={readOnly}
        />
      ) : (
        <div
          className="grid h-full place-items-center bg-og-bg p-6 text-center"
          style={{ minHeight: 224 }}
        >
          <div>
            <p className="text-og-base font-medium text-og-fg">This workbook has no worksheets.</p>
            {!readOnly && allowAddSheet ? (
              <button
                type="button"
                onClick={addSheet}
                className="mt-3 rounded-og-sm bg-og-accent-deep px-3 py-1.5 text-og-sm font-medium text-og-accent-fg"
              >
                Add worksheet
              </button>
            ) : null}
          </div>
        </div>
      )}
    </ArtifactSurface>
  );
}

export function SpreadsheetGrid({
  workbook,
  worksheet,
  readOnly = false,
  rowCount: requestedRowCount,
  columnCount: requestedColumnCount,
  overscanRows = 3,
  overscanColumns = 2,
  onSelectionChange,
  onCommit,
  onViewportChange,
  className,
}: SpreadsheetGridProps) {
  const { revision, dimensionRevision } = useWorkbookViewState(workbook);
  const boundedProjection = requestedRowCount !== undefined || requestedColumnCount !== undefined;
  const usedRange = useMemo(() => {
    void revision;
    return boundedProjection ? worksheet.usedRangeAddress() : null;
  }, [boundedProjection, revision, worksheet]);
  const rowCount = boundedInteger(
    Math.max(
      requestedRowCount ?? MAX_ROWS,
      (usedRange?.row ?? 0) + (usedRange?.rowCount ?? 0) + 32,
    ),
    MAX_ROWS,
    MAX_ROWS,
  );
  const columnCount = boundedInteger(
    Math.max(
      requestedColumnCount ?? MAX_COLUMNS,
      (usedRange?.col ?? 0) + (usedRange?.colCount ?? 0) + 8,
    ),
    MAX_COLUMNS,
    MAX_COLUMNS,
  );
  const rowHeights = useMemo(() => {
    void dimensionRevision;
    return [...worksheet.rowHeightEntries()] as const;
  }, [dimensionRevision, worksheet]);
  const columnWidths = useMemo(() => {
    void dimensionRevision;
    return [...worksheet.columnWidthEntries()] as const;
  }, [dimensionRevision, worksheet]);
  const projection = useMemo<SpreadsheetGridProjection>(() => {
    void dimensionRevision;
    const cells = new SparseSpreadsheetCellIndex(
      (function* projectedCells() {
        for (const { row, col, data } of worksheet.cellEntries()) {
          yield {
            row,
            col,
            value: data.value,
            formula: data.formula,
            format: data.format,
          };
        }
      })(),
    );
    return {
      sheetId: worksheet.id,
      sheetName: worksheet.name,
      generationId: worksheet.id,
      revision,
      dimensionRevision,
      rowCount,
      columnCount,
      defaultRowHeight: worksheet.defaultRowHeight,
      defaultColumnWidth: worksheet.defaultColumnWidth,
      rowHeights,
      columnWidths,
      usedRange,
      cells,
      valueAt: (cell) =>
        cell.formula ? workbook.valueAt(worksheet, { row: cell.row, col: cell.col }) : cell.value,
      readCell: (row, col) => {
        const data = worksheet.cellData(row, col);
        return {
          value: data.formula ? workbook.valueAt(worksheet, { row, col }) : data.value,
          input: data.formula ?? displayValue(data.value),
          format: data.format,
        };
      },
    };
  }, [
    columnCount,
    columnWidths,
    dimensionRevision,
    revision,
    rowCount,
    rowHeights,
    usedRange,
    workbook,
    worksheet,
  ]);
  const commit = useCallback(
    (next: SpreadsheetCommit) => {
      const target = worksheet.getCell(next.cell.row, next.cell.col);
      if (next.kind === "formula") target.formulas = [[next.input]];
      else target.values = [[parseCellInput(next.input)]];
      onCommit?.(next);
    },
    [onCommit, worksheet],
  );
  const commitRange = useCallback(
    (next: SpreadsheetRangeCommit) => {
      if (next.rows * next.columns !== next.inputs.length) {
        throw new Error("Spreadsheet paste shape is invalid");
      }
      workbook.transact(() => {
        for (let index = 0; index < next.inputs.length; index += 1) {
          const input = next.inputs[index]!;
          const row = next.anchor.row + Math.floor(index / next.columns);
          const col = next.anchor.col + (index % next.columns);
          worksheet.setCell(
            row,
            col,
            input.startsWith("=")
              ? { formula: input, value: null }
              : { formula: null, value: parseCellInput(input) },
            "content",
          );
        }
      });
    },
    [workbook, worksheet],
  );
  const clear = useCallback(
    (next: SpreadsheetSelection) => {
      const normalized = normalizeSelection(next);
      worksheet
        .getRangeByIndexes(
          normalized.top,
          normalized.left,
          normalized.bottom - normalized.top + 1,
          normalized.right - normalized.left + 1,
        )
        .clear({ applyTo: "contents" });
    },
    [worksheet],
  );

  return (
    <SpreadsheetProjectionGrid
      projection={projection}
      readOnly={readOnly}
      overscanRows={overscanRows}
      overscanColumns={overscanColumns}
      onSelectionChange={onSelectionChange}
      commit={commit}
      commitRange={commitRange}
      clear={clear}
      onViewportChange={onViewportChange}
      className={className}
    />
  );
}

/**
 * Two-axis virtualized, accessible spreadsheet projection. The caller owns
 * durable model state; React owns only viewport, selection, and edit state.
 */
export function SpreadsheetProjectionGrid({
  projection,
  readOnly = false,
  overscanRows = 3,
  overscanColumns = 2,
  onSelectionChange,
  commit,
  commitRange,
  clear,
  onCommandError,
  onViewportChange,
  className,
}: SpreadsheetProjectionGridProps) {
  const { revision, rowCount, columnCount } = projection;
  const dimensionRevision = projection.dimensionRevision ?? 0;
  const editable = !readOnly && commit !== undefined;
  const rows = useMemo(() => {
    void dimensionRevision;
    return buildAxis(rowCount, projection.defaultRowHeight ?? 24, projection.rowHeights ?? []);
  }, [dimensionRevision, projection.defaultRowHeight, projection.rowHeights, rowCount]);
  const columns = useMemo(() => {
    void dimensionRevision;
    return buildAxis(
      columnCount,
      projection.defaultColumnWidth ?? 96,
      projection.columnWidths ?? [],
    );
  }, [columnCount, dimensionRevision, projection.columnWidths, projection.defaultColumnWidth]);
  const canvasRows = useMemo(() => canvasAxis(rows), [rows]);
  const canvasColumns = useMemo(() => canvasAxis(columns), [columns]);
  const [selection, setSelection] = useState<SpreadsheetSelection>(() => ({
    sheetId: projection.sheetId,
    anchor: { row: 0, col: 0 },
    focus: { row: 0, col: 0 },
  }));
  const [editMode, setEditMode] = useState<"cell" | "formula" | null>(null);
  const [draft, setDraft] = useState(
    () => projection.readCell(selection.focus.row, selection.focus.col)?.input ?? "",
  );
  const [pendingCommands, setPendingCommands] = useState(0);
  const [commandFailure, setCommandFailure] = useState<{
    message: string;
    retry?: (() => void) | undefined;
  } | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    width: FALLBACK_VIEWPORT_WIDTH,
    height: FALLBACK_VIEWPORT_HEIGHT,
    scrollLeft: 0,
    scrollTop: 0,
    devicePixelRatio: 1,
  });
  const [canvasReady, setCanvasReady] = useState(false);
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef(selection);
  const selectingRef = useRef<SelectingState | null>(null);
  const committingRef = useRef(false);
  const composingRef = useRef(false);
  const commitAfterCompositionRef = useRef(false);
  const selectDraftOnFocusRef = useRef(true);
  const initialDraftRef = useRef(draft);
  const optimisticInputRef = useRef<{
    sheetId: string;
    row: number;
    col: number;
    input: string;
    baseRevision: string | number;
  } | null>(null);
  const mountedRef = useRef(true);
  const commandScopeRef = useRef(0);
  const latestCommandRef = useRef(0);
  const canvasRendererRef = useRef<SpreadsheetCanvasRenderer | null>(null);
  if (!canvasRendererRef.current) canvasRendererRef.current = new SpreadsheetCanvasRenderer();
  const reactId = useId().replaceAll(":", "");

  const updateSelection = useCallback(
    (next: SpreadsheetSelection) => {
      selectionRef.current = next;
      setSelection(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  useEffect(() => {
    if (selection.sheetId === projection.sheetId) return;
    commandScopeRef.current += 1;
    latestCommandRef.current += 1;
    const next = {
      sheetId: projection.sheetId,
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    };
    optimisticInputRef.current = null;
    setPendingCommands(0);
    setCommandFailure(null);
    setEditMode(null);
    updateSelection(next);
  }, [projection.sheetId, selection.sheetId, updateSelection]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      commandScopeRef.current += 1;
      latestCommandRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (editMode !== null) return;
    const optimistic = optimisticInputRef.current;
    if (
      optimistic?.sheetId === projection.sheetId &&
      optimistic.row === selection.focus.row &&
      optimistic.col === selection.focus.col &&
      optimistic.baseRevision === revision
    ) {
      setDraft(optimistic.input);
      return;
    }
    if (optimistic && optimistic.baseRevision !== revision) optimisticInputRef.current = null;
    setDraft(projection.readCell(selection.focus.row, selection.focus.col)?.input ?? "");
  }, [editMode, projection, revision, selection.focus.col, selection.focus.row]);

  useClientLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      setViewport((current) => ({
        ...current,
        width: element.clientWidth || FALLBACK_VIEWPORT_WIDTH,
        height: element.clientHeight || FALLBACK_VIEWPORT_HEIGHT,
        devicePixelRatio: spreadsheetCanvasDevicePixelRatio(globalThis.devicePixelRatio || 1),
      }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    globalThis.addEventListener?.("resize", measure);
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener?.("resize", measure);
    };
  }, []);

  useEffect(() => {
    return () => canvasRendererRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) setCanvasEpoch((value) => value + 1);
    });
    if (typeof MutationObserver === "undefined") {
      return () => {
        active = false;
      };
    }
    const observer = new MutationObserver(() => setCanvasEpoch((value) => value + 1));
    let ancestor: HTMLElement | null = viewportRef.current;
    while (ancestor) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "data-og-theme", "data-og-density"],
      });
      ancestor = ancestor.parentElement;
    }
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (editMode !== "cell") return;
    const editor = editorRef.current;
    editor?.focus();
    if (!editor) return;
    if (selectDraftOnFocusRef.current) editor.select();
    else editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [editMode]);

  const ensureVisible = useCallback(
    (cell: CellCoordinate) => {
      const element = viewportRef.current;
      if (!element) return;
      const viewportWidth = element.clientWidth || FALLBACK_VIEWPORT_WIDTH;
      const viewportHeight = element.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
      const horizontalProjection = buildScrollProjection(columns, ROW_HEADER_WIDTH, viewportWidth);
      const verticalProjection = buildScrollProjection(rows, COLUMN_HEADER_HEIGHT, viewportHeight);
      const left = ROW_HEADER_WIDTH + axisOffsetAt(columns, cell.col);
      const right = left + axisSizeAt(columns, cell.col);
      const top = COLUMN_HEADER_HEIGHT + axisOffsetAt(rows, cell.row);
      const bottom = top + axisSizeAt(rows, cell.row);
      const logicalScrollLeft = physicalToLogicalScroll(element.scrollLeft, horizontalProjection);
      const logicalScrollTop = physicalToLogicalScroll(element.scrollTop, verticalProjection);
      const viewportLeft = logicalScrollLeft + ROW_HEADER_WIDTH;
      const viewportRight = logicalScrollLeft + viewportWidth;
      const viewportTop = logicalScrollTop + COLUMN_HEADER_HEIGHT;
      const viewportBottom = logicalScrollTop + viewportHeight;
      if (left < viewportLeft) {
        element.scrollLeft = logicalToPhysicalScroll(
          Math.max(0, left - ROW_HEADER_WIDTH),
          horizontalProjection,
        );
      } else if (right > viewportRight) {
        element.scrollLeft = logicalToPhysicalScroll(right - viewportWidth, horizontalProjection);
      }
      if (top < viewportTop) {
        element.scrollTop = logicalToPhysicalScroll(
          Math.max(0, top - COLUMN_HEADER_HEIGHT),
          verticalProjection,
        );
      } else if (bottom > viewportBottom) {
        element.scrollTop = logicalToPhysicalScroll(bottom - viewportHeight, verticalProjection);
      }
    },
    [columns, rows],
  );

  const moveSelection = useCallback(
    (rowDelta: number, colDelta: number, extend: boolean) => {
      const focus = {
        row: Math.max(0, Math.min(rowCount - 1, selection.focus.row + rowDelta)),
        col: Math.max(0, Math.min(columnCount - 1, selection.focus.col + colDelta)),
      };
      const next = {
        sheetId: projection.sheetId,
        anchor: extend ? selection.anchor : focus,
        focus,
      };
      updateSelection(next);
      ensureVisible(focus);
    },
    [columnCount, ensureVisible, projection.sheetId, rowCount, selection, updateSelection],
  );

  const runCommand = useCallback(
    (invoke: () => void | Promise<void>, retry: () => void, rollback: () => void) => {
      const commandId = latestCommandRef.current + 1;
      latestCommandRef.current = commandId;
      const scope = commandScopeRef.current;
      setCommandFailure(null);
      const fail = (cause: unknown) => {
        if (
          !mountedRef.current ||
          commandScopeRef.current !== scope ||
          latestCommandRef.current !== commandId
        ) {
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        rollback();
        setCommandFailure({ message: error.message || "Spreadsheet change failed", retry });
        onCommandError?.(error);
      };
      let result: void | Promise<void>;
      try {
        result = invoke();
      } catch (cause) {
        fail(cause);
        return;
      }
      if (!result || typeof result.then !== "function") return;
      setPendingCommands((current) => current + 1);
      void Promise.resolve(result).then(
        () => {
          if (!mountedRef.current || commandScopeRef.current !== scope) return;
          setPendingCommands((current) => Math.max(0, current - 1));
        },
        (cause) => {
          if (!mountedRef.current || commandScopeRef.current !== scope) return;
          setPendingCommands((current) => Math.max(0, current - 1));
          fail(cause);
        },
      );
    },
    [onCommandError],
  );

  const reportCommandFailure = useCallback(
    (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setCommandFailure({ message: error.message || "Spreadsheet action failed" });
      onCommandError?.(error);
    },
    [onCommandError],
  );

  const commitDraft = useCallback(
    (input = draft) => {
      if (committingRef.current) return;
      committingRef.current = true;
      if (!editable || !commit) {
        setEditMode(null);
        queueMicrotask(() => {
          committingRef.current = false;
        });
        return;
      }
      if (input === initialDraftRef.current) {
        setEditMode(null);
        viewportRef.current?.focus();
        queueMicrotask(() => {
          committingRef.current = false;
        });
        return;
      }
      const next = {
        sheetId: projection.sheetId,
        cell: { ...selection.focus },
        input,
        kind: input.startsWith("=") ? "formula" : "value",
      } satisfies SpreadsheetCommit;
      const execute = () => {
        optimisticInputRef.current = {
          sheetId: projection.sheetId,
          row: selection.focus.row,
          col: selection.focus.col,
          input,
          baseRevision: revision,
        };
        setDraft(input);
        runCommand(
          () => commit(next),
          execute,
          () => {
            optimisticInputRef.current = null;
            const current = selectionRef.current.focus;
            setDraft(projection.readCell(current.row, current.col)?.input ?? "");
          },
        );
      };
      execute();
      initialDraftRef.current = input;
      setEditMode(null);
      viewportRef.current?.focus();
      queueMicrotask(() => {
        committingRef.current = false;
      });
    },
    [commit, draft, editable, projection, revision, runCommand, selection.focus],
  );

  const clearSelection = useCallback(() => {
    if (!editable || !clear) return;
    const current = selection;
    const execute = () =>
      runCommand(
        () => clear(current),
        execute,
        () => {},
      );
    execute();
  }, [clear, editable, runCommand, selection]);

  const pasteClipboard = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!editable || editMode !== null) return;
      const clipboardText = event.clipboardData.getData("text/plain");
      if (!clipboardText && !event.clipboardData.types.includes("text/plain")) return;
      event.preventDefault();
      const execute = () => {
        const previousSelection = selectionRef.current;
        const invoke = () => {
          const parsed = parseSpreadsheetClipboard(clipboardText);
          const anchor = previousSelection.focus;
          if (anchor.row + parsed.rows > rowCount || anchor.col + parsed.columns > columnCount) {
            throw new Error("Clipboard range does not fit in this worksheet");
          }
          if (!commitRange && parsed.inputs.length !== 1) {
            throw new Error("This spreadsheet adapter does not support rectangular paste");
          }
          const bottomRight = {
            row: anchor.row + parsed.rows - 1,
            col: anchor.col + parsed.columns - 1,
          };
          updateSelection({
            sheetId: projection.sheetId,
            anchor: { ...anchor },
            focus: bottomRight,
          });
          ensureVisible(bottomRight);
          if (commitRange) {
            return commitRange({
              sheetId: projection.sheetId,
              anchor: { ...anchor },
              rows: parsed.rows,
              columns: parsed.columns,
              inputs: parsed.inputs,
            });
          }
          const input = parsed.inputs[0]!;
          return commit!({
            sheetId: projection.sheetId,
            cell: { ...anchor },
            input,
            kind: input.startsWith("=") ? "formula" : "value",
          });
        };
        runCommand(invoke, execute, () => updateSelection(previousSelection));
      };
      execute();
    },
    [
      columnCount,
      commit,
      commitRange,
      editMode,
      editable,
      ensureVisible,
      projection.sheetId,
      rowCount,
      runCommand,
      updateSelection,
    ],
  );

  const copySelection = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (editMode !== null) return;
      const selected = normalizeSelection(selectionRef.current);
      const rowsToCopy = selected.bottom - selected.top + 1;
      const columnsToCopy = selected.right - selected.left + 1;
      if (rowsToCopy * columnsToCopy > MAX_CLIPBOARD_CELLS) {
        event.preventDefault();
        reportCommandFailure(new Error("Selected range is too large to copy"));
        return;
      }
      const coverage = projection.coverage;
      if (
        coverage &&
        (selected.top < coverage.rowStart ||
          selected.bottom >= coverage.rowEnd ||
          selected.left < coverage.columnStart ||
          selected.right >= coverage.columnEnd)
      ) {
        event.preventDefault();
        reportCommandFailure(new Error("Selected cells are still loading; copy again when ready"));
        return;
      }
      const output: string[] = [];
      for (let row = selected.top; row <= selected.bottom; row += 1) {
        const fields: string[] = [];
        for (let col = selected.left; col <= selected.right; col += 1) {
          fields.push(escapeSpreadsheetClipboardField(projection.readCell(row, col)?.input ?? ""));
        }
        output.push(fields.join("\t"));
      }
      event.clipboardData.setData("text/plain", output.join("\r\n"));
      event.preventDefault();
      setCommandFailure(null);
    },
    [editMode, projection, reportCommandFailure],
  );

  const beginEditing = useCallback(
    (initial?: string, cell: CellCoordinate = selectionRef.current.focus) => {
      if (!editable) return;
      ensureVisible(cell);
      const current = projection.readCell(cell.row, cell.col)?.input ?? "";
      initialDraftRef.current = current;
      selectDraftOnFocusRef.current = initial === undefined;
      setDraft(initial ?? current);
      setEditMode("cell");
    },
    [editable, ensureVisible, projection],
  );

  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editMode !== null) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1, 0, event.shiftKey);
          return;
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1, 0, event.shiftKey);
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(0, -1, event.shiftKey);
          return;
        case "ArrowRight":
          event.preventDefault();
          moveSelection(0, 1, event.shiftKey);
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(0, event.shiftKey ? -1 : 1, false);
          return;
        case "Enter":
        case "F2":
          event.preventDefault();
          beginEditing();
          return;
        case "Backspace":
        case "Delete":
          event.preventDefault();
          clearSelection();
          return;
        case "Home": {
          event.preventDefault();
          const target =
            event.metaKey || event.ctrlKey
              ? { row: 0, col: 0 }
              : { row: selection.focus.row, col: 0 };
          updateSelection({ sheetId: projection.sheetId, anchor: target, focus: target });
          ensureVisible(target);
          return;
        }
        case "End": {
          event.preventDefault();
          const used = projection.usedRange;
          const target =
            event.metaKey || event.ctrlKey
              ? {
                  row: Math.min(rowCount - 1, (used?.row ?? 0) + (used?.rowCount ?? 1) - 1),
                  col: Math.min(columnCount - 1, (used?.col ?? 0) + (used?.colCount ?? 1) - 1),
                }
              : { row: selection.focus.row, col: columnCount - 1 };
          updateSelection({ sheetId: projection.sheetId, anchor: target, focus: target });
          ensureVisible(target);
          return;
        }
      }
      if (editable && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        beginEditing(event.key);
      }
    },
    [
      beginEditing,
      clearSelection,
      columnCount,
      editMode,
      ensureVisible,
      moveSelection,
      editable,
      rowCount,
      selection.focus.row,
      updateSelection,
      projection.sheetId,
      projection.usedRange,
    ],
  );

  const onEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (composingRef.current || event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitDraft();
      } else if (event.key === "Escape") {
        event.preventDefault();
        committingRef.current = true;
        setDraft(projection.readCell(selection.focus.row, selection.focus.col)?.input ?? "");
        setEditMode(null);
        viewportRef.current?.focus();
        queueMicrotask(() => {
          committingRef.current = false;
        });
      }
    },
    [commitDraft, projection, selection.focus.col, selection.focus.row],
  );

  const onEditorCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onEditorCompositionEnd = useCallback(
    (input: string) => {
      composingRef.current = false;
      if (!commitAfterCompositionRef.current) return;
      commitAfterCompositionRef.current = false;
      commitDraft(input);
    },
    [commitDraft],
  );

  const commitEditorOnBlur = useCallback(
    (mode: "cell" | "formula", input: string) => {
      if (editMode !== mode) return;
      if (composingRef.current) {
        commitAfterCompositionRef.current = true;
        return;
      }
      commitDraft(input);
    },
    [commitDraft, editMode],
  );

  const selectCell = useCallback(
    (cell: CellCoordinate, extend: boolean) => {
      const current = selectionRef.current;
      const next = {
        sheetId: projection.sheetId,
        anchor: extend ? current.anchor : cell,
        focus: cell,
      };
      updateSelection(next);
      setEditMode(null);
      viewportRef.current?.focus();
    },
    [projection.sheetId, updateSelection],
  );

  const hitTestCell = useCallback(
    (clientX: number, clientY: number): CellCoordinate | null => {
      const element = viewportRef.current;
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const viewportX = clientX - bounds.left;
      const viewportY = clientY - bounds.top;
      const viewportWidth = element.clientWidth || FALLBACK_VIEWPORT_WIDTH;
      const viewportHeight = element.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
      if (
        viewportX < ROW_HEADER_WIDTH ||
        viewportY < COLUMN_HEADER_HEIGHT ||
        viewportX >= viewportWidth ||
        viewportY >= viewportHeight
      ) {
        return null;
      }
      const horizontalProjection = buildScrollProjection(columns, ROW_HEADER_WIDTH, viewportWidth);
      const verticalProjection = buildScrollProjection(rows, COLUMN_HEADER_HEIGHT, viewportHeight);
      const logicalX =
        physicalToLogicalScroll(element.scrollLeft, horizontalProjection) +
        viewportX -
        ROW_HEADER_WIDTH;
      const logicalY =
        physicalToLogicalScroll(element.scrollTop, verticalProjection) +
        viewportY -
        COLUMN_HEADER_HEIGHT;
      if (logicalX < 0 || logicalY < 0 || logicalX >= columns.total || logicalY >= rows.total) {
        return null;
      }
      return {
        row: Math.min(rowCount - 1, indexAtOffset(rows, logicalY)),
        col: Math.min(columnCount - 1, indexAtOffset(columns, logicalX)),
      };
    },
    [columnCount, columns, rowCount, rows],
  );

  const onGridPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const cell = hitTestCell(event.clientX, event.clientY);
      if (!cell) return;
      event.preventDefault();
      const current = selectionRef.current;
      const anchor = event.shiftKey ? current.anchor : cell;
      selectingRef.current = { pointerId: event.pointerId, anchor };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic test DOMs and old WebKit builds may not expose pointer capture.
      }
      updateSelection({ sheetId: projection.sheetId, anchor, focus: cell });
      setEditMode(null);
      event.currentTarget.focus();
    },
    [hitTestCell, projection.sheetId, updateSelection],
  );

  const onGridPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const selecting = selectingRef.current;
      if (!selecting || selecting.pointerId !== event.pointerId) return;
      const cell = hitTestCell(event.clientX, event.clientY);
      if (!cell) return;
      const current = selectionRef.current;
      if (current.focus.row === cell.row && current.focus.col === cell.col) return;
      updateSelection({ sheetId: projection.sheetId, anchor: selecting.anchor, focus: cell });
    },
    [hitTestCell, projection.sheetId, updateSelection],
  );

  const stopPointerSelection = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && selectingRef.current?.pointerId !== pointerId) return;
    selectingRef.current = null;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stopSelecting = () => stopPointerSelection();
    window.addEventListener("pointerup", stopSelecting);
    return () => window.removeEventListener("pointerup", stopSelecting);
  }, [stopPointerSelection]);

  const horizontalProjection = buildScrollProjection(columns, ROW_HEADER_WIDTH, viewport.width);
  const verticalProjection = buildScrollProjection(rows, COLUMN_HEADER_HEIGHT, viewport.height);
  const physicalScrollLeft = clampPhysicalScroll(viewport.scrollLeft, horizontalProjection);
  const physicalScrollTop = clampPhysicalScroll(viewport.scrollTop, verticalProjection);
  const logicalScrollLeft = physicalToLogicalScroll(viewport.scrollLeft, horizontalProjection);
  const logicalScrollTop = physicalToLogicalScroll(viewport.scrollTop, verticalProjection);
  const visibleRowWindow = visibleInterval(
    rows,
    logicalScrollTop,
    Math.max(1, viewport.height - COLUMN_HEADER_HEIGHT),
    0,
  );
  const visibleColumnWindow = visibleInterval(
    columns,
    logicalScrollLeft,
    Math.max(1, viewport.width - ROW_HEADER_WIDTH),
    0,
  );
  const projectedRowWindow = visibleInterval(
    rows,
    logicalScrollTop,
    Math.max(1, viewport.height - COLUMN_HEADER_HEIGHT),
    Math.max(0, overscanRows),
  );
  const projectedColumnWindow = visibleInterval(
    columns,
    logicalScrollLeft,
    Math.max(1, viewport.width - ROW_HEADER_WIDTH),
    Math.max(0, overscanColumns),
  );
  const { rows: rowWindow, columns: columnWindow } = boundVisibleWindows(
    projectedRowWindow,
    projectedColumnWindow,
    selection.focus,
  );
  const visibleRows = indexesBetween(rowWindow.start, rowWindow.end);
  const visibleColumns = indexesBetween(columnWindow.start, columnWindow.end);
  const rowLayout = visibleRows.map((row) => ({
    row,
    top: physicalScrollTop + COLUMN_HEADER_HEIGHT + axisOffsetAt(rows, row) - logicalScrollTop,
    height: axisSizeAt(rows, row),
  }));
  const columnLayout = visibleColumns.map((col) => ({
    col,
    left: physicalScrollLeft + ROW_HEADER_WIDTH + axisOffsetAt(columns, col) - logicalScrollLeft,
    width: axisSizeAt(columns, col),
  }));
  const activeCellVisible =
    selection.focus.row >= rowWindow.start &&
    selection.focus.row < rowWindow.end &&
    selection.focus.col >= columnWindow.start &&
    selection.focus.col < columnWindow.end;
  const activeCellId = `${reactId}-cell-${selection.focus.row}-${selection.focus.col}`;
  const hiddenActiveValue = activeCellVisible
    ? null
    : projection.readCell(selection.focus.row, selection.focus.col)?.value;

  useEffect(() => {
    if (!onViewportChange) return;
    const next: SpreadsheetViewport = {
      sheetId: projection.sheetId,
      rowStart: visibleRowWindow.start,
      rowEnd: visibleRowWindow.end,
      columnStart: visibleColumnWindow.start,
      columnEnd: visibleColumnWindow.end,
      overscanRowStart: projectedRowWindow.start,
      overscanRowEnd: projectedRowWindow.end,
      overscanColumnStart: projectedColumnWindow.start,
      overscanColumnEnd: projectedColumnWindow.end,
      logicalScrollLeft,
      logicalScrollTop,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    };
    let active = true;
    const notify = () => {
      if (active) onViewportChange(next);
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      const frame = globalThis.requestAnimationFrame(notify);
      return () => {
        active = false;
        globalThis.cancelAnimationFrame?.(frame);
      };
    }
    queueMicrotask(notify);
    return () => {
      active = false;
    };
  }, [
    logicalScrollLeft,
    logicalScrollTop,
    onViewportChange,
    projectedColumnWindow.end,
    projectedColumnWindow.start,
    projectedRowWindow.end,
    projectedRowWindow.start,
    viewport.height,
    viewport.width,
    visibleColumnWindow.end,
    visibleColumnWindow.start,
    visibleRowWindow.end,
    visibleRowWindow.start,
    projection.sheetId,
  ]);

  useClientLayoutEffect(() => {
    void canvasEpoch;
    const canvas = canvasRef.current;
    const viewportElement = viewportRef.current;
    const renderer = canvasRendererRef.current;
    if (!canvas || !viewportElement || !renderer) return;
    const normalized = normalizeSelection(selection);
    const stats = renderer.paint({
      canvas,
      projection,
      rows: canvasRows,
      columns: canvasColumns,
      selection: {
        ...normalized,
        focusRow: selection.focus.row,
        focusColumn: selection.focus.col,
      },
      logicalScrollLeft,
      logicalScrollTop,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      rowHeaderWidth: ROW_HEADER_WIDTH,
      columnHeaderHeight: COLUMN_HEADER_HEIGHT,
      dimensionRevision,
      devicePixelRatio: viewport.devicePixelRatio,
      theme: spreadsheetCanvasTheme(viewportElement),
    });
    if (!stats) {
      if (canvasReady) setCanvasReady(false);
      return;
    }
    canvas.dataset.ogTileCacheSize = String(stats.cacheSize);
    canvas.dataset.ogPaintedTiles = String(stats.paintedTiles);
    canvas.dataset.ogReusedTiles = String(stats.reusedTiles);
    canvas.dataset.ogUncachedTiles = String(stats.uncachedTiles);
    canvas.dataset.ogDevicePixelRatio = String(stats.devicePixelRatio);
    if (!canvasReady) setCanvasReady(true);
  }, [
    canvasColumns,
    canvasEpoch,
    canvasReady,
    canvasRows,
    dimensionRevision,
    logicalScrollLeft,
    logicalScrollTop,
    projection,
    revision,
    selection,
    viewport.devicePixelRatio,
    viewport.height,
    viewport.width,
  ]);

  return (
    <div
      className={cn("relative flex h-full min-w-0 flex-col bg-og-bg", className)}
      data-og-command-state={commandFailure ? "error" : pendingCommands > 0 ? "pending" : "idle"}
      style={{ minHeight: 256 }}
    >
      <div className="flex min-h-9 shrink-0 items-center border-b border-og-border bg-og-surface-1">
        <output
          aria-label="Selected range"
          className="shrink-0 border-r border-og-border px-2 font-mono text-og-xs text-og-fg-muted"
          style={{ width: 96 }}
        >
          {selectionName(selection)}
        </output>
        <span aria-hidden className="px-2 font-og-mono text-og-sm italic text-og-fg-subtle">
          fx
        </span>
        <input
          aria-label="Formula or value"
          readOnly={!editable}
          aria-invalid={commandFailure ? "true" : undefined}
          value={draft}
          onFocus={() => {
            if (editable) {
              const current =
                projection.readCell(selection.focus.row, selection.focus.col)?.input ?? "";
              initialDraftRef.current = current;
              setDraft(current);
              setEditMode("formula");
            }
          }}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onEditorKeyDown}
          onCompositionStart={onEditorCompositionStart}
          onCompositionEnd={(event) => onEditorCompositionEnd(event.currentTarget.value)}
          onBlur={(event) => commitEditorOnBlur("formula", event.currentTarget.value)}
          className="h-8 min-w-0 flex-1 bg-transparent px-1 font-mono text-og-sm text-og-fg outline-hidden placeholder:text-og-fg-subtle"
        />
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {commandFailure?.message ?? (pendingCommands > 0 ? "Saving spreadsheet changes" : "")}
      </div>
      {commandFailure ? (
        <div
          role="alert"
          className="absolute bottom-2 left-2 z-50 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-og-sm border border-og-status-failed/30 bg-og-surface-1/95 px-2 py-1 text-og-xs text-og-status-failed shadow-og-sm"
        >
          <span className="truncate">{commandFailure.message}</span>
          {commandFailure.retry ? (
            <button
              type="button"
              onClick={commandFailure.retry}
              className="shrink-0 rounded-og-xs px-1.5 py-0.5 font-medium outline-hidden hover:bg-og-surface-3 focus-visible:ring-2 focus-visible:ring-og-accent"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={viewportRef}
        role="grid"
        tabIndex={0}
        aria-label={`${projection.sheetName} spreadsheet`}
        aria-rowcount={rowCount}
        aria-colcount={columnCount}
        aria-multiselectable="true"
        aria-readonly={!editable}
        aria-busy={pendingCommands > 0 ? "true" : undefined}
        aria-activedescendant={activeCellId}
        onKeyDown={onGridKeyDown}
        onCopy={copySelection}
        onPaste={pasteClipboard}
        onCompositionEnd={(event) => {
          if (editMode === null && editable && event.data) beginEditing(event.data);
        }}
        onPointerDown={onGridPointerDown}
        onPointerMove={onGridPointerMove}
        onPointerUp={(event) => stopPointerSelection(event.pointerId)}
        onPointerCancel={(event) => stopPointerSelection(event.pointerId)}
        onDoubleClick={(event) => {
          const cell = hitTestCell(event.clientX, event.clientY);
          if (!cell) return;
          selectCell(cell, event.shiftKey);
          beginEditing(undefined, cell);
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          setViewport((current) => ({
            ...current,
            scrollLeft: element.scrollLeft,
            scrollTop: element.scrollTop,
          }));
        }}
        className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-og-surface-1 text-og-sm outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent"
      >
        <div
          role="rowgroup"
          className="relative"
          style={{
            width: horizontalProjection.physicalTotal,
            height: verticalProjection.physicalTotal,
          }}
        >
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            data-og-spreadsheet-canvas="retained-tiles"
            className="pointer-events-none absolute z-0 block"
            style={{
              left: physicalScrollLeft,
              top: physicalScrollTop,
              width: viewport.width,
              height: viewport.height,
            }}
          />
          <div
            aria-hidden
            className="sticky left-0 top-0 z-40 border-b border-r border-og-border bg-og-surface-2"
            style={{
              width: ROW_HEADER_WIDTH,
              height: COLUMN_HEADER_HEIGHT,
              ...(canvasReady
                ? { background: "transparent", borderColor: "transparent" }
                : undefined),
            }}
          />

          <div role="row" className="contents">
            {columnLayout.map(({ col, left, width }) => (
              <div
                key={`header-${col}`}
                role="columnheader"
                aria-colindex={col + 1}
                className="sticky top-0 z-30 grid select-none place-items-center overflow-hidden border-b border-r border-og-border bg-og-surface-2 text-og-xs font-medium text-og-fg-muted"
                style={{
                  position: "absolute",
                  left,
                  top: physicalScrollTop,
                  width,
                  height: COLUMN_HEADER_HEIGHT,
                  ...(canvasReady
                    ? {
                        background: "transparent",
                        borderColor: "transparent",
                        color: "transparent",
                      }
                    : undefined),
                }}
              >
                {columnName(col)}
              </div>
            ))}
          </div>

          {rowLayout.map(({ row, top, height }) => {
            return (
              <div
                key={`row-${row}`}
                role="row"
                aria-rowindex={row + 1}
                className="absolute left-0"
                style={{
                  top,
                  width: horizontalProjection.physicalTotal,
                  height,
                }}
              >
                <div
                  role="rowheader"
                  className="sticky left-0 z-20 grid h-full select-none place-items-center border-b border-r border-og-border bg-og-surface-2 text-og-xs text-og-fg-muted"
                  style={{
                    width: ROW_HEADER_WIDTH,
                    ...(canvasReady
                      ? {
                          background: "transparent",
                          borderColor: "transparent",
                          color: "transparent",
                        }
                      : undefined),
                  }}
                >
                  {row + 1}
                </div>

                {columnLayout.map(({ col, left, width }) => {
                  const active = selection.focus.row === row && selection.focus.col === col;
                  const selected = isCellSelected(selection, row, col);
                  const data = projection.readCell(row, col) ?? {
                    value: null,
                    input: "",
                    format: {},
                  };
                  const value = data.value;
                  const address = cellName({ row, col });
                  const error = typeof value === "string" && value.startsWith("#");
                  return (
                    <div
                      key={col}
                      id={`${reactId}-cell-${row}-${col}`}
                      role="gridcell"
                      aria-colindex={col + 1}
                      aria-selected={selected}
                      aria-label={`${address}${value === null ? "" : `, ${displayValue(value)}`}`}
                      data-og-cell={address}
                      className={cn(
                        "pointer-events-none absolute top-0 flex h-full min-w-0 overflow-hidden border-b border-r border-og-border px-1.5 text-og-fg",
                        !canvasReady && selected && !active && "bg-og-accent/10",
                        !canvasReady &&
                          active &&
                          "z-10 bg-og-accent/10 ring-2 ring-inset ring-og-accent",
                        !canvasReady && error && "text-og-status-failed",
                      )}
                      style={{
                        left,
                        width,
                        ...cellStyle(data.format),
                        ...(canvasReady
                          ? {
                              background: "transparent",
                              borderColor: "transparent",
                              color: "transparent",
                            }
                          : undefined),
                      }}
                    >
                      {active && editMode === "cell" ? (
                        <input
                          ref={editorRef}
                          aria-label={`Edit ${address}`}
                          value={draft}
                          onInput={(event) => setDraft(event.currentTarget.value)}
                          onKeyDown={onEditorKeyDown}
                          onCompositionStart={onEditorCompositionStart}
                          onCompositionEnd={(event) =>
                            onEditorCompositionEnd(event.currentTarget.value)
                          }
                          onBlur={(event) => commitEditorOnBlur("cell", event.currentTarget.value)}
                          onPointerDown={(event) => event.stopPropagation()}
                          className="pointer-events-auto absolute inset-0 size-full bg-og-surface-1 px-1.5 font-mono text-og-sm text-og-fg outline-hidden ring-2 ring-inset ring-og-accent"
                        />
                      ) : (
                        <span className="block min-w-0 overflow-hidden text-ellipsis">
                          {displayValue(value)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {!activeCellVisible ? (
            <div role="row" aria-rowindex={selection.focus.row + 1} className="sr-only">
              <div
                id={activeCellId}
                role="gridcell"
                aria-colindex={selection.focus.col + 1}
                aria-selected="true"
                aria-label={`${cellName(selection.focus)}${
                  hiddenActiveValue == null ? "" : `, ${displayValue(hiddenActiveValue)}`
                }`}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
