import { describe, expect, test } from "bun:test";
import type {
  EditableArtifactPendingTransaction,
  EditableArtifactSession,
  EditableArtifactSyncListener,
  EditableArtifactSyncView,
  EditablePresentationProjection,
  EditablePresentationQuery,
  PresentationArtifactCommandBatch,
  PresentationArtifactEditorSceneNode,
  PresentationArtifactRichText,
  PresentationArtifactSlideCatalogItem,
} from "@opengeni/sdk/editable-artifacts";

import {
  composePresentationEditorProjection,
  EditablePresentationArtifactSurface,
  flattenPresentationRichText,
  replacePresentationRichText,
} from "../src/components/artifacts/editable-presentation";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRESENTATION_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SLIDE_ID = "11111111111111111111111111111111";
const SHAPE_ID = "22222222222222222222222222222222";
const GROUP_ID = "33333333333333333333333333333333";
const CHILD_ID = "44444444444444444444444444444444";
const CONNECTOR_ID = "55555555555555555555555555555555";
const MASTER_ID = "66666666666666666666666666666666";

class FakePresentationSession {
  readonly artifactId = ARTIFACT_ID;
  readonly modality = "presentation" as const;
  readonly commands: PresentationArtifactCommandBatch[] = [];
  createCalls = 0;
  private revision = 1n;
  private nodes = makeNodes();
  private slides: PresentationArtifactSlideCatalogItem[] = [slide()];
  private view: EditableArtifactSyncView = {
    artifactId: ARTIFACT_ID,
    modality: "presentation",
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
  refreshProjection(): void {
    this.revision += 1n;
    this.view = {
      ...this.view,
      cursor: this.view.cursor + 1,
      headSequence: this.view.headSequence + 1,
    };
    for (const listener of this.listeners) listener(this.view);
  }
  async queryPresentation(
    query: EditablePresentationQuery,
  ): Promise<EditablePresentationProjection> {
    if (query.kind !== "metadata") throw new Error("Unexpected generic presentation query");
    return {
      kind: "metadata",
      revision: this.revision,
      presentationId: PRESENTATION_ID,
      slideSize: { width: 9_144_000, height: 5_143_500 },
      masters: 1,
      layouts: 0,
      slides: this.slides.length,
    };
  }
  async queryPresentationSlideCatalog() {
    return {
      kind: "slide-catalog" as const,
      revision: this.revision,
      startSlide: 0,
      nextSlide: null,
      projectedTextBytes: 5,
      slides: this.slides,
      truncated: false,
    };
  }
  async queryPresentationEditorSlide(query: { slideId: string }) {
    return {
      kind: "editor-slide" as const,
      revision: this.revision,
      slide: this.slides.find((candidate) => candidate.id === query.slideId)!,
      notes: null,
      projectedTextBytes: 20,
      nodes: query.slideId === SLIDE_ID ? this.nodes : [],
      truncated: false,
    };
  }
  async applyPresentationCommands(
    batch: PresentationArtifactCommandBatch,
  ): Promise<EditableArtifactPendingTransaction> {
    this.commands.push(batch);
    const command = batch.commands[0];
    if (command?.kind === "node.bounds.set") {
      this.nodes = this.nodes.map((node) =>
        node.id === command.id ? Object.freeze({ ...node, bounds: command.bounds }) : node,
      );
    } else if (command?.kind === "node.content.set") {
      this.nodes = this.nodes.map((node) =>
        node.id === command.id ? Object.freeze({ ...node, content: command.content }) : node,
      );
    } else if (command?.kind === "node.insert") {
      this.nodes = [
        ...this.nodes.slice(0, command.index),
        {
          id: command.node.id,
          source: command.owner,
          inherited: false,
          parentId: command.parentId,
          order: command.index,
          name: command.node.name,
          bounds: command.node.bounds,
          transform: command.node.transform,
          content: command.node.content,
        },
        ...this.nodes.slice(command.index),
      ];
    } else if (command?.kind === "node.delete") {
      this.nodes = this.nodes.filter((node) => node.id !== command.id);
    } else if (command?.kind === "slide.delete") {
      this.slides = this.slides
        .filter((candidate) => candidate.id !== command.id)
        .map((candidate, index) => ({ ...candidate, index }));
    }
    this.revision += 1n;
    this.view = {
      ...this.view,
      cursor: this.view.cursor + 1,
      headSequence: this.view.headSequence + 1,
    };
    for (const listener of this.listeners) listener(this.view);
    return pending();
  }
  async createPresentationSlide(input: { slideId?: string; index: number }) {
    this.createCalls += 1;
    const slideId = input.slideId!;
    this.slides = [
      ...this.slides.slice(0, input.index),
      slide(slideId, ""),
      ...this.slides.slice(input.index),
    ].map((candidate, index) => ({ ...candidate, index }));
    this.revision += 1n;
    this.view = {
      ...this.view,
      cursor: this.view.cursor + 1,
      headSequence: this.view.headSequence + 1,
    };
    for (const listener of this.listeners) listener(this.view);
    return { slideId, pending: pending() };
  }
}

describe("SDK-backed editable presentation", () => {
  test("removes retained slide content immediately after read access is revoked", async () => {
    const fake = new FakePresentationSession();
    const rendered = await renderComponent(
      <EditablePresentationArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Private deck"
      />,
    );
    await flush(30);
    expect(rendered.container.querySelector('[role="application"]')).not.toBeNull();

    await actRun(() => fake.revokeReadAccess());
    await flush();
    expect(rendered.container.querySelector('[role="application"]')).toBeNull();
    expect(rendered.container.textContent).toContain("You no longer have access");
    await rendered.unmount();
  });

  test("composes catalog/editor-slide ABI while preserving hierarchy and inheritance", async () => {
    const composed = await composePresentationEditorProjection(
      new FakePresentationSession() as unknown as EditableArtifactSession,
    );
    expect(composed.projection.slideSize).toEqual({ width: 960, height: 540 });
    const elements = composed.projection.slides[0]?.elements ?? [];
    expect(elements.map((element) => element.kind)).toEqual(["shape", "group", "connector"]);
    expect(elements[1]).toMatchObject({
      kind: "group",
      id: GROUP_ID,
      children: [{ id: CHILD_ID }],
      nodeSource: { kind: "slide", id: SLIDE_ID },
      order: 1,
    });
    expect(elements[2]).toMatchObject({
      kind: "connector",
      id: CONNECTOR_ID,
      inherited: true,
      readOnly: true,
      nodeSource: { kind: "master", id: MASTER_ID },
    });
  });

  test("maps canvas movement to exact canonical node bounds", async () => {
    const fake = new FakePresentationSession();
    const rendered = await renderComponent(
      <EditablePresentationArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Deck"
      />,
    );
    await flush(30);
    const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
    await actRun(() => editor.focus());
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush(30);

    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.commands[0]).toEqual({
      kind: "node.bounds.set",
      id: SHAPE_ID,
      bounds: { x: 962_025, y: 952_500, width: 1_905_000, height: 952_500 },
    });
    await rendered.unmount();
  });

  test("adds and removes slides through durable SDK commands", async () => {
    const fake = new FakePresentationSession();
    const rendered = await renderComponent(
      <EditablePresentationArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Deck"
      />,
    );
    await flush(30);

    const add = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add slide"]',
    )!;
    await actRun(() => add.click());
    await flush(40);
    expect(fake.createCalls).toBe(1);
    expect(rendered.container.querySelectorAll('[role="option"]')).toHaveLength(2);

    const remove = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete slide"]',
    )!;
    await actRun(() => remove.click());
    await flush(40);
    expect(fake.commands.at(-1)?.commands[0]).toMatchObject({ kind: "slide.delete" });
    expect(rendered.container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await rendered.unmount();
  });

  test("adds and removes an editable text box through canonical node commands", async () => {
    const fake = new FakePresentationSession();
    const rendered = await renderComponent(
      <EditablePresentationArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Deck"
      />,
    );
    await flush(30);

    const add = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add text box"]',
    )!;
    await actRun(() => add.click());
    await flush(40);
    expect(fake.commands.at(-1)?.commands[0]).toMatchObject({
      kind: "node.insert",
      owner: { kind: "slide", id: SLIDE_ID },
      node: { name: "Text box", content: { kind: "shape", geometry: "text-box" } },
    });

    const remove = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete selected object"]',
    )!;
    expect(remove.disabled).toBe(false);
    await actRun(() => remove.click());
    await flush(40);
    expect(fake.commands.at(-1)?.commands[0]).toMatchObject({ kind: "node.delete" });
    await rendered.unmount();
  });

  test("preserves an active text draft across authoritative projection refreshes", async () => {
    const fake = new FakePresentationSession();
    const rendered = await renderComponent(
      <EditablePresentationArtifactSurface
        session={fake as unknown as EditableArtifactSession}
        title="Deck"
      />,
    );
    await flush(30);

    const editor = rendered.container.querySelector<SVGSVGElement>('[role="application"]')!;
    await actRun(() => editor.focus());
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })),
    );
    await actRun(() =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const textEditor = rendered.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit Heading"]',
    )!;
    expect(textEditor).not.toBeNull();
    await actRun(() => {
      textEditor.value = "Draft survives refresh";
      textEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    await actRun(() => fake.refreshProjection());
    await flush(30);

    const retainedEditor = rendered.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit Heading"]',
    )!;
    expect(retainedEditor).not.toBeNull();
    expect(retainedEditor.value).toBe("Draft survives refresh");
    await actRun(() =>
      retainedEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      ),
    );
    await flush(30);

    expect(fake.commands.at(-1)?.commands[0]).toMatchObject({
      kind: "node.content.set",
      id: SHAPE_ID,
    });
    await rendered.unmount();
  });

  test("rich-text replacement preserves unaffected styles and paragraph alignment", () => {
    const before = richText();
    const after = replacePresentationRichText(before, "Hello world", "Hello brave world");
    expect(flattenPresentationRichText(after)).toBe("Hello brave world");
    expect(after.paragraphs[0]?.alignment).toBe("center");
    expect(after.paragraphs[0]?.runs).toMatchObject([
      { text: "Hello ", style: { bold: true } },
      { text: "brave world", style: { italic: true } },
    ]);
  });
});

function slide(id = SLIDE_ID, title = "Intro"): PresentationArtifactSlideCatalogItem {
  return {
    index: 0,
    id,
    title,
    background: { kind: "solid", color: 0xffffffff },
    layout: null,
  };
}

function makeNodes(): readonly PresentationArtifactEditorSceneNode[] {
  const nodes: PresentationArtifactEditorSceneNode[] = [
    {
      id: SHAPE_ID,
      source: { kind: "slide", id: SLIDE_ID },
      inherited: false,
      parentId: null,
      order: 0,
      name: "Heading",
      bounds: { x: 952_500, y: 952_500, width: 1_905_000, height: 952_500 },
      transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
      content: {
        kind: "shape",
        geometry: "text-box",
        fill: { kind: "none" },
        line: { fill: { kind: "solid", color: 0x111827ff }, width: 9_525, dash: "solid" },
        text: richText(),
        placeholder: null,
      },
    },
    {
      id: GROUP_ID,
      source: { kind: "slide", id: SLIDE_ID },
      inherited: false,
      parentId: null,
      order: 1,
      name: "Group",
      bounds: { x: 3_000_000, y: 1_000_000, width: 2_000_000, height: 2_000_000 },
      transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
      content: {
        kind: "group",
        childOffsetX: 0,
        childOffsetY: 0,
        childExtentWidth: 2_000_000,
        childExtentHeight: 2_000_000,
        children: [CHILD_ID],
      },
    },
    {
      id: CHILD_ID,
      source: { kind: "slide", id: SLIDE_ID },
      inherited: false,
      parentId: GROUP_ID,
      order: 0,
      name: "Grouped chart",
      bounds: { x: 0, y: 0, width: 1_000_000, height: 1_000_000 },
      transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
      content: {
        kind: "chart",
        chartType: "bar",
        title: richText(),
        series: [],
        hasLegend: false,
      },
    },
    {
      id: CONNECTOR_ID,
      source: { kind: "master", id: MASTER_ID },
      inherited: true,
      parentId: null,
      order: 2,
      name: "Master connector",
      bounds: { x: 0, y: 0, width: 1_000_000, height: 1_000_000 },
      transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
      content: {
        kind: "connector",
        connectorKind: "straight",
        start: { nodeId: null, x: 0, y: 0 },
        end: { nodeId: null, x: 1_000_000, y: 1_000_000 },
        line: { fill: { kind: "solid", color: 0x111827ff }, width: 9_525, dash: "solid" },
      },
    },
  ];
  return Object.freeze(nodes);
}

function richText(): PresentationArtifactRichText {
  return {
    verticalAlignment: "middle",
    paragraphs: [
      {
        alignment: "center",
        runs: [
          {
            text: "Hello ",
            style: {
              fontFamily: "Inter",
              fontSizeCentipoints: 2_400,
              color: 0x111827ff,
              bold: true,
              italic: false,
              underline: false,
              language: "en",
            },
          },
          {
            text: "world",
            style: {
              fontFamily: "Inter",
              fontSizeCentipoints: 2_400,
              color: 0x111827ff,
              bold: false,
              italic: true,
              underline: false,
              language: "en",
            },
          },
        ],
      },
    ],
  };
}

function pending(): EditableArtifactPendingTransaction {
  return {
    modality: "presentation",
    artifactId: ARTIFACT_ID,
    clientTransactionId: "presentation-transaction",
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
