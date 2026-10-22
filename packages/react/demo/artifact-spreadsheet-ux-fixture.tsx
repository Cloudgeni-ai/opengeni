import type {
  EditableArtifactSession,
  EditableArtifactSyncView,
  EditableSpreadsheetMetadataProjection,
  EditableSpreadsheetViewportProjection,
  EditableSpreadsheetViewportQuery,
  SpreadsheetArtifactCommandBatch,
} from "@opengeni/sdk/editable-artifacts";
import { createRoot } from "react-dom/client";

import { EditableSpreadsheetArtifactSurface } from "@opengeni/react/artifacts/spreadsheet";

const sheetId = "00000000000000010000000000000001";
const generationId = "11111111111111111111111111111111";

/** Actual production UI with deliberately simulated SDK projection/ack wiring. No persistence. */
export function mountSpreadsheetUxFixture(
  target: HTMLElement,
  options: {
    download?: (signal: AbortSignal) => Promise<Blob>;
    showHeader?: boolean;
    authoringDelay?: number;
  } = {},
) {
  const calls: SpreadsheetArtifactCommandBatch[] = [];
  const values = new Map<string, string>();
  ["Period", "Revenue", "Expenses", "Net income", "Region", "Forecast"].forEach((value, col) =>
    values.set(`0:${col}`, value),
  );
  for (let row = 1; row <= 900; row++) {
    values.set(`${row}:0`, `Period ${row}`);
    values.set(`${row}:1`, String(120000 + row * 127));
    values.set(`${row}:3`, String(43000 + row * 19));
  }
  const columns = new Map<number, number>();
  const rows = new Map<number, number>();
  let revision = 1n;
  let dimensionRevision = 1n;
  let name = "Forecast";
  let failNext = false;
  let view: EditableArtifactSyncView = {
    artifactId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    modality: "spreadsheet",
    state: "live",
    cursor: 1,
    headSequence: 1,
    writable: true,
    pendingTransactions: 0,
    blockedPending: [],
    queuedMessages: 0,
    reconnectAttempt: 0,
    lastError: null,
  };
  const metadataListeners = new Set<(projection: EditableSpreadsheetMetadataProjection) => void>();
  const viewportListeners = new Set<{
    query: EditableSpreadsheetViewportQuery;
    listener: (projection: EditableSpreadsheetViewportProjection) => void;
  }>();
  const viewListeners = new Set<(view: EditableArtifactSyncView) => void>();
  const metadata = (): EditableSpreadsheetMetadataProjection => ({
    revision: dimensionRevision,
    modeledFeatures: { dimensions: true, hidden: false, merges: false },
    sheets: [
      {
        sheetId,
        generationId,
        name,
        defaultRowHeight: 24,
        defaultColumnWidth: 128,
        rowHeights: [...rows],
        columnWidths: [...columns],
        usedBounds: { startRow: 0, startColumn: 0, endRow: 900, endColumn: 5 },
      },
    ],
  });
  const viewport = (
    query: EditableSpreadsheetViewportQuery,
  ): EditableSpreadsheetViewportProjection => ({
    ...query,
    sheetId,
    generationId,
    revision,
    cells: [...values]
      .map(([key, value]) => {
        const [row, column] = key.split(":").map(Number);
        // This fixture never computes formula outputs.
        return {
          row: row!,
          column: column!,
          formula: value.startsWith("=") ? value : null,
          value: value.startsWith("=")
            ? { kind: "empty" as const }
            : { kind: "text" as const, value },
        };
      })
      .filter(
        (cell) =>
          cell.row >= query.startRow &&
          cell.row < query.startRow + query.rowCount &&
          cell.column >= query.startColumn &&
          cell.column < query.startColumn + query.columnCount,
      ),
  });
  const updateView = (patch: Partial<EditableArtifactSyncView>) => {
    view = { ...view, ...patch };
    for (const listener of viewListeners) listener(view);
  };
  const session = {
    artifactId: view.artifactId,
    modality: "spreadsheet",
    getView: () => view,
    subscribe(listener: (view: EditableArtifactSyncView) => void) {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    subscribeSpreadsheetMetadata(
      _query: unknown,
      listener: (projection: EditableSpreadsheetMetadataProjection) => void,
    ) {
      metadataListeners.add(listener);
      listener(metadata());
      return () => metadataListeners.delete(listener);
    },
    subscribeSpreadsheetViewport(
      query: EditableSpreadsheetViewportQuery,
      listener: (projection: EditableSpreadsheetViewportProjection) => void,
    ) {
      const entry = { query, listener };
      viewportListeners.add(entry);
      const timer = setTimeout(() => listener(viewport(query)), 150);
      return () => {
        clearTimeout(timer);
        viewportListeners.delete(entry);
      };
    },
    async applySpreadsheetCommands(batch: SpreadsheetArtifactCommandBatch) {
      calls.push(batch);
      const fail = failNext;
      failNext = false;
      // Model the real SDK's async authoring before its pending WAL is visible.
      if (options.authoringDelay)
        await new Promise<void>((resolve) => setTimeout(resolve, options.authoringDelay));
      updateView({ pendingTransactions: view.pendingTransactions + 1 });
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (fail) {
        updateView({ pendingTransactions: Math.max(0, view.pendingTransactions - 1) });
        throw new Error("Simulated rename failure. Try again.");
      }
      for (const command of batch.commands) {
        if (command.kind === "sheet.rename") name = command.name;
        else if (command.kind === "cells.set") {
          for (let row = 0; row < command.rows; row++)
            for (let col = 0; col < command.columns; col++) {
              const value = command.cells[row * command.columns + col];
              values.set(
                `${command.anchor.row + row}:${command.anchor.column + col}`,
                value === null || value === undefined
                  ? ""
                  : typeof value === "object"
                    ? "formula" in value
                      ? value.formula
                      : "date" in value
                        ? value.date
                        : value.error
                    : String(value),
              );
            }
          revision++;
        } else if (command.kind === "column.width.set") {
          if (command.width === null) columns.delete(command.column);
          else columns.set(command.column, command.width);
        } else if (command.kind === "row.height.set") {
          if (command.height === null) rows.delete(command.row);
          else rows.set(command.row, command.height);
        }
      }
      dimensionRevision++;
      for (const listener of metadataListeners) listener(metadata());
      for (const { query, listener } of viewportListeners) listener(viewport(query));
      setTimeout(
        () => updateView({ pendingTransactions: Math.max(0, view.pendingTransactions - 1) }),
        1200,
      );
      return { clientTransactionId: `simulated-${calls.length}` };
    },
  } as unknown as EditableArtifactSession;
  const root = createRoot(target);
  root.render(
    <EditableSpreadsheetArtifactSurface
      session={session}
      title="Forecast workbook"
      subtitle="Sample data · simulated SDK sync"
      rowCount={200000}
      columnCount={32}
      allowAddSheet={false}
      {...options}
    />,
  );
  return {
    calls,
    values,
    failNext: () => {
      failNext = true;
    },
    setWritable: (writable: boolean) => updateView({ writable }),
    setPending: (pendingTransactions: number) => updateView({ pendingTransactions }),
    getName: () => name,
    unmount: () => root.unmount(),
  };
}
