import {
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  editableArtifactStableId,
  encodeSpreadsheetArtifactCommandBatch,
  spreadsheetSheetId,
  type SpreadsheetArtifactCommandBatch,
  type SpreadsheetSheetPrecondition,
} from "@opengeni/contracts/editable-artifacts";
import {
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  encodeDocumentArtifactCommandBatch,
  type DocumentArtifactCommandBatch,
  type DocumentArtifactParagraphStyle,
  type DocumentArtifactStoryTarget,
  type DocumentArtifactTextRun,
} from "@opengeni/contracts/document-artifact-commands";
import {
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  encodePresentationArtifactCommandBatch,
  type PresentationArtifactCommandBatch,
  type PresentationArtifactFill,
} from "@opengeni/contracts/presentation-artifact-commands";
import {
  createEditableArtifactSyncController,
  type CreateEditableArtifactSyncControllerOptions,
  type EditableArtifactQueueCommandsInput,
  type EditableArtifactSyncController,
} from "./controller";
import { IndexedDbEditableArtifactStorage } from "./storage";
import type {
  EditableArtifactPendingTransaction,
  EditableArtifactModality,
  EditableDocumentProjection,
  EditableDocumentQuery,
  EditablePresentationProjection,
  EditablePresentationQuery,
  EditablePresentationEditorSlideProjection,
  EditablePresentationEditorSlideQuery,
  EditablePresentationSlideCatalogProjection,
  EditablePresentationSlideCatalogQuery,
  EditableArtifactSyncListener,
  EditableArtifactSyncView,
  EditableArtifactWorkerKernel,
  EditableSpreadsheetMetadataProjection,
  EditableSpreadsheetMetadataQuery,
  EditableSpreadsheetViewportProjection,
  EditableSpreadsheetViewportQuery,
} from "./types";

const DEFAULT_VIEWPORT_MAX_CELLS = 262_144;
const DEFAULT_VIEWPORT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_VIEWPORT_AREA = 1_048_576;
const UINT32_MAX = 0xffff_ffff;

export type CreateEditableArtifactSessionOptions = Omit<
  CreateEditableArtifactSyncControllerOptions,
  "kernel" | "storage"
> &
  Readonly<{
    /** Dedicated Worker client; canonical artifact state never enters the UI thread. */
    worker: EditableArtifactWorkerKernel;
    /** Defaults to the browser IndexedDB WAL/verified-replica store. */
    storage?: CreateEditableArtifactSyncControllerOptions["storage"];
    /** Close/dispose the Worker when this session closes. Defaults to true. */
    ownsWorker?: boolean;
  }>;

export type EditableSpreadsheetViewportListener = (
  projection: EditableSpreadsheetViewportProjection,
) => void;

export type EditableSpreadsheetViewportSubscriptionOptions = Readonly<{
  onError?: (error: Error) => void;
}>;

export type EditableSpreadsheetMetadataListener = (
  projection: EditableSpreadsheetMetadataProjection,
) => void;

export type ApplySpreadsheetCommandsOptions = Readonly<{
  selectiveUndoTargets?: readonly string[];
  clientTransactionId?: string;
}>;

export type ApplySerializedArtifactCommandsOptions = Readonly<{
  clientTransactionId?: string;
}>;

export type CreateSpreadsheetSheetInput = Readonly<{
  name: string;
  after?: SpreadsheetSheetPrecondition | null;
  /** Optional stable id for a host retry; normally allocated by the SDK. */
  sheetId?: string;
  clientTransactionId?: string;
}>;

export type CreateSpreadsheetSheetResult = Readonly<{
  sheetId: string;
  pending: EditableArtifactPendingTransaction;
}>;

export type CreateDocumentParagraphInput = Readonly<{
  target?: DocumentArtifactStoryTarget;
  runs?: readonly DocumentArtifactTextRun[];
  style?: DocumentArtifactParagraphStyle;
  /** Optional stable id for a host retry; normally allocated by the SDK. */
  paragraphId?: string;
  clientTransactionId?: string;
}>;

export type CreateDocumentParagraphResult = Readonly<{
  paragraphId: string;
  pending: EditableArtifactPendingTransaction;
}>;

export type CreatePresentationSlideInput = Readonly<{
  index: number;
  title?: string;
  layoutId?: string | null;
  background?: PresentationArtifactFill;
  /** Optional stable id for a host retry; normally allocated by the SDK. */
  slideId?: string;
  clientTransactionId?: string;
}>;

export type CreatePresentationSlideResult = Readonly<{
  slideId: string;
  pending: EditableArtifactPendingTransaction;
}>;

/**
 * Public browser editing session. It owns sync, WAL recovery, live replay, and
 * one Worker-resident speculative kernel. The main thread sees only bounded
 * immutable projections and authored command receipts.
 */
export interface EditableArtifactSession {
  readonly artifactId: string;
  readonly modality: EditableArtifactModality;
  start(): void;
  whenReady(): Promise<void>;
  close(): Promise<void>;
  getView(): EditableArtifactSyncView;
  subscribe(listener: EditableArtifactSyncListener): () => void;
  queueCommands(
    input: EditableArtifactQueueCommandsInput,
  ): Promise<EditableArtifactPendingTransaction>;
  /** Pure OGASC encoding followed by the ordinary Worker/WAL authoring path. */
  applySpreadsheetCommands(
    batch: SpreadsheetArtifactCommandBatch,
    options?: ApplySpreadsheetCommandsOptions,
  ): Promise<EditableArtifactPendingTransaction>;
  applyDocumentCommands(
    batch: DocumentArtifactCommandBatch,
    options?: ApplySerializedArtifactCommandsOptions,
  ): Promise<EditableArtifactPendingTransaction>;
  applyPresentationCommands(
    batch: PresentationArtifactCommandBatch,
    options?: ApplySerializedArtifactCommandsOptions,
  ): Promise<EditableArtifactPendingTransaction>;
  /** Allocates a collision-resistant offline sheet id and submits one OGASC create. */
  createSpreadsheetSheet(input: CreateSpreadsheetSheetInput): Promise<CreateSpreadsheetSheetResult>;
  /** Allocates a collision-resistant id in the document namespace and appends one paragraph. */
  createDocumentParagraph(
    input?: CreateDocumentParagraphInput,
  ): Promise<CreateDocumentParagraphResult>;
  /** Allocates a collision-resistant stable id and inserts one slide. */
  createPresentationSlide(
    input: CreatePresentationSlideInput,
  ): Promise<CreatePresentationSlideResult>;
  querySpreadsheetViewport(
    query: EditableSpreadsheetViewportQuery,
  ): Promise<EditableSpreadsheetViewportProjection>;
  subscribeSpreadsheetViewport(
    query: EditableSpreadsheetViewportQuery,
    listener: EditableSpreadsheetViewportListener,
    options?: EditableSpreadsheetViewportSubscriptionOptions,
  ): () => void;
  querySpreadsheetMetadata(
    query?: EditableSpreadsheetMetadataQuery,
  ): Promise<EditableSpreadsheetMetadataProjection>;
  subscribeSpreadsheetMetadata(
    query: EditableSpreadsheetMetadataQuery,
    listener: EditableSpreadsheetMetadataListener,
    options?: EditableSpreadsheetViewportSubscriptionOptions,
  ): () => void;
  queryDocument(query: EditableDocumentQuery): Promise<EditableDocumentProjection>;
  queryPresentation(query: EditablePresentationQuery): Promise<EditablePresentationProjection>;
  queryPresentationSlideCatalog(
    query: EditablePresentationSlideCatalogQuery,
  ): Promise<EditablePresentationSlideCatalogProjection>;
  queryPresentationEditorSlide(
    query: EditablePresentationEditorSlideQuery,
  ): Promise<EditablePresentationEditorSlideProjection>;
}

/** Creates and starts one independently durable browser editing session. */
export function createEditableArtifactSession(
  options: CreateEditableArtifactSessionOptions,
): EditableArtifactSession {
  const storage = options.storage ?? new IndexedDbEditableArtifactStorage();
  const controller = createEditableArtifactSyncController({
    ...options,
    storage,
    kernel: options.worker,
  });
  const session = new EditableArtifactSessionImpl(
    controller,
    options.worker,
    options.ownsWorker ?? true,
  );
  session.start();
  return session;
}

type ProjectionChannel = {
  readonly query: EditableSpreadsheetViewportQuery;
  readonly listeners: Map<
    EditableSpreadsheetViewportListener,
    EditableSpreadsheetViewportSubscriptionOptions
  >;
  generation: number;
  running: boolean;
  requested: boolean;
  last: EditableSpreadsheetViewportProjection | null;
};

type MetadataChannel = {
  readonly query: Required<EditableSpreadsheetMetadataQuery>;
  readonly listeners: Map<
    EditableSpreadsheetMetadataListener,
    EditableSpreadsheetViewportSubscriptionOptions
  >;
  generation: number;
  running: boolean;
  requested: boolean;
  last: EditableSpreadsheetMetadataProjection | null;
};

class EditableArtifactSessionImpl implements EditableArtifactSession {
  readonly artifactId: string;
  readonly modality: EditableArtifactModality;

  private readonly channels = new Map<string, ProjectionChannel>();
  private readonly metadataChannels = new Map<string, MetadataChannel>();
  private releaseController: (() => void) | null = null;
  private closed = false;
  private lastProjectionInvalidator = "";

  constructor(
    private readonly controller: EditableArtifactSyncController,
    private readonly worker: EditableArtifactWorkerKernel,
    private readonly ownsWorker: boolean,
  ) {
    this.artifactId = controller.artifactId;
    this.modality = controller.modality;
  }

  start(): void {
    this.requireOpen();
    if (!this.releaseController) {
      this.releaseController = this.controller.subscribe((view) => {
        const invalidator = projectionInvalidator(view);
        if (invalidator !== this.lastProjectionInvalidator) {
          this.lastProjectionInvalidator = invalidator;
          for (const channel of this.channels.values()) this.requestChannel(channel);
          for (const channel of this.metadataChannels.values())
            this.requestMetadataChannel(channel);
        }
      });
    }
    this.controller.start();
  }

  async whenReady(): Promise<void> {
    this.requireOpen();
    this.start();
    await this.controller.whenLive();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.releaseController?.();
    this.releaseController = null;
    this.channels.clear();
    this.metadataChannels.clear();
    await this.controller.close();
    if (this.ownsWorker) {
      const candidate = this.worker as EditableArtifactWorkerKernel & {
        dispose?: () => Promise<void>;
      };
      await candidate.dispose?.();
    }
  }

  getView(): EditableArtifactSyncView {
    return this.controller.getView();
  }

  subscribe(listener: EditableArtifactSyncListener): () => void {
    this.requireOpen();
    return this.controller.subscribe(listener);
  }

  async queueCommands(
    input: EditableArtifactQueueCommandsInput,
  ): Promise<EditableArtifactPendingTransaction> {
    this.requireOpen();
    return await this.controller.queueCommands(input);
  }

  async applySpreadsheetCommands(
    batch: SpreadsheetArtifactCommandBatch,
    options: ApplySpreadsheetCommandsOptions = {},
  ): Promise<EditableArtifactPendingTransaction> {
    this.requireOpen();
    this.requireModality("spreadsheet");
    const commandBytes = encodeSpreadsheetArtifactCommandBatch(batch);
    return await this.queueCommands({
      commandBytes,
      ...(options.selectiveUndoTargets === undefined
        ? {}
        : { selectiveUndoTargets: options.selectiveUndoTargets }),
      ...(options.clientTransactionId === undefined
        ? {}
        : { clientTransactionId: options.clientTransactionId }),
    });
  }

  async applyDocumentCommands(
    batch: DocumentArtifactCommandBatch,
    options: ApplySerializedArtifactCommandsOptions = {},
  ): Promise<EditableArtifactPendingTransaction> {
    this.requireOpen();
    this.requireModality("document");
    return await this.queueCommands({
      commandBytes: encodeDocumentArtifactCommandBatch(batch),
      ...(options.clientTransactionId === undefined
        ? {}
        : { clientTransactionId: options.clientTransactionId }),
    });
  }

  async applyPresentationCommands(
    batch: PresentationArtifactCommandBatch,
    options: ApplySerializedArtifactCommandsOptions = {},
  ): Promise<EditableArtifactPendingTransaction> {
    this.requireOpen();
    this.requireModality("presentation");
    return await this.queueCommands({
      commandBytes: encodePresentationArtifactCommandBatch(batch),
      ...(options.clientTransactionId === undefined
        ? {}
        : { clientTransactionId: options.clientTransactionId }),
    });
  }

  async createSpreadsheetSheet(
    input: CreateSpreadsheetSheetInput,
  ): Promise<CreateSpreadsheetSheetResult> {
    this.requireOpen();
    const sheetId = spreadsheetSheetId(input.sheetId ?? randomStableId());
    const pending = await this.applySpreadsheetCommands(
      {
        version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
        commands: [
          {
            kind: "sheet.create",
            sheetId,
            name: input.name,
            after: input.after ?? null,
          },
        ],
      },
      input.clientTransactionId === undefined
        ? {}
        : { clientTransactionId: input.clientTransactionId },
    );
    return Object.freeze({ sheetId, pending });
  }

  async createDocumentParagraph(
    input: CreateDocumentParagraphInput = {},
  ): Promise<CreateDocumentParagraphResult> {
    this.requireOpen();
    this.requireModality("document");
    const summary = await this.queryDocument({ kind: "summary" });
    const facts = summary.items[0];
    if (
      summary.items.length !== 1 ||
      facts?.kind !== "summary" ||
      summary.nextCursor !== null ||
      summary.truncated
    ) {
      throw new Error("Document summary projection is malformed");
    }
    const paragraphId = input.paragraphId ?? randomDocumentId("p", facts.idNamespace);
    const pending = await this.applyDocumentCommands(
      {
        version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
        commands: [
          {
            kind: "paragraph.add",
            target: input.target ?? { kind: "body" },
            id: paragraphId,
            runs: input.runs ?? [],
            style: input.style ?? {},
          },
        ],
      },
      input.clientTransactionId === undefined
        ? {}
        : { clientTransactionId: input.clientTransactionId },
    );
    return Object.freeze({ paragraphId, pending });
  }

  async createPresentationSlide(
    input: CreatePresentationSlideInput,
  ): Promise<CreatePresentationSlideResult> {
    this.requireOpen();
    this.requireModality("presentation");
    const slideId = editableArtifactStableId(input.slideId ?? randomStableId());
    const pending = await this.applyPresentationCommands(
      {
        version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
        commands: [
          {
            kind: "slide.create",
            id: slideId,
            index: input.index,
            title: input.title ?? "",
            layoutId: input.layoutId ?? null,
            background: input.background ?? { kind: "solid", color: 0xffffffff },
          },
        ],
      },
      input.clientTransactionId === undefined
        ? {}
        : { clientTransactionId: input.clientTransactionId },
    );
    return Object.freeze({ slideId, pending });
  }

  async querySpreadsheetViewport(
    query: EditableSpreadsheetViewportQuery,
  ): Promise<EditableSpreadsheetViewportProjection> {
    this.requireOpen();
    this.requireModality("spreadsheet");
    const normalized = normalizeViewportQuery(query);
    await this.whenReady();
    this.requireOpen();
    return await this.worker.querySpreadsheetViewport(normalized);
  }

  subscribeSpreadsheetViewport(
    query: EditableSpreadsheetViewportQuery,
    listener: EditableSpreadsheetViewportListener,
    options: EditableSpreadsheetViewportSubscriptionOptions = {},
  ): () => void {
    this.requireOpen();
    this.requireModality("spreadsheet");
    const normalized = normalizeViewportQuery(query);
    const key = viewportQueryKey(normalized);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        query: normalized,
        listeners: new Map(),
        generation: 0,
        running: false,
        requested: false,
        last: null,
      };
      this.channels.set(key, channel);
    }
    channel.listeners.set(listener, options);
    if (channel.last) listener(channel.last);
    else this.requestChannel(channel);
    return () => {
      const current = this.channels.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.generation += 1;
        this.channels.delete(key);
      }
    };
  }

  async querySpreadsheetMetadata(
    query: EditableSpreadsheetMetadataQuery = {},
  ): Promise<EditableSpreadsheetMetadataProjection> {
    this.requireOpen();
    this.requireModality("spreadsheet");
    const normalized = normalizeMetadataQuery(query);
    await this.whenReady();
    this.requireOpen();
    return await this.worker.querySpreadsheetMetadata(normalized);
  }

  subscribeSpreadsheetMetadata(
    query: EditableSpreadsheetMetadataQuery,
    listener: EditableSpreadsheetMetadataListener,
    options: EditableSpreadsheetViewportSubscriptionOptions = {},
  ): () => void {
    this.requireOpen();
    this.requireModality("spreadsheet");
    const normalized = normalizeMetadataQuery(query);
    const key = `${normalized.maxSheets}:${normalized.maxBytes}`;
    let channel = this.metadataChannels.get(key);
    if (!channel) {
      channel = {
        query: normalized,
        listeners: new Map(),
        generation: 0,
        running: false,
        requested: false,
        last: null,
      };
      this.metadataChannels.set(key, channel);
    }
    channel.listeners.set(listener, options);
    if (channel.last) listener(channel.last);
    else this.requestMetadataChannel(channel);
    return () => {
      const current = this.metadataChannels.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.generation += 1;
        this.metadataChannels.delete(key);
      }
    };
  }

  async queryDocument(query: EditableDocumentQuery): Promise<EditableDocumentProjection> {
    this.requireOpen();
    this.requireModality("document");
    await this.whenReady();
    this.requireOpen();
    return await this.worker.queryDocument(query);
  }

  async queryPresentation(
    query: EditablePresentationQuery,
  ): Promise<EditablePresentationProjection> {
    this.requireOpen();
    this.requireModality("presentation");
    await this.whenReady();
    this.requireOpen();
    return await this.worker.queryPresentation(query);
  }

  async queryPresentationSlideCatalog(
    query: EditablePresentationSlideCatalogQuery,
  ): Promise<EditablePresentationSlideCatalogProjection> {
    this.requireOpen();
    this.requireModality("presentation");
    await this.whenReady();
    this.requireOpen();
    const response = await this.worker.queryPresentation(query);
    if (
      response.kind !== "slide-catalog" ||
      response.startSlide !== query.startSlide ||
      response.slides.length > query.maxSlides ||
      response.projectedTextBytes > query.maxTextBytes
    ) {
      throw new TypeError("presentation slide catalog response is malformed");
    }
    return response;
  }

  async queryPresentationEditorSlide(
    query: EditablePresentationEditorSlideQuery,
  ): Promise<EditablePresentationEditorSlideProjection> {
    this.requireOpen();
    this.requireModality("presentation");
    await this.whenReady();
    this.requireOpen();
    const response = await this.worker.queryPresentation(query);
    if (
      response.kind !== "editor-slide" ||
      response.slide.id !== query.slideId ||
      response.nodes.length > query.maxNodes ||
      response.projectedTextBytes > query.maxTextBytes
    ) {
      throw new TypeError("presentation editor slide response is malformed");
    }
    return response;
  }

  private requestChannel(channel: ProjectionChannel): void {
    if (this.closed || channel.listeners.size === 0) return;
    channel.requested = true;
    if (channel.running) return;
    channel.running = true;
    void this.runChannel(channel);
  }

  private async runChannel(channel: ProjectionChannel): Promise<void> {
    try {
      while (!this.closed && channel.listeners.size > 0 && channel.requested) {
        channel.requested = false;
        const generation = ++channel.generation;
        try {
          const projection = await this.querySpreadsheetViewport(channel.query);
          if (this.closed || generation !== channel.generation || channel.listeners.size === 0) {
            continue;
          }
          channel.last = projection;
          for (const listener of channel.listeners.keys()) listener(projection);
        } catch (error) {
          if (this.closed || generation !== channel.generation) continue;
          const failure = asError(error);
          for (const options of channel.listeners.values()) options.onError?.(failure);
        }
      }
    } finally {
      channel.running = false;
      if (channel.requested && !this.closed && channel.listeners.size > 0) {
        this.requestChannel(channel);
      }
    }
  }

  private requestMetadataChannel(channel: MetadataChannel): void {
    if (this.closed || channel.listeners.size === 0) return;
    channel.requested = true;
    if (channel.running) return;
    channel.running = true;
    void this.runMetadataChannel(channel);
  }

  private async runMetadataChannel(channel: MetadataChannel): Promise<void> {
    try {
      while (!this.closed && channel.listeners.size > 0 && channel.requested) {
        channel.requested = false;
        const generation = ++channel.generation;
        try {
          const projection = await this.querySpreadsheetMetadata(channel.query);
          if (this.closed || generation !== channel.generation || channel.listeners.size === 0) {
            continue;
          }
          channel.last = projection;
          for (const listener of channel.listeners.keys()) listener(projection);
        } catch (error) {
          if (this.closed || generation !== channel.generation) continue;
          const failure = asError(error);
          for (const options of channel.listeners.values()) options.onError?.(failure);
        }
      }
    } finally {
      channel.running = false;
      if (channel.requested && !this.closed && channel.listeners.size > 0) {
        this.requestMetadataChannel(channel);
      }
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("editable artifact session is closed");
  }

  private requireModality(expected: EditableArtifactModality): void {
    if (this.modality !== expected) {
      throw new TypeError(`${expected} operation requires a ${expected} artifact session`);
    }
  }
}

function normalizeViewportQuery(
  input: EditableSpreadsheetViewportQuery,
): EditableSpreadsheetViewportQuery {
  const sheetId = stableId(input.sheetId, "sheetId");
  const startRow = uint32(input.startRow, "startRow");
  const startColumn = uint32(input.startColumn, "startColumn");
  const rowCount = positiveUint32(input.rowCount, "rowCount");
  const columnCount = positiveUint32(input.columnCount, "columnCount");
  if (startRow + rowCount - 1 > UINT32_MAX || startColumn + columnCount - 1 > UINT32_MAX) {
    throw new RangeError("spreadsheet viewport exceeds the uint32 coordinate space");
  }
  const area = rowCount * columnCount;
  if (!Number.isSafeInteger(area) || area > MAX_VIEWPORT_AREA) {
    throw new RangeError(`spreadsheet viewport area exceeds ${MAX_VIEWPORT_AREA} cells`);
  }
  const maxCells = positiveUint32(input.maxCells ?? DEFAULT_VIEWPORT_MAX_CELLS, "maxCells");
  const maxBytes = positiveUint32(input.maxBytes ?? DEFAULT_VIEWPORT_MAX_BYTES, "maxBytes");
  if (maxCells > DEFAULT_VIEWPORT_MAX_CELLS) {
    throw new RangeError(`maxCells exceeds ${DEFAULT_VIEWPORT_MAX_CELLS}`);
  }
  if (maxBytes > DEFAULT_VIEWPORT_MAX_BYTES) {
    throw new RangeError(`maxBytes exceeds ${DEFAULT_VIEWPORT_MAX_BYTES}`);
  }
  return Object.freeze({
    sheetId,
    startRow,
    startColumn,
    rowCount,
    columnCount,
    maxCells,
    maxBytes,
  });
}

function viewportQueryKey(query: EditableSpreadsheetViewportQuery): string {
  return `${query.sheetId}:${query.startRow}:${query.startColumn}:${query.rowCount}:${query.columnCount}:${query.maxCells}:${query.maxBytes}`;
}

function normalizeMetadataQuery(
  input: EditableSpreadsheetMetadataQuery,
): Required<EditableSpreadsheetMetadataQuery> {
  const maxSheets = positiveUint32(input.maxSheets ?? 4_096, "maxSheets");
  const maxBytes = positiveUint32(input.maxBytes ?? DEFAULT_VIEWPORT_MAX_BYTES, "maxBytes");
  if (maxSheets > 262_144) throw new RangeError("maxSheets exceeds 262144");
  if (maxBytes > DEFAULT_VIEWPORT_MAX_BYTES) {
    throw new RangeError(`maxBytes exceeds ${DEFAULT_VIEWPORT_MAX_BYTES}`);
  }
  return Object.freeze({ maxSheets, maxBytes });
}

function projectionInvalidator(view: EditableArtifactSyncView): string {
  return `${view.state}:${view.cursor}:${view.headSequence}:${view.pendingTransactions}:${view.blockedPending.map((entry) => `${entry.clientTransactionId}:${entry.code}`).join(",")}`;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value) || /^0+$/u.test(value)) {
    throw new TypeError(`${label} must be nonzero fixed-width lowercase hexadecimal text`);
  }
  return value;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new TypeError(`${label} must be a uint32`);
  }
  return value as number;
}

function positiveUint32(value: unknown, label: string): number {
  const output = uint32(value, label);
  if (output === 0) throw new TypeError(`${label} must be positive`);
  return output;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("editable artifact projection failed");
}

function randomStableId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Sheet object ids require nonzero allocator namespace and counter halves.
  if (bytes.subarray(0, 8).every((value) => value === 0)) bytes[0] = 1;
  if (bytes.subarray(8).every((value) => value === 0)) bytes[8] = 1;
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value |= BigInt(bytes[index]!) << BigInt(index * 8);
  }
  return value.toString(16).padStart(32, "0");
}

function randomDocumentId(prefix: "p", namespace: bigint): string {
  if (namespace < 0n || namespace > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Document id namespace is malformed");
  }
  const maximumCounter = BigInt(Number.MAX_SAFE_INTEGER) - 1n;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(7));
    bytes[0] = bytes[0]! & 0x1f;
    let counter = 0n;
    for (const byte of bytes) counter = (counter << 8n) | BigInt(byte);
    if (counter > 0n && counter <= maximumCounter) {
      return `${prefix}/${namespace.toString(16).padStart(16, "0")}${counter
        .toString(16)
        .padStart(16, "0")}`;
    }
  }
}
