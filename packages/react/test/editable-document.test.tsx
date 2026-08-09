import { describe, expect, test } from "bun:test";
import type {
  DocumentArtifactCommandBatch,
  DocumentArtifactProjection,
  DocumentArtifactQuery,
  EditableArtifactPendingTransaction,
  EditableArtifactSession,
  EditableArtifactSyncListener,
  EditableArtifactSyncView,
} from "@opengeni/sdk/editable-artifacts";

import {
  composeDocumentEditorProjection,
  EditableDocumentArtifactSurface,
  minimalUtf16TextEdit,
} from "../src/components/artifacts/editable-document";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PARAGRAPH_ID = "p/0123456789abcdef0000000000000008";
const SECTION_ID = "sec/0123456789abcdef0000000000000001";

class FakeDocumentSession {
  readonly artifactId = ARTIFACT_ID;
  readonly modality = "document" as const;
  readonly commands: DocumentArtifactCommandBatch[] = [];
  readonly queries: DocumentArtifactQuery[] = [];
  createCalls = 0;
  createFailures = 0;
  private createGate: Promise<void> | null = null;
  private releaseCreate: (() => void) | null = null;
  private revision = 1n;
  private text: string;
  private hasParagraph: boolean;
  private view: EditableArtifactSyncView = {
    artifactId: ARTIFACT_ID,
    modality: "document",
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
  private listeners = new Set<EditableArtifactSyncListener>();

  constructor(initialText: string | null = "Alpha 😀 omega") {
    this.text = initialText ?? "";
    this.hasParagraph = initialText !== null;
  }

  start(): void {}
  async whenReady(): Promise<void> {}
  async close(): Promise<void> {}
  getView(): EditableArtifactSyncView {
    return this.view;
  }
  subscribe(listener: EditableArtifactSyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    for (const listener of this.listeners) listener(this.view);
  }
  deferNextCreate(): () => void {
    if (this.createGate) throw new Error("document create is already deferred");
    this.createGate = new Promise((resolve) => {
      this.releaseCreate = resolve;
    });
    return () => {
      this.releaseCreate?.();
      this.releaseCreate = null;
    };
  }
  failNextCreates(count = 1): void {
    this.createFailures += count;
  }
  async applyDocumentCommands(
    batch: DocumentArtifactCommandBatch,
  ): Promise<EditableArtifactPendingTransaction> {
    this.commands.push(batch);
    const command = batch.commands[0];
    if (command?.kind === "paragraph.edit") {
      this.text =
        this.text.slice(0, command.range.start) +
        command.replacement +
        this.text.slice(command.range.end);
    }
    this.revision += 1n;
    this.view = {
      ...this.view,
      headSequence: this.view.headSequence + 1,
      cursor: this.view.cursor + 1,
    };
    for (const listener of this.listeners) listener(this.view);
    return pending("document");
  }
  async createDocumentParagraph() {
    this.createCalls += 1;
    if (this.createGate) {
      await this.createGate;
      this.createGate = null;
    }
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error("paragraph allocation temporarily unavailable");
    }
    this.hasParagraph = true;
    this.revision += 1n;
    this.view = {
      ...this.view,
      headSequence: this.view.headSequence + 1,
      cursor: this.view.cursor + 1,
    };
    for (const listener of this.listeners) listener(this.view);
    return { paragraphId: PARAGRAPH_ID, pending: pending("document") };
  }
  async queryDocument(query: DocumentArtifactQuery): Promise<DocumentArtifactProjection> {
    this.queries.push(query);
    if (query.kind === "summary") {
      return projection(this.revision, [
        {
          kind: "summary",
          idNamespace: 0x0123456789abcdefn,
          revision: this.revision,
          nextIdCounter: 9n,
          blockCount: this.hasParagraph ? 1 : 0,
          sectionCount: 1,
          commentCount: 0,
          trackedChangeCount: 0,
          evenAndOddHeaders: false,
          trackRevisions: false,
          page: page(),
        },
      ]);
    }
    if (query.kind === "body") {
      if (!this.hasParagraph) return projection(this.revision, []);
      return projection(
        this.revision,
        [
          {
            kind: "paragraph",
            id: PARAGRAPH_ID,
            runs: [
              { text: this.text.slice(0, 5), style: { bold: true } },
              { text: this.text.slice(5), style: { italic: true } },
            ],
            style: { alignment: "left" },
          },
        ],
        this.text.length,
      );
    }
    if (query.kind === "sections") {
      return projection(this.revision, [
        {
          kind: "section",
          id: SECTION_ID,
          startBlockIndex: 0,
          titlePage: false,
          page: page(),
          headerBlockCounts: [0, 0, 0],
          footerBlockCounts: [0, 0, 0],
        },
      ]);
    }
    if (query.kind === "review") return projection(this.revision, []);
    throw new Error("Unexpected story query");
  }
}

describe("SDK-backed editable document", () => {
  test("composes bounded public projections without snapshots", async () => {
    const fake = new FakeDocumentSession();
    const editorProjection = await composeDocumentEditorProjection(
      fake as unknown as EditableArtifactSession,
    );
    expect(editorProjection.revision).toBe("1");
    expect(editorProjection.blocks[0]).toMatchObject({ kind: "paragraph", id: PARAGRAPH_ID });
    expect(editorProjection.sections?.[0]).toMatchObject({
      id: SECTION_ID,
      titlePage: false,
      headerBlockCounts: [0, 0, 0],
    });
    expect(fake.queries.map((query) => query.kind)).toEqual([
      "summary",
      "body",
      "sections",
      "review",
    ]);
  });

  test("removes a retained projection immediately after read access is revoked", async () => {
    const fake = new FakeDocumentSession("Confidential board material");
    const rendered = await renderComponent(
      <EditableDocumentArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Board plan"
      />,
    );
    await flush(30);
    expect(rendered.container.textContent).toContain("Confidential board material");

    await actRun(() => fake.revokeReadAccess());
    await flush();
    expect(rendered.container.textContent).not.toContain("Confidential board material");
    expect(rendered.container.textContent).toContain("You no longer have access");
    await rendered.unmount();
  });

  test("submits one minimal UTF-16 paragraph edit through the public session", async () => {
    const fake = new FakeDocumentSession();
    const rendered = await renderComponent(
      <EditableDocumentArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Plan"
        layout="continuous"
        viewportHeight={240}
      />,
    );
    await flush(20);
    const editor = rendered.container.querySelector<HTMLElement>(
      `[data-og-paragraph="${PARAGRAPH_ID}"]`,
    )!;
    expect(editor.textContent).toBe("Alpha 😀 omega");

    editor.textContent = "Alpha 😀 strong omega";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush(20);

    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.commands[0]).toEqual({
      kind: "paragraph.edit",
      id: PARAGRAPH_ID,
      range: { start: 9, end: 9 },
      replacement: "strong ",
      style: null,
    });
    await rendered.unmount();
  });

  test("starts an empty durable document through the SDK allocator", async () => {
    const fake = new FakeDocumentSession(null);
    const rendered = await renderComponent(
      <EditableDocumentArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Plan"
        layout="continuous"
        viewportHeight={240}
      />,
    );
    await flush(20);

    const start = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Start writing",
    );
    expect(start?.textContent).toBe("Start writing");
    await actRun(() => start!.click());
    await flush(20);

    expect(fake.createCalls).toBe(1);
    expect(
      rendered.container.querySelector(`[data-og-paragraph="${PARAGRAPH_ID}"]`),
    ).not.toBeNull();
    await rendered.unmount();
  });

  test("serializes immediate typing behind optimistic paragraph allocation", async () => {
    const fake = new FakeDocumentSession(null);
    const releaseCreate = fake.deferNextCreate();
    const rendered = await renderComponent(
      <EditableDocumentArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Plan"
        layout="continuous"
        viewportHeight={240}
      />,
    );
    await flush(20);

    const start = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Start writing",
    )!;
    await actRun(() => start.click());
    await flush();

    const editor = rendered.container.querySelector<HTMLElement>(
      '[data-og-paragraph="projection-paragraph-1"]',
    )!;
    expect(editor).not.toBeNull();
    editor.textContent = "Written before allocation returns";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush();

    expect(fake.createCalls).toBe(1);
    expect(fake.commands).toHaveLength(0);

    await actRun(() => releaseCreate());
    await flush(30);

    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.commands[0]).toEqual({
      kind: "paragraph.edit",
      id: PARAGRAPH_ID,
      range: { start: 0, end: 0 },
      replacement: "Written before allocation returns",
      style: null,
    });
    expect(rendered.container.textContent).not.toContain("Change not saved");
    await rendered.unmount();
  });

  test("retains immediate typing and retries after paragraph allocation fails", async () => {
    const fake = new FakeDocumentSession(null);
    const releaseCreate = fake.deferNextCreate();
    fake.failNextCreates();
    const errors: Error[] = [];
    const rendered = await renderComponent(
      <EditableDocumentArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Plan"
        layout="continuous"
        viewportHeight={240}
        onCommandError={(error) => errors.push(error)}
      />,
    );
    await flush(20);

    const start = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Start writing",
    )!;
    await actRun(() => start.click());
    await flush();

    const editor = rendered.container.querySelector<HTMLElement>(
      '[data-og-paragraph="projection-paragraph-1"]',
    )!;
    editor.textContent = "Never lose this text";
    await actRun(() => editor.dispatchEvent(new InputEvent("input", { bubbles: true })));
    await flush();
    await actRun(() => releaseCreate());
    await flush(40);

    expect(fake.createCalls).toBe(2);
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.commands[0]).toEqual({
      kind: "paragraph.edit",
      id: PARAGRAPH_ID,
      range: { start: 0, end: 0 },
      replacement: "Never lose this text",
      style: null,
    });
    expect(rendered.container.textContent).toContain("Never lose this text");
    expect(rendered.container.textContent).not.toContain("Change not saved");
    expect(errors).toHaveLength(0);
    await rendered.unmount();
  });

  test("never splits surrogate pairs when deriving the minimal edit", () => {
    expect(minimalUtf16TextEdit("A😀B", "A😁B")).toEqual({
      range: { start: 1, end: 3 },
      replacement: "😁",
    });
    expect(minimalUtf16TextEdit("same", "same")).toBeNull();
  });
});

function page() {
  return {
    widthMillipoints: 612_000n,
    heightMillipoints: 792_000n,
    marginTopMillipoints: 72_000n,
    marginRightMillipoints: 72_000n,
    marginBottomMillipoints: 72_000n,
    marginLeftMillipoints: 72_000n,
    headerMillipoints: 36_000n,
    footerMillipoints: 36_000n,
    gutterMillipoints: 0n,
  } as const;
}

function projection(
  revision: bigint,
  items: DocumentArtifactProjection["items"],
  projectedTextUtf16 = 0,
): DocumentArtifactProjection {
  return {
    revision,
    items,
    nextCursor: null,
    truncated: false,
    projectedTextUtf16,
    projectedTableCells: 0,
  };
}

function pending(modality: "document"): EditableArtifactPendingTransaction {
  return {
    modality,
    artifactId: ARTIFACT_ID,
    clientTransactionId: "document-transaction",
    requestHash: `sha256:${"a".repeat(64)}`,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandVersion: 1,
    replicaId: "1111111111111111",
    replicaCounter: 1,
    previousLocalTransactionId: null,
    observedHeadSequence: 1,
    observedNativeRevision: 1,
    commandBytes: new Uint8Array(),
    intentBytes: new Uint8Array(),
    createdAt: 1,
  };
}
