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
import type { SpreadsheetArtifactCommandBatch } from "@opengeni/sdk/editable-artifacts";

import {
  EditableSpreadsheetArtifactSurface,
  EditableSpreadsheetGrid,
} from "../src/components/artifacts/editable-spreadsheet";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHEET_ID = "00000000000000010000000000000001";
const GENERATION_ID = "11111111111111111111111111111111";

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
  createCalls = 0;
  private revision = 1n;
  private value = "from Worker";
  private projectedDate: string | null = null;
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
    const entry = { query, listener };
    this.viewportListeners.add(entry);
    listener(this.viewport(query));
    return () => this.viewportListeners.delete(entry);
  }
  async querySpreadsheetMetadata() {
    return metadata();
  }
  subscribeSpreadsheetMetadata(
    _query: Record<string, never>,
    listener: EditableSpreadsheetMetadataListener,
  ): () => void {
    listener(metadata());
    return () => {};
  }

  setWritable(writable: boolean): void {
    this.view = { ...this.view, writable };
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
    for (const { query, listener } of this.viewportListeners) listener(this.viewport(query));
  }
}

describe("SDK-backed editable spreadsheet", () => {
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
      version: 1,
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
          cells: [{ formula: "=1+2", cached: null }],
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
      version: 1,
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
          cells: [1, { formula: "=1+1", cached: null }, true, "hello\tworld"],
        },
      ],
    });
    expect(grid.getAttribute("aria-activedescendant")).toContain("cell-1-1");
    await rendered.unmount();
  });
});

function metadata() {
  return {
    revision: 1n,
    modeledFeatures: { dimensions: false, hidden: false, merges: false },
    sheets: [
      {
        sheetId: SHEET_ID,
        generationId: GENERATION_ID,
        name: "Data",
        usedBounds: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
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
    modelSchemaVersion: 1,
    commandVersion: 1,
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
