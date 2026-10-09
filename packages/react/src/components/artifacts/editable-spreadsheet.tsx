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
import {
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
  editableArtifactAccessRevoked,
  editableArtifactStatusLabel,
  EditableArtifactMessage,
  useEditableArtifactView,
} from "./editable-artifact-ui";
import { SparseSpreadsheetCellIndex } from "./spreadsheet-canvas";
import { SpreadsheetDownloadButton, type SpreadsheetDownload } from "./spreadsheet-download";
import {
  SpreadsheetProjectionGrid,
  type SpreadsheetCommit,
  type SpreadsheetDimensionCommit,
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
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
// Identity only: a replacement SDK object is a new authoring lifetime, even
// when artifact, sheet, and generation IDs are unchanged. No model data lives here.
const SESSION_KEYS = new WeakMap<EditableArtifactSession, number>();
let nextSessionKey = 0;

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
  onResize?: ((change: SpreadsheetDimensionCommit) => void) | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onViewportChange?: ((viewport: SpreadsheetViewport) => void) | undefined;
  className?: string | undefined;
};

export type EditableSpreadsheetArtifactSurfaceProps = Omit<
  EditableSpreadsheetGridProps,
  "metadataRevision" | "sheet"
> & {
  title?: string | undefined;
  showHeader?: boolean | undefined;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  /** Authenticated XLSX export of the current saved native head. */
  download?: SpreadsheetDownload | undefined;
  initialSheetId?: string | undefined;
  allowAddSheet?: boolean | undefined;
};

type ProjectionState = {
  session: EditableArtifactSession;
  generationId: string | null;
  query: EditableSpreadsheetViewportQuery;
  projection: EditableSpreadsheetViewportProjection | null;
  error: Error | null;
};

/**
 * Durable spreadsheet editor over one SDK session. Canonical state remains in
 * the dedicated Worker; React receives one bounded immutable viewport only.
 */
export function EditableSpreadsheetGrid(props: EditableSpreadsheetGridProps) {
  return (
    <EditableSpreadsheetGridSession
      key={`${spreadsheetSessionKey(props.session)}:${props.sheet.sheetId}:${props.sheet.generationId ?? "pending"}`}
      {...props}
    />
  );
}

function EditableSpreadsheetGridSession({
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
  onResize,
  onCommandError,
  onViewportChange,
  className,
}: EditableSpreadsheetGridProps) {
  const authoringLifetime = useSpreadsheetAuthoringLifetime();
  const view = useEditableArtifactView(session);
  const rowCount = boundedSheetCount(requestedRowCount, EXCEL_MAX_ROWS, sheet.usedBounds?.endRow);
  const columnCount = boundedSheetCount(
    requestedColumnCount,
    EXCEL_MAX_COLUMNS,
    sheet.usedBounds?.endColumn,
  );
  const [state, setState] = useState<ProjectionState>(() => ({
    session,
    generationId: sheet.generationId,
    query: initialViewportQuery(sheet.sheetId, rowCount, columnCount),
    projection: null,
    error: null,
  }));
  const activeCellRef = useRef({ row: 0, column: 0 });

  useEffect(() => {
    setState((current) =>
      current.session === session &&
      current.generationId === sheet.generationId &&
      current.query.sheetId === sheet.sheetId
        ? current
        : {
            session,
            generationId: sheet.generationId,
            query: initialViewportQuery(sheet.sheetId, rowCount, columnCount),
            projection: null,
            error: null,
          },
    );
    activeCellRef.current = { row: 0, column: 0 };
  }, [columnCount, rowCount, session, sheet.generationId, sheet.sheetId]);

  useEffect(() => {
    const query = state.query;
    const matchesScope = (current: ProjectionState) =>
      current.session === session &&
      current.generationId === sheet.generationId &&
      sameViewportQuery(current.query, query);
    let active = true;
    const unsubscribe = session.subscribeSpreadsheetViewport(
      query,
      (projection) => {
        if (!active || !sameViewport(projection, query)) return;
        if (sheet.generationId !== null && projection.generationId !== sheet.generationId) {
          setState((current) =>
            matchesScope(current)
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
          matchesScope(current) ? { ...current, projection, error: null } : current,
        );
      },
      {
        onError(error) {
          if (!active) return;
          setState((current) => (matchesScope(current) ? { ...current, error } : current));
        },
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session, sheet.generationId, state.query]);

  const projection = useMemo(
    () =>
      projectSdkViewport(
        sheet,
        metadataRevision,
        state.query,
        state.session === session && state.generationId === sheet.generationId
          ? state.projection
          : null,
        rowCount,
        columnCount,
      ),
    [columnCount, metadataRevision, rowCount, session, sheet, state],
  );
  const generation = useMemo(() => sheetGeneration(sheet), [sheet]);
  const editable =
    !readOnly && view.writable && !view.authoringBlockedReason && generation !== null;
  const syncStatus = view.authoringBlockedReason
    ? "Waiting for earlier edits…"
    : view.state === "live"
      ? editable
        ? "Saved"
        : "Read only"
      : editableArtifactStatusLabel(view);
  const syncError =
    view.blockedPending.length > 0
      ? "Some earlier changes could not sync."
      : view.lastError?.message;
  const resizable =
    editable && sheet.defaultRowHeight !== undefined && sheet.defaultColumnWidth !== undefined;

  const handleCommit = useCallback(
    async (commit: SpreadsheetCommit) => {
      const lifetime = requireSpreadsheetAuthoringLifetime(authoringLifetime);
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
      if (authoringLifetime.current === lifetime) onCommit?.(commit);
    },
    [authoringLifetime, generation, onCommit, session],
  );

  const handleClear = useCallback(
    async (selection: SpreadsheetSelection) => {
      requireSpreadsheetAuthoringLifetime(authoringLifetime);
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
    [authoringLifetime, generation, session],
  );

  const handleCommitRange = useCallback(
    async (commit: SpreadsheetRangeCommit) => {
      requireSpreadsheetAuthoringLifetime(authoringLifetime);
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
    [authoringLifetime, generation, session],
  );
  const handleResize = useCallback(
    async (change: SpreadsheetDimensionCommit) => {
      const lifetime = requireSpreadsheetAuthoringLifetime(authoringLifetime);
      if (!generation) throw new Error("This sheet generation is not writable yet");
      await session.applySpreadsheetCommands({
        version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
        commands: [
          change.axis === "column"
            ? {
                kind: "column.width.set",
                sheet: generation,
                column: change.index,
                width: change.size === sheet.defaultColumnWidth ? null : change.size,
              }
            : {
                kind: "row.height.set",
                sheet: generation,
                row: change.index,
                height: change.size === sheet.defaultRowHeight ? null : change.size,
              },
        ],
      });
      if (authoringLifetime.current === lifetime) onResize?.(change);
    },
    [
      authoringLifetime,
      generation,
      onResize,
      session,
      sheet.defaultColumnWidth,
      sheet.defaultRowHeight,
    ],
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
          ...current,
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
        sameViewportQuery(current.query, next) ? current : { ...current, query: next, error: null },
      );
      onViewportChange?.(viewport);
    },
    [columnCount, onViewportChange, rowCount, sheet.sheetId],
  );

  if (editableArtifactAccessRevoked(view)) {
    return (
      <EditableArtifactMessage
        title="Spreadsheet unavailable"
        detail="You no longer have access to this artifact"
      />
    );
  }

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
        resize={resizable ? handleResize : undefined}
        pendingTransactions={view.pendingTransactions}
        syncStatus={syncStatus}
        syncError={syncError}
        onCommandError={onCommandError}
        onViewportChange={handleViewport}
      />
      {state.error && state.session === session && state.generationId === sheet.generationId ? (
        <output
          role="status"
          className="pointer-events-none absolute bottom-2 left-2 z-50 rounded-og-sm border border-og-status-failed/30 bg-og-surface-1/95 px-2 py-1 text-og-xs text-og-status-failed shadow-og-sm"
          style={{ maxWidth: "min(28rem, calc(100% - 1rem))" }}
        >
          {state.error.message}
        </output>
      ) : null}
    </div>
  );
}

/** Artifact chrome, sheet navigation, and one Worker-backed spreadsheet grid. */
export function EditableSpreadsheetArtifactSurface(props: EditableSpreadsheetArtifactSurfaceProps) {
  return (
    <EditableSpreadsheetArtifactSurfaceSession
      key={spreadsheetSessionKey(props.session)}
      {...props}
    />
  );
}

function EditableSpreadsheetArtifactSurfaceSession({
  session,
  title = "Workbook",
  showHeader,
  subtitle,
  actions,
  download,
  initialSheetId,
  allowAddSheet = true,
  readOnly = false,
  ...gridProps
}: EditableSpreadsheetArtifactSurfaceProps) {
  const authoringLifetime = useSpreadsheetAuthoringLifetime();
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
  const writable = !readOnly && view.writable && !view.authoringBlockedReason;
  const accessRevoked = editableArtifactAccessRevoked(view);

  const addSheet = useCallback(async () => {
    if (!writable || creatingSheet) return;
    const lifetime = requireSpreadsheetAuthoringLifetime(authoringLifetime);
    setCreatingSheet(true);
    setSurfaceError(null);
    try {
      const after = activeSheet ? sheetGeneration(activeSheet) : null;
      const created = await session.createSpreadsheetSheet({
        name: nextAvailableSheetName(sheets),
        after,
      });
      if (authoringLifetime.current === lifetime) setActiveSheetId(created.sheetId);
    } catch (cause) {
      if (authoringLifetime.current === lifetime) setSurfaceError(asError(cause));
    } finally {
      if (authoringLifetime.current === lifetime) setCreatingSheet(false);
    }
  }, [activeSheet, authoringLifetime, creatingSheet, session, sheets, writable]);

  const footer = (
    <div
      className="flex min-h-9 items-center gap-1 overflow-x-auto px-2"
      role="tablist"
      aria-label="Worksheets"
    >
      {sheets.map((sheet) => (
        <EditableWorksheetTab
          key={`${sheet.sheetId}:${sheet.generationId ?? "pending"}`}
          session={session}
          sheet={sheet}
          sheets={sheets}
          selected={sheet.sheetId === activeSheet?.sheetId}
          writable={writable}
          onSelect={() => setActiveSheetId(sheet.sheetId)}
          onCommandError={gridProps.onCommandError}
        />
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
      showHeader={showHeader}
      subtitle={
        subtitle ??
        (accessRevoked
          ? editableArtifactStatusLabel(view)
          : metadata
            ? `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}`
            : editableArtifactStatusLabel(view))
      }
      actions={
        download ? (
          <>
            {actions}
            <SpreadsheetDownloadButton session={session} title={title} download={download} />
          </>
        ) : (
          actions
        )
      }
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
                className="mt-3 rounded-og-sm border border-og-primary-border bg-og-primary text-og-primary-fg px-3 py-1.5 text-og-sm font-medium hover:bg-og-primary-hover outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent disabled:opacity-50"
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

/** Inline authoring state only; the tab label always comes from canonical metadata. */
function EditableWorksheetTab({
  session,
  sheet,
  sheets,
  selected,
  writable,
  onSelect,
  onCommandError,
}: {
  session: EditableArtifactSession;
  sheet: EditableSpreadsheetSheetMetadata;
  sheets: readonly EditableSpreadsheetSheetMetadata[];
  selected: boolean;
  writable: boolean;
  onSelect: () => void;
  onCommandError?: ((error: Error) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sheet.name);
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const latestRef = useRef({ session, sheet, writable });
  latestRef.current = { session, sheet, writable };
  const errorId = useId();
  const canRename = writable && sheet.generationId !== null;
  const scopeRef = useRef({
    session,
    sheetId: sheet.sheetId,
    generationId: sheet.generationId,
    canRename,
  });
  if (
    scopeRef.current.session !== session ||
    scopeRef.current.sheetId !== sheet.sheetId ||
    scopeRef.current.generationId !== sheet.generationId ||
    scopeRef.current.canRename !== canRename
  ) {
    scopeRef.current = {
      session,
      sheetId: sheet.sheetId,
      generationId: sheet.generationId,
      canRename,
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setAccepted(false);
    setError(null);
    busyRef.current = false;
  }, [session, sheet.generationId, sheet.sheetId, canRename]);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    if (!accepted || !editing || sheet.name !== name) return;
    const restoreFocus =
      document.activeElement === document.body || document.activeElement === inputRef.current;
    setEditing(false);
    setSaving(false);
    setAccepted(false);
    busyRef.current = false;
    if (restoreFocus) queueMicrotask(() => tabRef.current?.focus({ preventScroll: true }));
  }, [accepted, editing, name, sheet.name]);

  const start = () => {
    if (!canRename || busyRef.current) return;
    onSelect();
    setName(sheet.name);
    setError(null);
    setAccepted(false);
    setEditing(true);
  };
  const cancel = () => {
    if (busyRef.current) return;
    setEditing(false);
    setError(null);
    queueMicrotask(() => tabRef.current?.focus({ preventScroll: true }));
  };
  const rename = async () => {
    if (!canRename || busyRef.current) return;
    const generation = sheetGeneration(sheet);
    if (!generation) return;
    const next = name.trim();
    if (!next || next.length > 31 || /[\\/?*[\]:\0]/u.test(next)) {
      setError("Use 1–31 characters without \\ / ? * [ ] :.");
      return;
    }
    if (sheets.some((other) => other.sheetId !== sheet.sheetId && other.name === next)) {
      setError("A worksheet already has this name.");
      return;
    }
    if (next === sheet.name) {
      cancel();
      return;
    }
    setName(next);
    setError(null);
    setSaving(true);
    busyRef.current = true;
    const scope = scopeRef.current;
    const current = () =>
      mountedRef.current && scopeRef.current === scope && latestRef.current.writable;
    try {
      await session.applySpreadsheetCommands({
        version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
        commands: [{ kind: "sheet.rename", sheet: generation, name: next }],
      });
      if (current()) setAccepted(true);
    } catch (cause) {
      if (!current()) return;
      const failure = asError(cause);
      busyRef.current = false;
      setSaving(false);
      setError(failure.message || "Could not rename worksheet. Try again.");
      onCommandError?.(failure);
      queueMicrotask(() => inputRef.current?.focus());
    }
  };

  const tab = (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      tabIndex={editing && canRename ? -1 : undefined}
      aria-selected={selected}
      aria-keyshortcuts={canRename ? "F2" : undefined}
      title={canRename ? "Double-click or press F2 to rename" : undefined}
      onClick={onSelect}
      onDoubleClick={start}
      onKeyDown={(event) => {
        if (event.key === "F2") {
          event.preventDefault();
          start();
        }
      }}
      className={cn(
        "h-7 shrink-0 rounded-og-sm px-2.5 text-og-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-og-accent",
        selected
          ? "bg-og-surface-3 font-medium text-og-fg"
          : "text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg",
      )}
    >
      {sheet.name}
    </button>
  );

  return editing && canRename ? (
    <>
      <span className="sr-only">{tab}</span>
      <form
        className="flex min-w-0 flex-wrap items-center gap-1 py-1"
        style={{ width: "min(18rem, 100%)" }}
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <input
          ref={inputRef}
          aria-label="Worksheet name"
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={saving}
          value={name}
          onInput={(event) => {
            setName(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              void rename();
            }
          }}
          className="h-7 w-40 rounded-og-sm border border-og-border bg-og-surface-1 px-2 text-og-sm text-og-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent disabled:opacity-50"
        />
        {saving ? (
          <span role="status" className="text-og-xs text-og-fg-muted">
            Renaming…
          </span>
        ) : (
          <>
            <button
              type="submit"
              className="rounded-og-sm px-2 py-1 text-og-xs text-og-fg outline-hidden hover:bg-og-surface-3 focus-visible:ring-2 focus-visible:ring-og-accent"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-og-sm px-2 py-1 text-og-xs text-og-fg-muted outline-hidden hover:bg-og-surface-3 focus-visible:ring-2 focus-visible:ring-og-accent"
            >
              Cancel
            </button>
          </>
        )}
        {error ? (
          <span
            id={errorId}
            role="alert"
            className="text-og-xs text-og-status-failed"
            style={{ flexBasis: "100%", overflowWrap: "anywhere" }}
          >
            {error}
          </span>
        ) : null}
      </form>
    </>
  ) : (
    tab
  );
}

function spreadsheetSessionKey(session: EditableArtifactSession): number {
  let key = SESSION_KEYS.get(session);
  if (key === undefined) {
    key = ++nextSessionKey;
    SESSION_KEYS.set(session, key);
  }
  return key;
}

function useSpreadsheetAuthoringLifetime() {
  const lifetime = useRef<object | null>({});
  useClientLayoutEffect(() => {
    lifetime.current = {};
    return () => {
      lifetime.current = null;
    };
  }, []);
  return lifetime;
}

function requireSpreadsheetAuthoringLifetime(lifetime: { current: object | null }): object {
  if (!lifetime.current) throw new Error("Spreadsheet authoring session changed");
  return lifetime.current;
}

function useSpreadsheetMetadata(session: EditableArtifactSession): {
  metadata: EditableSpreadsheetMetadataProjection | null;
  error: Error | null;
} {
  const [state, setState] = useState<{
    session: EditableArtifactSession;
    metadata: EditableSpreadsheetMetadataProjection | null;
    error: Error | null;
  }>({ session, metadata: null, error: null });
  useEffect(() => {
    let active = true;
    const unsubscribe = session.subscribeSpreadsheetMetadata(
      {},
      (metadata) => {
        if (active) setState({ session, metadata, error: null });
      },
      {
        onError: (error) => {
          if (active)
            setState((current) =>
              current.session === session
                ? { ...current, error }
                : { session, metadata: null, error },
            );
        },
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session]);
  return state.session === session ? state : { metadata: null, error: null };
}

function projectSdkViewport(
  sheet: EditableSpreadsheetSheetMetadata,
  metadataRevision: bigint,
  query: EditableSpreadsheetViewportQuery,
  viewport: EditableSpreadsheetViewportProjection | null,
  rowCount: number,
  columnCount: number,
): SpreadsheetGridProjection {
  // Keep the last valid bounded coverage while a resize/scroll query is replaced.
  // Never carry cells across a session, sheet, or generation boundary.
  const current =
    viewport && viewport.sheetId === sheet.sheetId && viewport.generationId === sheet.generationId
      ? viewport
      : null;
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
    revision: current?.revision.toString() ?? "loading",
    dimensionRevision: metadataRevision.toString(),
    defaultRowHeight: sheet.defaultRowHeight,
    defaultColumnWidth: sheet.defaultColumnWidth,
    rowHeights: sheet.rowHeights,
    columnWidths: sheet.columnWidths,
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
  if (kind === "formula") return { formula: input };
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
