import { describe, expect, test } from "bun:test";
import type {
  EditableArtifactPendingTransaction,
  EditableArtifactSession,
  EditableArtifactSyncListener,
  EditableArtifactSyncView,
  EditableSpreadsheetMetadataListener,
  EditableSpreadsheetViewportListener,
  EditableSpreadsheetViewportQuery,
} from "@opengeni/sdk/editable-artifacts";
import {
  editableArtifactStableId,
  spreadsheetSheetId,
  type SpreadsheetArtifactCommandBatch,
} from "@opengeni/sdk/editable-artifacts";

import {
  EditableSpreadsheetArtifactSurface,
  EditableSpreadsheetGrid,
} from "../src/components/artifacts/editable-spreadsheet";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHEET_ID = spreadsheetSheetId("00000000000000010000000000000001");
const GENERATION_ID = editableArtifactStableId("11111111111111111111111111111111");

function replaceInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function pasteEvent(plainText: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? plainText : ""),
    },
  });
  return event;
}

function copyEvent(): { event: Event; values: Map<string, string> } {
  const values = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (type: string, value: string) => values.set(type, value),
    },
  });
  return { event, values };
}

class FakeEditableSpreadsheetSession {
  readonly artifactId = ARTIFACT_ID;
  readonly modality = "spreadsheet" as const;
  readonly applied: SpreadsheetArtifactCommandBatch[] = [];
  readonly viewportQueries: EditableSpreadsheetViewportQuery[] = [];
  readonly viewportCallbacks: EditableSpreadsheetViewportListener[] = [];
  createCalls = 0;
  deferViewport = false;
  sheetName = "Data";
  renameResult: Promise<void> | null = null;
  private revision = 1n;
  private value = "from Worker";
  private projectedDate: string | null = null;
  private readonly rowHeights = new Map<number, number>();
  private readonly columnWidths = new Map<number, number>();
  private readonly metadataListeners = new Set<EditableSpreadsheetMetadataListener>();
  private view: EditableArtifactSyncView = {
    artifactId: ARTIFACT_ID,
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
  private readonly viewListeners = new Set<EditableArtifactSyncListener>();
  private readonly viewportListeners = new Set<{
    query: EditableSpreadsheetViewportQuery;
    listener: EditableSpreadsheetViewportListener;
  }>();

  start(): void {}
  async whenReady(): Promise<void> {}
  async close(): Promise<void> {}
  getView(): EditableArtifactSyncView {
    return this.view;
  }
  subscribe(listener: EditableArtifactSyncListener): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }
  async queueCommands(): Promise<EditableArtifactPendingTransaction> {
    return pending();
  }
  async applySpreadsheetCommands(
    batch: SpreadsheetArtifactCommandBatch,
  ): Promise<EditableArtifactPendingTransaction> {
    this.applied.push(batch);
    const command = batch.commands[0];
    if (command?.kind === "cells.set") {
      const cell = command.cells[0];
      this.value =
        typeof cell === "object" && cell !== null && "formula" in cell
          ? cell.formula
          : cell === null
            ? ""
            : String(cell);
    } else if (command?.kind === "range.clear") {
      this.value = "";
    } else if (command?.kind === "column.width.set") {
      if (command.width === null) this.columnWidths.delete(command.column);
      else this.columnWidths.set(command.column, command.width);
    } else if (command?.kind === "row.height.set") {
      if (command.height === null) this.rowHeights.delete(command.row);
      else this.rowHeights.set(command.row, command.height);
    } else if (command?.kind === "sheet.rename") {
      await this.renameResult;
      this.sheetName = command.name;
    }
    this.revision += 1n;
    this.publishViewports();
    return pending();
  }
  async createSpreadsheetSheet(): Promise<{
    sheetId: string;
    pending: EditableArtifactPendingTransaction;
  }> {
    this.createCalls += 1;
    return {
      sheetId: "00000000000000020000000000000001",
      pending: pending(),
    };
  }
  async querySpreadsheetViewport(query: EditableSpreadsheetViewportQuery) {
    return this.viewport(query);
  }
  subscribeSpreadsheetViewport(
    query: EditableSpreadsheetViewportQuery,
    listener: EditableSpreadsheetViewportListener,
  ): () => void {
    this.viewportQueries.push(query);
    this.viewportCallbacks.push(listener);
    const entry = { query, listener };
    this.viewportListeners.add(entry);
    if (!this.deferViewport) listener(this.viewport(query));
    return () => this.viewportListeners.delete(entry);
  }
  async querySpreadsheetMetadata() {
    return this.metadata();
  }
  subscribeSpreadsheetMetadata(
    _query: Record<string, never>,
    listener: EditableSpreadsheetMetadataListener,
  ): () => void {
    this.metadataListeners.add(listener);
    listener(this.metadata());
    return () => this.metadataListeners.delete(listener);
  }

  setWritable(writable: boolean): void {
    this.view = { ...this.view, writable };
    for (const listener of this.viewListeners) listener(this.view);
  }

  setPendingTransactions(pendingTransactions: number): void {
    this.view = { ...this.view, pendingTransactions };
    for (const listener of this.viewListeners) listener(this.view);
  }

  setAuthoringBlocked(blocked: boolean): void {
    this.view = { ...this.view, authoringBlockedReason: blocked ? "prior_writer" : undefined };
    for (const listener of this.viewListeners) listener(this.view);
  }

  setProjectedDate(value: string): void {
    this.projectedDate = value;
    this.publishViewports();
  }

  revokeReadAccess(): void {
    this.view = {
      ...this.view,
      state: "failed",
      writable: false,
      lastError: Object.assign(new Error("permission changed"), {
        code: "permission_changed",
      }),
    };
    for (const listener of this.viewListeners) listener(this.view);
  }

  private viewport(query: EditableSpreadsheetViewportQuery) {
    const includesOrigin =
      query.startRow === 0 &&
      query.startColumn === 0 &&
      query.rowCount > 0 &&
      query.columnCount > 0;
    return {
      revision: this.revision,
      sheetId: SHEET_ID,
      generationId: GENERATION_ID,
      startRow: query.startRow,
      startColumn: query.startColumn,
      rowCount: query.rowCount,
      columnCount: query.columnCount,
      cells: includesOrigin
        ? [
            {
              row: 0,
              column: 0,
              formula: this.value.startsWith("=") ? this.value : null,
              value: this.projectedDate
                ? { kind: "date" as const, value: this.projectedDate }
                : { kind: "text" as const, value: this.value },
            },
          ]
        : [],
    };
  }

  private publishViewports(): void {
    for (const listener of this.metadataListeners) listener(this.metadata());
    for (const { query, listener } of this.viewportListeners) listener(this.viewport(query));
  }
  private metadata() {
    const result = metadata(this.revision, [...this.rowHeights], [...this.columnWidths]);
    return {
      ...result,
      sheets: result.sheets.map((sheet) => ({ ...sheet, name: this.sheetName })),
    };
  }
}

describe("SDK-backed editable spreadsheet", () => {
  test("viewport replacement keeps covered cells visible while the Worker query is pending", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const sheet = metadata().sheets[0]!;
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={sheet}
        metadataRevision={1n}
      />,
    );
    await flush();
    fake.deferViewport = true;
    const grid = rendered.container.querySelector<HTMLElement>('[role="grid"]')!;
    const queries = fake.viewportQueries.length;
    await actRun(() => {
      Object.defineProperty(grid, "clientWidth", { configurable: true, value: 300 });
      window.dispatchEvent(new Event("resize"));
    });
    await flush(30);
    expect(fake.viewportQueries.length).toBeGreaterThan(queries);
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe(
      "from Worker",
    );
    await rendered.unmount();
  });

  test("a retained viewport never crosses sessions or sheet generations, even with late callbacks", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const sheet = metadata().sheets[0]!;
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={sheet}
        metadataRevision={1n}
      />,
    );
    const oldCallback = fake.viewportCallbacks.at(-1)!;
    const oldProjection = await fake.querySpreadsheetViewport(fake.viewportQueries.at(-1)!);
    fake.deferViewport = true;
    await rendered.rerender(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={{ ...sheet, generationId: "22222222222222222222222222222222" }}
        metadataRevision={2n}
      />,
    );
    await actRun(() => oldCallback(oldProjection));
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("");
    const replacement = new FakeEditableSpreadsheetSession();
    replacement.deferViewport = true;
    await rendered.rerender(
      <EditableSpreadsheetGrid
        session={replacement as unknown as EditableArtifactSession}
        sheet={sheet}
        metadataRevision={1n}
      />,
    );
    await actRun(() => oldCallback(oldProjection));
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("");
    await rendered.unmount();
  });

  test("double-click renames through the canonical generation-pinned command", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    let accept!: () => void;
    fake.renameResult = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const rendered = await renderComponent(
      <EditableSpreadsheetArtifactSurface session={fake as unknown as EditableArtifactSession} />,
    );
    const tab = rendered.container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await actRun(() => tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="Worksheet name"]',
    )!;
    expect(input).not.toBeNull();
    expect(
      rendered.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Data");
    await actRun(() => replaceInputValue(input, "Forecast"));
    await actRun(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(fake.applied[0]?.commands).toEqual([
      {
        kind: "sheet.rename",
        sheet: { kind: "generation", sheetId: SHEET_ID, creationOperationId: GENERATION_ID },
        name: "Forecast",
      },
    ]);
    expect(input.disabled).toBe(true);
    expect(rendered.container.textContent).toContain("Renaming");
    await actRun(() => accept());
    expect(rendered.container.querySelector('[role="tab"]')?.textContent).toBe("Forecast");
    expect(rendered.container.querySelector('[aria-label="Worksheet name"]')).toBeNull();
    await rendered.unmount();
  });

  test("F2 rename validates, Escape cancels, and failures preserve the proposed name for retry", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const rendered = await renderComponent(
      <EditableSpreadsheetArtifactSurface session={fake as unknown as EditableArtifactSession} />,
    );
    const tab = () => rendered.container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    const input = () =>
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Worksheet name"]')!;
    const press = (target: Element, key: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await actRun(() => press(tab(), "F2"));
    expect(document.activeElement).toBe(input());
    for (const invalid of ["", "bad/name", "x".repeat(32)]) {
      await actRun(() => replaceInputValue(input(), invalid));
      await actRun(() => press(input(), "Enter"));
      expect(fake.applied).toHaveLength(0);
      expect(input().getAttribute("aria-invalid")).toBe("true");
      expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
    }
    await actRun(() => press(input(), "Escape"));
    expect(tab().textContent).toBe("Data");
    expect(document.activeElement).toBe(tab());
    await actRun(() => press(tab(), "F2"));
    await actRun(() => replaceInputValue(input(), "Forecast"));
    fake.renameResult = Promise.reject(new Error("Rename not accepted"));
    // Keep the rejected promise observed until the fake is invoked by the editor.
    void fake.renameResult.catch(() => {});
    await actRun(() => press(input(), "Enter"));
    expect(input().value).toBe("Forecast");
    expect(input().disabled).toBe(false);
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Rename not accepted",
    );
    fake.renameResult = null;
    await actRun(() => press(input(), "Enter"));
    expect(fake.applied).toHaveLength(2);
    expect(tab().textContent).toBe("Forecast");
    await rendered.unmount();
  });

  test("rename is unavailable without write authority and late failures cannot affect a restored editor", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    let reject!: (cause: unknown) => void;
    fake.renameResult = new Promise<void>((_resolve, no) => {
      reject = no;
    });
    const rendered = await renderComponent(
      <EditableSpreadsheetArtifactSurface session={fake as unknown as EditableArtifactSession} />,
    );
    const press = (target: Element, key: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const tab = () => rendered.container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await actRun(() => press(tab(), "F2"));
    const input = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="Worksheet name"]',
    )!;
    await actRun(() => replaceInputValue(input, "Old request"));
    await actRun(() => press(input, "Enter"));
    await actRun(() => fake.setWritable(false));
    await actRun(() => press(tab(), "F2"));
    expect(rendered.container.querySelector('[aria-label="Worksheet name"]')).toBeNull();
    expect(tab().hasAttribute("aria-keyshortcuts")).toBe(false);
    await actRun(() => fake.setWritable(true));
    await actRun(() => press(tab(), "F2"));
    await actRun(() => reject(new Error("Late old failure")));
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Worksheet name"]')?.value,
    ).toBe("Data");
    await rendered.unmount();
  });

  test("direct grids honor session write authority and server pending state", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const sheet = metadata().sheets[0]!;
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={sheet}
        metadataRevision={1n}
      />,
    );
    await actRun(() => fake.setPendingTransactions(1));
    expect(
      rendered.container.querySelector('[aria-label="Spreadsheet sync status"]')?.textContent,
    ).toBe("Saving…");
    await actRun(() => fake.setAuthoringBlocked(true));
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')
        ?.readOnly,
    ).toBe(true);
    expect(
      rendered.container.querySelector('[aria-label="Spreadsheet sync status"]')?.textContent,
    ).toBe("Waiting for earlier edits…");
    await actRun(() => fake.setAuthoringBlocked(false));
    await actRun(() => fake.setWritable(false));
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')
        ?.readOnly,
    ).toBe(true);
    expect(rendered.container.querySelector('[aria-label="Resize column A"]')).toBeNull();
    await actRun(() => fake.setPendingTransactions(0));
    expect(
      rendered.container.querySelector('[aria-label="Spreadsheet sync status"]')?.textContent,
    ).toBe("Read only");
    await actRun(() => fake.revokeReadAccess());
    expect(rendered.container.textContent).not.toContain("from Worker");
    expect(rendered.container.querySelector('[role="grid"]')).toBeNull();
    await rendered.unmount();
  });
  test("hides cached cells and sheet names after read access is revoked", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const rendered = await renderComponent(
      <EditableSpreadsheetArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Restricted workbook"
      />,
    );
    await flush(30);
    expect(rendered.container.textContent).toContain("Data");
    expect(rendered.container.textContent).toContain("from Worker");

    await actRun(() => fake.revokeReadAccess());
    await flush();
    expect(rendered.container.textContent).not.toContain("Data");
    expect(rendered.container.textContent).not.toContain("from Worker");
    expect(rendered.container.textContent).toContain("You no longer have access");
    await rendered.unmount();
  });

  test("renders only a bounded Worker projection and submits canonical typed commands", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const session = fake as unknown as EditableArtifactSession;
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={session}
        sheet={metadata().sheets[0]!}
        metadataRevision={1n}
      />,
    );
    await flush();

    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe(
      "from Worker",
    );
    expect(fake.viewportQueries[0]).toMatchObject({
      sheetId: SHEET_ID,
      startRow: 0,
      startColumn: 0,
      rowCount: 64,
      columnCount: 32,
    });

    const formula = rendered.container.querySelector<HTMLInputElement>(
      'input[aria-label="Formula or value"]',
    )!;
    await actRun(() => {
      formula.focus();
      replaceInputValue(formula, "=1+2");
    });
    await flush();
    await actRun(() => {
      formula.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(fake.applied).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(fake.applied[0]))).toEqual({
      version: 2,
      commands: [
        {
          kind: "cells.set",
          sheet: {
            kind: "generation",
            sheetId: SHEET_ID,
            creationOperationId: GENERATION_ID,
          },
          anchor: { row: 0, column: 0 },
          rows: 1,
          columns: 1,
          cells: [{ formula: "=1+2" }],
        },
      ],
    });
    expect(rendered.container.querySelector('[data-og-cell="A1"]')?.textContent).toBe("=1+2");
    await rendered.unmount();
  });

  test("renders canonical Worker date projections as dates instead of object text", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={metadata().sheets[0]!}
        metadataRevision={1n}
      />,
    );
    await flush();
    await actRun(() => fake.setProjectedDate("2026-08-09T12:34:56.789Z"));
    await flush();

    const text = rendered.container.querySelector('[data-og-cell="A1"]')?.textContent ?? "";
    expect(text).toContain("2026");
    expect(text).not.toContain("[object Object]");
    await rendered.unmount();
  });

  test("surface follows live write authority and creates sheets through the SDK allocator", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const session = fake as unknown as EditableArtifactSession;
    const rendered = await renderComponent(
      <EditableSpreadsheetArtifactSurface session={session} />,
    );
    await flush();

    expect(rendered.container.querySelector('[role="tab"]')?.textContent).toBe("Data");
    const add = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add worksheet"]',
    )!;
    await actRun(() => add.click());
    await flush();
    expect(fake.createCalls).toBe(1);

    await actRun(() => fake.setWritable(false));
    await flush();
    expect(rendered.container.querySelector('button[aria-label="Add worksheet"]')).toBeNull();
    expect(
      rendered.container.querySelector<HTMLInputElement>('input[aria-label="Formula or value"]')
        ?.readOnly,
    ).toBe(true);
    await rendered.unmount();
  });

  test("pastes a bounded rectangle through one canonical durable command", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={metadata().sheets[0]!}
        metadataRevision={1n}
      />,
    );
    await flush();

    const grid = rendered.container.querySelector<HTMLDivElement>('[role="grid"]')!;
    const copied = copyEvent();
    await actRun(() => grid.dispatchEvent(copied.event));
    expect(copied.values.get("text/plain")).toBe("from Worker");

    await actRun(() => grid.dispatchEvent(pasteEvent('1\t=1+1\r\nTRUE\t"hello\tworld"\r\n')));
    await flush();

    expect(fake.applied).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(fake.applied[0]))).toEqual({
      version: 2,
      commands: [
        {
          kind: "cells.set",
          sheet: {
            kind: "generation",
            sheetId: SHEET_ID,
            creationOperationId: GENERATION_ID,
          },
          anchor: { row: 0, column: 0 },
          rows: 2,
          columns: 2,
          cells: [1, { formula: "=1+1" }, true, "hello\tworld"],
        },
      ],
    });
    expect(grid.getAttribute("aria-activedescendant")).toContain("cell-1-1");
    await rendered.unmount();
  });

  test("commits dimensions through generation-pinned commands and reconciles metadata", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const rendered = await renderComponent(
      <EditableSpreadsheetArtifactSurface session={fake as unknown as EditableArtifactSession} />,
    );
    await flush();
    const column = rendered.container.querySelector<HTMLElement>('[aria-label="Resize column A"]')!;
    await actRun(() => {
      column.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      column.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
    });
    await flush();
    expect(fake.applied[0]?.commands).toEqual([
      {
        kind: "column.width.set",
        sheet: { kind: "generation", sheetId: SHEET_ID, creationOperationId: GENERATION_ID },
        column: 0,
        width: 104,
      },
    ]);
    expect(column.getAttribute("aria-valuenow")).toBe("104");
    await actRun(() => {
      column.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      column.dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }));
    });
    await flush();
    expect(fake.applied[1]?.commands[0]).toMatchObject({ kind: "column.width.set", width: null });
    expect(column.getAttribute("aria-valuenow")).toBe("96");

    const row = rendered.container.querySelector<HTMLElement>('[aria-label="Resize row 1"]')!;
    await actRun(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      row.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
    });
    await flush();
    expect(fake.applied[2]?.commands[0]).toMatchObject({
      kind: "row.height.set",
      row: 0,
      height: 32,
    });
    expect(row.getAttribute("aria-valuenow")).toBe("32");
    await rendered.unmount();
  });

  test("does not offer resize controls for a kernel without dimension projections", async () => {
    const fake = new FakeEditableSpreadsheetSession();
    const sheet = metadata().sheets[0]!;
    const rendered = await renderComponent(
      <EditableSpreadsheetGrid
        session={fake as unknown as EditableArtifactSession}
        sheet={{
          sheetId: sheet.sheetId,
          generationId: sheet.generationId,
          name: sheet.name,
          usedBounds: sheet.usedBounds,
        }}
        metadataRevision={1n}
      />,
    );
    await flush();
    expect(rendered.container.querySelector('[role="separator"]')).toBeNull();
    expect(
      rendered.container.querySelector<HTMLInputElement>('[aria-label="Formula or value"]')
        ?.readOnly,
    ).toBe(false);
    await rendered.unmount();
  });
});

function metadata(
  revision = 1n,
  rowHeights: readonly (readonly [number, number])[] = [],
  columnWidths: readonly (readonly [number, number])[] = [],
) {
  return {
    revision,
    modeledFeatures: { dimensions: true, hidden: false, merges: false },
    sheets: [
      {
        sheetId: SHEET_ID,
        generationId: GENERATION_ID,
        name: "Data",
        usedBounds: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
        defaultRowHeight: 24,
        defaultColumnWidth: 96,
        rowHeights,
        columnWidths,
      },
    ],
  } as const;
}

function pending(): EditableArtifactPendingTransaction {
  return {
    modality: "spreadsheet",
    artifactId: ARTIFACT_ID,
    clientTransactionId: "test-transaction",
    requestHash: `sha256:${"a".repeat(64)}`,
    protocolVersion: 1,
    modelSchemaVersion: 2,
    commandVersion: 2,
    replicaId: "1111111111111111",
    replicaCounter: 1,
    previousLocalTransactionId: null,
    observedHeadSequence: 1,
    causalBase: [],
    selectiveUndoTargets: [],
    commandBytes: new Uint8Array([1]),
    intentBytes: new Uint8Array([1]),
    createdAt: 1,
  };
}
