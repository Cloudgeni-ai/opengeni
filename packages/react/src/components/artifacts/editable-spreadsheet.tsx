import {
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  editableArtifactStableId,
  spreadsheetSheetId,
  type EditableArtifactSession,
  type EditableSpreadsheetCellValue,
  type EditableSpreadsheetMetadataProjection,
  type EditableSpreadsheetSheetMetadata,
  type EditableSpreadsheetViewportProjection,
  type EditableSpreadsheetViewportQuery,
  type SpreadsheetCellInput,
  type SpreadsheetSheetGeneration,
} from "@opengeni/sdk/editable-artifacts";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/cn";
import { ArtifactSurface } from "./artifact-surface";
import {
  editableArtifactAccessRevoked,
  editableArtifactStatusLabel,
  EditableArtifactMessage,
  useEditableArtifactView,
} from "./editable-artifact-ui";
import { SparseSpreadsheetCellIndex } from "./spreadsheet-canvas";
import {
  SpreadsheetProjectionGrid,
  type SpreadsheetCommit,
  type SpreadsheetGridProjection,
  type SpreadsheetRangeCommit,
  type SpreadsheetSelection,
  type SpreadsheetViewport,
} from "./spreadsheet-grid";

const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLUMNS = 16_384;
const INITIAL_VIEWPORT_ROWS = 64;
const INITIAL_VIEWPORT_COLUMNS = 32;
const MAX_INTERACTIVE_QUERY_CELLS = 65_536;
const MAX_INTERACTIVE_QUERY_BYTES = 8 * 1024 * 1024;
const EMPTY_FORMAT = Object.freeze({});
const EMPTY_SHEETS: readonly EditableSpreadsheetSheetMetadata[] = [];

export type EditableSpreadsheetGridProps = {
  session: EditableArtifactSession;
  sheet: EditableSpreadsheetSheetMetadata;
  metadataRevision: bigint;
  readOnly?: boolean | undefined;
  rowCount?: number | undefined;
  columnCount?: number | undefined;
  overscanRows?: number | undefined;
  overscanColumns?: number | undefined;
  onSelectionChange?: ((selection: SpreadsheetSelection) => void) | undefined;
  onCommit?: ((commit: SpreadsheetCommit) => void) | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onViewportChange?: ((viewport: SpreadsheetViewport) => void) | undefined;
  className?: string | undefined;
};

export type EditableSpreadsheetArtifactSurfaceProps = Omit<
  EditableSpreadsheetGridProps,
  "metadataRevision" | "sheet"
> & {
  title?: string | undefined;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  initialSheetId?: string | undefined;
  allowAddSheet?: boolean | undefined;
};

type ProjectionState = {
  query: EditableSpreadsheetViewportQuery;
  projection: EditableSpreadsheetViewportProjection | null;
  error: Error | null;
};

/**
 * Durable spreadsheet editor over one SDK session. Canonical state remains in
 * the dedicated Worker; React receives one bounded immutable viewport only.
 */
export function EditableSpreadsheetGrid({
  session,
  sheet,
  metadataRevision,
  readOnly = false,
  rowCount: requestedRowCount,
  columnCount: requestedColumnCount,
  overscanRows = 3,
  overscanColumns = 2,
  onSelectionChange,
  onCommit,
  onCommandError,
  onViewportChange,
  className,
}: EditableSpreadsheetGridProps) {
  const rowCount = boundedSheetCount(requestedRowCount, EXCEL_MAX_ROWS, sheet.usedBounds?.endRow);
  const columnCount = boundedSheetCount(
    requestedColumnCount,
    EXCEL_MAX_COLUMNS,
    sheet.usedBounds?.endColumn,
  );
  const [state, setState] = useState<ProjectionState>(() => ({
    query: initialViewportQuery(sheet.sheetId, rowCount, columnCount),
    projection: null,
    error: null,
  }));
  const activeCellRef = useRef({ row: 0, column: 0 });

  useEffect(() => {
    setState({
      query: initialViewportQuery(sheet.sheetId, rowCount, columnCount),
      projection: null,
      error: null,
    });
    activeCellRef.current = { row: 0, column: 0 };
  }, [columnCount, rowCount, session, sheet.sheetId]);

  useEffect(() => {
    const query = state.query;
    return session.subscribeSpreadsheetViewport(
      query,
      (projection) => {
        if (!sameViewport(projection, query)) return;
        if (sheet.generationId !== null && projection.generationId !== sheet.generationId) {
          setState((current) =>
            sameViewportQuery(current.query, query)
              ? {
                  ...current,
                  projection: null,
                  error: new Error("Spreadsheet generation changed; refreshing metadata"),
                }
              : current,
          );
          return;
        }
        setState((current) =>
          sameViewportQuery(current.query, query) ? { query, projection, error: null } : current,
        );
      },
      {
        onError(error) {
          setState((current) =>
            sameViewportQuery(current.query, query) ? { ...current, error } : current,
          );
        },
      },
    );
  }, [session, sheet.generationId, state.query]);

  const projection = useMemo(
    () =>
      projectSdkViewport(
        sheet,
        metadataRevision,
        state.query,
        state.projection,
        rowCount,
        columnCount,
      ),
    [columnCount, metadataRevision, rowCount, sheet, state.projection, state.query],
  );
  const generation = useMemo(() => sheetGeneration(sheet), [sheet]);
  const editable = !readOnly && generation !== null;

  const handleCommit = useCallback(
    async (commit: SpreadsheetCommit) => {
      if (!generation) throw new Error("This sheet generation is not writable yet");
      const input = spreadsheetCellInput(commit.input, commit.kind);
      await session.applySpreadsheetCommands({
        version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
        commands: [
          {
            kind: "cells.set",
            sheet: generation,
            anchor: { row: commit.cell.row, column: commit.cell.col },
            rows: 1,
            columns: 1,
            cells: [input],
          },
        ],
      });
      onCommit?.(commit);
    },
    [generation, onCommit, session],
  );

  const handleClear = useCallback(
    async (selection: SpreadsheetSelection) => {
      if (!generation) throw new Error("This sheet generation is not writable yet");
      const top = Math.min(selection.anchor.row, selection.focus.row);
      const bottom = Math.max(selection.anchor.row, selection.focus.row);
      const left = Math.min(selection.anchor.col, selection.focus.col);
      const right = Math.max(selection.anchor.col, selection.focus.col);
      await session.applySpreadsheetCommands({
        version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
        commands: [
          {
            kind: "range.clear",
            sheet: generation,
            range: {
              start: { row: top, column: left },
              end: { row: bottom, column: right },
            },
          },
        ],
      });
    },
    [generation, session],
  );

  const handleCommitRange = useCallback(
    async (commit: SpreadsheetRangeCommit) => {
      if (!generation) throw new Error("This sheet generation is not writable yet");
      await session.applySpreadsheetCommands({
        version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
        commands: [
          {
            kind: "cells.set",
            sheet: generation,
            anchor: { row: commit.anchor.row, column: commit.anchor.col },
            rows: commit.rows,
            columns: commit.columns,
            cells: commit.inputs.map((input) =>
              spreadsheetCellInput(input, input.startsWith("=") ? "formula" : "value"),
            ),
          },
        ],
      });
    },
    [generation, session],
  );

  const handleSelection = useCallback(
    (selection: SpreadsheetSelection) => {
      activeCellRef.current = {
        row: selection.focus.row,
        column: selection.focus.col,
      };
      setState((current) => {
        if (queryContains(current.query, selection.focus.row, selection.focus.col)) return current;
        return {
          query: boundedViewportQuery(
            sheet.sheetId,
            selection.focus.row,
            selection.focus.row + 1,
            selection.focus.col,
            selection.focus.col + 1,
            rowCount,
            columnCount,
            activeCellRef.current,
          ),
          projection: current.projection,
          error: null,
        };
      });
      onSelectionChange?.(selection);
    },
    [columnCount, onSelectionChange, rowCount, sheet.sheetId],
  );

  const handleViewport = useCallback(
    (viewport: SpreadsheetViewport) => {
      const next = boundedViewportQuery(
        sheet.sheetId,
        viewport.overscanRowStart,
        viewport.overscanRowEnd,
        viewport.overscanColumnStart,
        viewport.overscanColumnEnd,
        rowCount,
        columnCount,
        activeCellRef.current,
      );
      setState((current) =>
        sameViewportQuery(current.query, next)
          ? current
          : { query: next, projection: current.projection, error: null },
      );
      onViewportChange?.(viewport);
    },
    [columnCount, onViewportChange, rowCount, sheet.sheetId],
  );

  return (
    <div className={cn("relative h-full min-h-0", className)}>
      <SpreadsheetProjectionGrid
        projection={projection}
        readOnly={!editable}
        overscanRows={overscanRows}
        overscanColumns={overscanColumns}
        onSelectionChange={handleSelection}
        commit={editable ? handleCommit : undefined}
        commitRange={editable ? handleCommitRange : undefined}
        clear={editable ? handleClear : undefined}
        onCommandError={onCommandError}
        onViewportChange={handleViewport}
      />
      {state.error ? (
        <output
          role="status"
          className="pointer-events-none absolute bottom-2 left-2 z-50 max-w-[min(28rem,calc(100%-1rem))] rounded-og-sm border border-og-status-failed/30 bg-og-surface-1/95 px-2 py-1 text-og-xs text-og-status-failed shadow-og-sm"
        >
          {state.error.message}
        </output>
      ) : null}
    </div>
  );
}

/** Artifact chrome, sheet navigation, and one Worker-backed spreadsheet grid. */
export function EditableSpreadsheetArtifactSurface({
  session,
  title = "Workbook",
  subtitle,
  actions,
  initialSheetId,
  allowAddSheet = true,
  readOnly = false,
  ...gridProps
}: EditableSpreadsheetArtifactSurfaceProps) {
  const { metadata, error: metadataError } = useSpreadsheetMetadata(session);
  const view = useEditableArtifactView(session);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(initialSheetId ?? null);
  const [creatingSheet, setCreatingSheet] = useState(false);
  const [surfaceError, setSurfaceError] = useState<Error | null>(null);
  const sheets = metadata?.sheets ?? EMPTY_SHEETS;
  const activeSheet =
    sheets.find((sheet) => sheet.sheetId === activeSheetId) ??
    (initialSheetId ? sheets.find((sheet) => sheet.sheetId === initialSheetId) : undefined) ??
    sheets[0] ??
    null;
  const writable = !readOnly && view.writable;
  const accessRevoked = editableArtifactAccessRevoked(view);

  const addSheet = useCallback(async () => {
    if (!writable || creatingSheet) return;
    setCreatingSheet(true);
    setSurfaceError(null);
    try {
      const after = activeSheet ? sheetGeneration(activeSheet) : null;
      const created = await session.createSpreadsheetSheet({
        name: nextAvailableSheetName(sheets),
        after,
      });
      setActiveSheetId(created.sheetId);
    } catch (cause) {
      setSurfaceError(asError(cause));
    } finally {
      setCreatingSheet(false);
    }
  }, [activeSheet, creatingSheet, session, sheets, writable]);

  const footer = (
    <div
      className="flex min-h-9 items-center gap-1 overflow-x-auto px-2"
      role="tablist"
      aria-label="Worksheets"
    >
      {sheets.map((sheet) => (
        <button
          key={`${sheet.sheetId}:${sheet.generationId ?? "pending"}`}
          type="button"
          role="tab"
          aria-selected={sheet.sheetId === activeSheet?.sheetId}
          onClick={() => setActiveSheetId(sheet.sheetId)}
          className={cn(
            "h-7 shrink-0 rounded-og-sm px-2.5 text-og-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-og-accent",
            sheet.sheetId === activeSheet?.sheetId
              ? "bg-og-surface-3 font-medium text-og-fg"
              : "text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg",
          )}
        >
          {sheet.name}
        </button>
      ))}
      {writable && allowAddSheet ? (
        <button
          type="button"
          onClick={() => void addSheet()}
          disabled={creatingSheet}
          aria-label={creatingSheet ? "Adding worksheet" : "Add worksheet"}
          className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted outline-hidden hover:bg-og-surface-3 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent disabled:opacity-50 [&>svg]:size-3.5"
        >
          <PlusIcon />
        </button>
      ) : null}
    </div>
  );
  const error = surfaceError ?? metadataError;

  return (
    <ArtifactSurface
      modality="spreadsheet"
      title={title}
      subtitle={
        subtitle ??
        (accessRevoked
          ? editableArtifactStatusLabel(view)
          : metadata
            ? `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}`
            : editableArtifactStatusLabel(view))
      }
      actions={actions}
      footer={accessRevoked ? undefined : footer}
      busy={!accessRevoked && !metadata && !error}
    >
      {accessRevoked ? (
        <EditableArtifactMessage
          title="Access changed"
          detail={editableArtifactStatusLabel(view)}
        />
      ) : activeSheet && metadata ? (
        <EditableSpreadsheetGrid
          key={`${activeSheet.sheetId}:${activeSheet.generationId ?? "pending"}`}
          {...gridProps}
          session={session}
          sheet={activeSheet}
          metadataRevision={metadata.revision}
          readOnly={!writable}
        />
      ) : error ? (
        <EditableArtifactMessage title="Could not open this workbook" detail={error.message} />
      ) : metadata ? (
        <div className="grid h-full place-items-center bg-og-bg p-6 text-center">
          <div>
            <p className="text-og-base font-medium text-og-fg">This workbook has no worksheets.</p>
            {writable && allowAddSheet ? (
              <button
                type="button"
                onClick={() => void addSheet()}
                disabled={creatingSheet}
                className="mt-3 rounded-og-sm bg-og-accent-deep px-3 py-1.5 text-og-sm font-medium text-og-accent-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent disabled:opacity-50"
              >
                {creatingSheet ? "Adding…" : "Add worksheet"}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <EditableArtifactMessage
          title="Opening workbook"
          detail={editableArtifactStatusLabel(view)}
        />
      )}
    </ArtifactSurface>
  );
}

function useSpreadsheetMetadata(session: EditableArtifactSession): {
  metadata: EditableSpreadsheetMetadataProjection | null;
  error: Error | null;
} {
  const [state, setState] = useState<{
    metadata: EditableSpreadsheetMetadataProjection | null;
    error: Error | null;
  }>({ metadata: null, error: null });
  useEffect(
    () =>
      session.subscribeSpreadsheetMetadata({}, (metadata) => setState({ metadata, error: null }), {
        onError: (error) => setState((current) => ({ ...current, error })),
      }),
    [session],
  );
  return state;
}

function projectSdkViewport(
  sheet: EditableSpreadsheetSheetMetadata,
  metadataRevision: bigint,
  query: EditableSpreadsheetViewportQuery,
  viewport: EditableSpreadsheetViewportProjection | null,
  rowCount: number,
  columnCount: number,
): SpreadsheetGridProjection {
  const current = viewport && sameViewport(viewport, query) ? viewport : null;
  const projectedCells = (current?.cells ?? []).map((cell) => ({
    row: cell.row,
    col: cell.column,
    value: projectedCellValue(cell.value),
    formula: cell.formula,
    format: EMPTY_FORMAT,
  }));
  const cells = new SparseSpreadsheetCellIndex(projectedCells);
  const byCoordinate = new Map(
    projectedCells.map((cell) => [`${cell.row}:${cell.col}`, cell] as const),
  );
  const used = sheet.usedBounds;
  return {
    sheetId: sheet.sheetId,
    sheetName: sheet.name,
    generationId: current?.generationId ?? sheet.generationId,
    revision: `${metadataRevision}:${current?.revision ?? "loading"}`,
    dimensionRevision: metadataRevision.toString(),
    rowCount,
    columnCount,
    usedRange: used
      ? {
          row: used.startRow,
          col: used.startColumn,
          rowCount: used.endRow - used.startRow + 1,
          colCount: used.endColumn - used.startColumn + 1,
        }
      : null,
    coverage: current
      ? {
          rowStart: current.startRow,
          rowEnd: current.startRow + current.rowCount,
          columnStart: current.startColumn,
          columnEnd: current.startColumn + current.columnCount,
        }
      : {
          rowStart: query.startRow,
          rowEnd: query.startRow,
          columnStart: query.startColumn,
          columnEnd: query.startColumn,
        },
    cells,
    valueAt: (cell) => cell.value,
    readCell: (row, column) => {
      const cell = byCoordinate.get(`${row}:${column}`);
      return cell
        ? {
            value: cell.value,
            input: cell.formula ?? displayValue(cell.value),
            format: cell.format,
          }
        : null;
    },
  };
}

function initialViewportQuery(
  sheetId: string,
  rowCount: number,
  columnCount: number,
): EditableSpreadsheetViewportQuery {
  return {
    sheetId,
    startRow: 0,
    startColumn: 0,
    rowCount: Math.min(rowCount, INITIAL_VIEWPORT_ROWS),
    columnCount: Math.min(columnCount, INITIAL_VIEWPORT_COLUMNS),
    maxCells: MAX_INTERACTIVE_QUERY_CELLS,
    maxBytes: MAX_INTERACTIVE_QUERY_BYTES,
  };
}

function boundedViewportQuery(
  sheetId: string,
  desiredRowStart: number,
  desiredRowEnd: number,
  desiredColumnStart: number,
  desiredColumnEnd: number,
  totalRows: number,
  totalColumns: number,
  focus: { row: number; column: number },
): EditableSpreadsheetViewportQuery {
  let rowStart = clampInteger(desiredRowStart, 0, totalRows - 1);
  let rowEnd = clampInteger(desiredRowEnd, rowStart + 1, totalRows);
  let columnStart = clampInteger(desiredColumnStart, 0, totalColumns - 1);
  let columnEnd = clampInteger(desiredColumnEnd, columnStart + 1, totalColumns);
  const desiredRows = rowEnd - rowStart;
  const desiredColumns = columnEnd - columnStart;
  if (desiredRows * desiredColumns > MAX_INTERACTIVE_QUERY_CELLS) {
    const columns = Math.min(
      desiredColumns,
      Math.max(1, Math.floor(Math.sqrt(MAX_INTERACTIVE_QUERY_CELLS * 2))),
    );
    const rows = Math.max(1, Math.floor(MAX_INTERACTIVE_QUERY_CELLS / columns));
    columnStart = clampWindowStart(columnStart, columnEnd, focus.column, columns, totalColumns);
    columnEnd = Math.min(totalColumns, columnStart + columns);
    rowStart = clampWindowStart(rowStart, rowEnd, focus.row, rows, totalRows);
    rowEnd = Math.min(totalRows, rowStart + rows);
  }
  return {
    sheetId,
    startRow: rowStart,
    startColumn: columnStart,
    rowCount: rowEnd - rowStart,
    columnCount: columnEnd - columnStart,
    maxCells: MAX_INTERACTIVE_QUERY_CELLS,
    maxBytes: MAX_INTERACTIVE_QUERY_BYTES,
  };
}

function clampWindowStart(
  desiredStart: number,
  desiredEnd: number,
  focus: number,
  size: number,
  total: number,
): number {
  if (desiredEnd - desiredStart <= size) return Math.min(desiredStart, Math.max(0, total - size));
  const centered = focus - Math.floor(size / 2);
  return Math.max(desiredStart, Math.min(desiredEnd - size, centered));
}

function queryContains(
  query: EditableSpreadsheetViewportQuery,
  row: number,
  column: number,
): boolean {
  return (
    row >= query.startRow &&
    row < query.startRow + query.rowCount &&
    column >= query.startColumn &&
    column < query.startColumn + query.columnCount
  );
}

function sameViewport(
  projection: EditableSpreadsheetViewportProjection,
  query: EditableSpreadsheetViewportQuery,
): boolean {
  return (
    projection.sheetId === query.sheetId &&
    projection.startRow === query.startRow &&
    projection.startColumn === query.startColumn &&
    projection.rowCount === query.rowCount &&
    projection.columnCount === query.columnCount
  );
}

function sameViewportQuery(
  left: EditableSpreadsheetViewportQuery,
  right: EditableSpreadsheetViewportQuery,
): boolean {
  return (
    left.sheetId === right.sheetId &&
    left.startRow === right.startRow &&
    left.startColumn === right.startColumn &&
    left.rowCount === right.rowCount &&
    left.columnCount === right.columnCount &&
    left.maxCells === right.maxCells &&
    left.maxBytes === right.maxBytes
  );
}

function sheetGeneration(
  sheet: EditableSpreadsheetSheetMetadata,
): SpreadsheetSheetGeneration | null {
  if (sheet.generationId === null) return null;
  return {
    kind: "generation",
    sheetId: spreadsheetSheetId(sheet.sheetId),
    creationOperationId: editableArtifactStableId(sheet.generationId),
  };
}

function spreadsheetCellInput(
  input: string,
  kind: SpreadsheetCommit["kind"],
): SpreadsheetCellInput {
  if (kind === "formula") return { formula: input, cached: null };
  if (input === "") return null;
  const normalized = input.trim();
  if (/^(?:true|false)$/i.test(normalized)) return normalized.toLowerCase() === "true";
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    const value = Number(normalized);
    if (Number.isFinite(value)) return value;
  }
  return input;
}

function projectedCellValue(value: EditableSpreadsheetCellValue): unknown {
  switch (value.kind) {
    case "empty":
      return null;
    case "boolean":
    case "number":
    case "text":
      return value.value;
    case "date":
      return new Date(value.value);
    case "error":
      return spreadsheetErrorText(value.value);
  }
}

function spreadsheetErrorText(
  value: Extract<EditableSpreadsheetCellValue, { kind: "error" }>["value"],
): string {
  if (typeof value === "object") return value.custom;
  return {
    null: "#NULL!",
    divide_by_zero: "#DIV/0!",
    value: "#VALUE!",
    reference: "#REF!",
    name: "#NAME?",
    number: "#NUM!",
    not_available: "#N/A",
    spill: "#SPILL!",
    calculation: "#CALC!",
  }[value];
}

function boundedSheetCount(
  requested: number | undefined,
  maximum: number,
  usedEnd: number | undefined,
): number {
  const requestedCount =
    requested === undefined || !Number.isFinite(requested)
      ? maximum
      : Math.max(1, Math.min(maximum, Math.floor(requested)));
  const usedCount =
    usedEnd === undefined || !Number.isSafeInteger(usedEnd)
      ? 1
      : Math.max(1, Math.min(maximum, usedEnd + 1));
  return Math.max(requestedCount, usedCount);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function nextAvailableSheetName(sheets: readonly EditableSpreadsheetSheetMetadata[]): string {
  let index = sheets.length + 1;
  while (sheets.some((sheet) => sheet.name === `Sheet${index}`)) index += 1;
  return `Sheet${index}`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Spreadsheet change failed");
}
