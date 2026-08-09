import { decodeEditableArtifactCausalFrontier } from "@opengeni/contracts/editable-artifact-causal-frontier";
import { EDITABLE_ARTIFACT_CODEC_REGISTRY } from "@opengeni/contracts/editable-artifact-codec-registry";
import { COMMITTED_TRANSACTION_PROTOCOL_VERSION } from "@opengeni/contracts/editable-artifact-committed-transaction";
import type { FileBlob } from "./file-blob";
import {
  Document as ReferenceDocument,
  DocumentBlockCollection,
  DocumentCommentThread,
  DocumentComments,
  DocumentFile as ReferenceDocumentFile,
  DocumentParagraph,
  DocumentSection,
  DocumentSections,
  DocumentStory,
  DocumentTable,
  TrackedChanges,
  type DocumentCreateOptions,
  type SerializedDocument,
  type SerializedDocumentBlock,
  type DocumentTextStyle,
} from "./document";
import { DOCUMENT_LOSS_PRESERVATION } from "./document-docx-state";
import {
  NativeDocumentSession,
  NativePresentationSession,
  NativeSpreadsheetSession,
} from "./native";
import {
  Presentation as ReferencePresentation,
  PresentationChart,
  PresentationChartCollection,
  PresentationFile as ReferencePresentationFile,
  PresentationGroup,
  PresentationGroupCollection,
  PresentationImage,
  PresentationImageCollection,
  PresentationShape,
  PresentationShapeCollection,
  PresentationTable,
  PresentationTableCollection,
  PresentationText,
  Slide,
  SlideCollection,
  type PresentationCreateOptions,
  type PresentationElement,
} from "./presentation";
import { presentationLossState, setPresentationLossState } from "./presentation-pptx-state";
import {
  CompositeArtifactState,
  requireCompositeState,
  type CompositeMutation,
  type CompositeReconciliation,
  type PreparedCompositeMutation,
} from "./production-composite";
import {
  encodeDocumentIncrementalCommands,
  encodeDocumentProjectionCommands,
  encodePresentationIncrementalCommands,
  encodePresentationProjectionCommands,
  type DocumentProjectionTarget,
} from "./production-native-codecs";
import {
  installSpreadsheetProjection,
  prepareSpreadsheetMutation,
  readSpreadsheetProperty,
  reconcileSpreadsheetProjection,
} from "./production-spreadsheet-native";
import { ArtifactKernelRuntime, ArtifactRuntimeError } from "./runtime";
import {
  Workbook as ReferenceWorkbook,
  type SerializedWorkbook,
  type WorkbookOptions,
} from "./spreadsheet";
import { SpreadsheetFile as ReferenceSpreadsheetFile } from "./spreadsheet-file";
import { LOSS_PRESERVATION } from "./spreadsheet-xlsx-state";

export {
  SPREADSHEET_RECALCULATION_LIMITS,
  SPREADSHEET_SNAPSHOT_LIMITS,
  ChartSeriesCollection,
  CommentThread,
  ConditionalFormattingCollection,
  DataValidationCollection,
  FreezePanes,
  ImageCollection,
  Range,
  RangeConditionalFormats,
  RangeFormat,
  RangeSparklines,
  ShapeCollection,
  SparklineGroup,
  SparklineGroupCollection,
  SpreadsheetChart,
  SpreadsheetChartSeries,
  SpreadsheetImage,
  SpreadsheetShape,
  Table,
  TableCollection,
  WorkbookComments,
  Worksheet,
  WorksheetCollection,
  validateSerializedWorkbook,
} from "./spreadsheet";
export type {
  RangeSparklineConfig,
  RangeWritePayload,
  SerializedWorkbook,
  SparklineConfig,
  SpreadsheetRecalculationLimits,
  WorkbookChange,
  WorkbookOptions,
} from "./spreadsheet";
export {
  DocumentBlockCollection,
  DocumentCommentThread,
  DocumentComments,
  DocumentPageBreak,
  DocumentParagraph,
  DocumentSection,
  DocumentSectionStories,
  DocumentSections,
  DocumentStory,
  DocumentTable,
  DocumentTextRun,
  TrackedChange,
  TrackedChanges,
} from "./document";
export type {
  DocumentBlock,
  DocumentCreateOptions,
  DocumentPageGeometry,
  DocumentParagraphEdit,
  DocumentParagraphFormat,
  DocumentParagraphStyle,
  DocumentRenderOptions,
  DocumentStoryBlock,
  DocumentTableStyle,
  DocumentTextStyle,
  DocumentTextStylePatch,
  SerializedDocument,
  SerializedDocumentBlock,
  SerializedDocumentComment,
  SerializedDocumentSection,
  SerializedPageBreak,
  SerializedParagraph,
  SerializedStory,
  SerializedTable,
  SerializedTextRun,
  SerializedTrackedChange,
} from "./document";
export {
  InvalidPresentationInputError,
  PresentationChart,
  PresentationChartCollection,
  PresentationChartSeries,
  PresentationChartSeriesCollection,
  PresentationGroup,
  PresentationGroupCollection,
  PresentationImage,
  PresentationImageCollection,
  PresentationLayout,
  PresentationLayoutCollection,
  PresentationMaster,
  PresentationMasterCollection,
  PresentationShape,
  PresentationShapeCollection,
  PresentationTable,
  PresentationTableCell,
  PresentationTableCollection,
  PresentationText,
  Slide,
  SlideCollection,
  SlidePlaceholderCollection,
  UnsupportedPresentationFeatureError,
  assertPresentationRenderPixelBudget,
  presentationColorValue,
  truncatePresentationText,
} from "./presentation";
export type {
  PresentationChartConfig,
  PresentationChartSeriesConfig,
  PresentationChartType,
  PresentationCreateOptions,
  PresentationElement,
  PresentationExportOptions,
  PresentationFill,
  PresentationGroupChild,
  PresentationGroupChildConfig,
  PresentationGroupConfig,
  PresentationImageConfig,
  PresentationImageResolution,
  PresentationImageResolver,
  PresentationInspectOptions,
  PresentationInspectResult,
  PresentationLayoutConfig,
  PresentationLine,
  PresentationMasterConfig,
  PresentationPosition,
  PresentationRasterImageContentType,
  PresentationResolvedObject,
  PresentationShapeConfig,
  PresentationShapeGeometry,
  PresentationTableCellConfig,
  PresentationTableCellInput,
  PresentationTableConfig,
  PresentationTemplateElement,
  PresentationTextStyle,
} from "./presentation";
export { SpreadsheetFidelityError, SpreadsheetSecurityError } from "./spreadsheet-file";
export type {
  SpreadsheetFidelityIssue,
  SpreadsheetLossPreservationEnvelope,
  SpreadsheetXlsxExportOptions,
  SpreadsheetXlsxImportLimits,
  SpreadsheetXlsxImportOptions,
} from "./spreadsheet-file";

export type ArtifactBatchControls<Root> = Readonly<{
  /** One atomic host/native transaction; nested edits reconcile exactly once. */
  batch<Result>(callback: (artifact: Root) => Result): Result;
  /** Idempotently releases the owned exact native session. */
  dispose(): void;
}>;

export type Workbook = ReferenceWorkbook & ArtifactBatchControls<ReferenceWorkbook>;
export type Document = ReferenceDocument & ArtifactBatchControls<ReferenceDocument>;
export type Presentation = ReferencePresentation & ArtifactBatchControls<ReferencePresentation>;

export type WorkbookFactory = Readonly<{
  prototype: ReferenceWorkbook;
  [Symbol.hasInstance](value: unknown): boolean;
  create(options?: WorkbookOptions): Workbook;
  fromCSV(csvText: string, options?: { sheetName?: string; delimiter?: string }): Promise<Workbook>;
  fromJSON(input: unknown): Workbook;
}>;

export type DocumentFactory = Readonly<{
  prototype: ReferenceDocument;
  [Symbol.hasInstance](value: unknown): boolean;
  create(options?: DocumentCreateOptions): Document;
  fromJSON(input: unknown): Document;
}>;

export type PresentationFactory = Readonly<{
  prototype: ReferencePresentation;
  [Symbol.hasInstance](value: unknown): boolean;
  create(options?: PresentationCreateOptions): Presentation;
}>;

let configuredRuntime: ArtifactKernelRuntime | null = null;

/**
 * Installs the one exact native runtime selected by host bootstrap. Runtime
 * replacement is deliberately forbidden: a process that needs another target
 * must use an isolated worker/process and configure it once.
 */
export function configureArtifactRuntime(runtime: ArtifactKernelRuntime): void {
  if (runtime.kind !== "native" || runtime.target === "wasm-web") {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "The synchronous artifact facade requires an exact native N-API runtime",
    );
  }
  if (configuredRuntime && configuredRuntime !== runtime) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "A different artifact runtime is already configured in this process",
    );
  }
  configuredRuntime = runtime;
}

/** Exact configured runtime, or null before the host bootstrap runs. */
export function getConfiguredArtifactRuntime(): ArtifactKernelRuntime | null {
  return configuredRuntime;
}

const WorkbookFacade = createStaticFacade(ReferenceWorkbook, "Workbook", {
  create(options: WorkbookOptions = {}): Workbook {
    return attachWorkbook(ReferenceWorkbook.create(options), randomNamespace());
  },
  async fromCSV(
    csvText: string,
    options: { sheetName?: string; delimiter?: string } = {},
  ): Promise<Workbook> {
    return attachWorkbook(await ReferenceWorkbook.fromCSV(csvText, options), randomNamespace());
  },
  fromJSON(input: unknown): Workbook {
    return attachWorkbook(ReferenceWorkbook.fromJSON(input), randomNamespace());
  },
});

const DocumentFacade = createStaticFacade(ReferenceDocument, "Document", {
  create(options: DocumentCreateOptions = {}): Document {
    const document = ReferenceDocument.create(options);
    return attachDocument(document, BigInt(`0x${document.idNamespace}`));
  },
  fromJSON(input: unknown): Document {
    const document = ReferenceDocument.fromJSON(input);
    return attachDocument(document, BigInt(`0x${document.idNamespace}`));
  },
});

const PresentationFacade = createStaticFacade(ReferencePresentation, "Presentation", {
  create(options: PresentationCreateOptions = {}): Presentation {
    return attachPresentation(ReferencePresentation.create(options), randomNamespace());
  },
});

/** Skill-compatible factory; returned objects are exact native composites. */
export const Workbook = WorkbookFacade as unknown as WorkbookFactory;
/** Skill-compatible factory; returned objects are exact native composites. */
export const Document = DocumentFacade as unknown as DocumentFactory;
/** Skill-compatible factory; returned objects are exact native composites. */
export const Presentation = PresentationFacade as unknown as PresentationFactory;

// eslint-disable-next-line typescript/no-extraneous-class -- stable skill facade.
export class SpreadsheetFile {
  static async importXlsx(
    ...args: Parameters<typeof ReferenceSpreadsheetFile.importXlsx>
  ): Promise<Workbook> {
    requireConfiguredRuntime();
    const workbook = await ReferenceSpreadsheetFile.importXlsx(...args);
    return attachWorkbook(workbook, randomNamespace());
  }

  static async exportXlsx(
    workbook: ReferenceWorkbook,
    options: Parameters<typeof ReferenceSpreadsheetFile.exportXlsx>[1] = {},
  ): Promise<FileBlob> {
    const raw = rawArtifact<ReferenceWorkbook>(workbook, "spreadsheet");
    return await ReferenceSpreadsheetFile.exportXlsx(raw, options);
  }

  static fidelityReport(
    workbook: ReferenceWorkbook,
  ): ReturnType<typeof ReferenceSpreadsheetFile.fidelityReport> {
    return ReferenceSpreadsheetFile.fidelityReport(rawArtifact(workbook, "spreadsheet"));
  }

  static lossPreservationEnvelope(
    workbook: ReferenceWorkbook,
  ): ReturnType<typeof ReferenceSpreadsheetFile.lossPreservationEnvelope> {
    return ReferenceSpreadsheetFile.lossPreservationEnvelope(rawArtifact(workbook, "spreadsheet"));
  }

  static async attachLossPreservationEnvelope(
    workbook: ReferenceWorkbook,
    envelope: Parameters<typeof ReferenceSpreadsheetFile.attachLossPreservationEnvelope>[1],
    options: Parameters<typeof ReferenceSpreadsheetFile.attachLossPreservationEnvelope>[2] = {},
  ): Promise<void> {
    const state = requireCompositeState(workbook, "spreadsheet");
    await state.mutate(
      () =>
        ReferenceSpreadsheetFile.attachLossPreservationEnvelope(
          state.rawRoot() as ReferenceWorkbook,
          envelope,
          options,
        ),
      { member: "attachLossPreservationEnvelope", owner: state.rawRoot() },
    );
  }
}

// eslint-disable-next-line typescript/no-extraneous-class -- stable skill facade.
export class DocumentFile {
  static async importDocx(
    ...args: Parameters<typeof ReferenceDocumentFile.importDocx>
  ): Promise<Document> {
    requireConfiguredRuntime();
    const document = await ReferenceDocumentFile.importDocx(...args);
    return attachDocument(document, BigInt(`0x${document.idNamespace}`));
  }

  static async exportDocx(document: ReferenceDocument): Promise<FileBlob> {
    return await ReferenceDocumentFile.exportDocx(rawArtifact(document, "document"));
  }
}

// eslint-disable-next-line typescript/no-extraneous-class -- stable skill facade.
export class PresentationFile {
  static async importPptx(
    ...args: Parameters<typeof ReferencePresentationFile.importPptx>
  ): Promise<Presentation> {
    requireConfiguredRuntime();
    const presentation = await ReferencePresentationFile.importPptx(...args);
    return attachPresentation(presentation, randomNamespace());
  }

  static async exportPptx(
    presentation: ReferencePresentation,
    options: Parameters<typeof ReferencePresentationFile.exportPptx>[1] = {},
  ): Promise<FileBlob> {
    return await ReferencePresentationFile.exportPptx(
      rawArtifact(presentation, "presentation"),
      options,
    );
  }

  static fidelityReport(
    presentation: ReferencePresentation,
  ): ReturnType<typeof ReferencePresentationFile.fidelityReport> {
    return ReferencePresentationFile.fidelityReport(rawArtifact(presentation, "presentation"));
  }

  static lossPreservationEnvelope(
    presentation: ReferencePresentation,
  ): ReturnType<typeof ReferencePresentationFile.lossPreservationEnvelope> {
    return ReferencePresentationFile.lossPreservationEnvelope(
      rawArtifact(presentation, "presentation"),
    );
  }
}

export type ArtifactCompositeDiagnostics = Readonly<{
  version: 1;
  modality: "spreadsheet" | "document" | "presentation";
  namespace: string;
  runtimeTarget: string;
  runtimeBuildIdentity: string;
  nativeRevision: bigint;
  nativeStateHash: string;
  nativeSnapshot: Uint8Array;
  hostProjection: SerializedWorkbook | SerializedDocument | Record<string, unknown>;
}>;

type ArtifactPublicationSnapshotCommon = Readonly<{
  schemaVersion: 1;
  modality: "spreadsheet" | "document" | "presentation";
  runtimeTarget: string;
  kernelVersion: string;
  modelSchemaVersion: 1;
  snapshotVersion: 1;
  stateHash: string;
  snapshotBytes: Uint8Array;
}>;

/**
 * Exact canonical state suitable for the durable editable-artifact import
 * boundary. Unlike diagnostics, this contains only native persistence
 * authority and its exact coverage/version facts.
 */
export type ArtifactPublicationSnapshot =
  | (ArtifactPublicationSnapshotCommon &
      Readonly<{
        modality: "spreadsheet";
        coveredCausalFrontier: readonly Readonly<{
          replicaId: string;
          counter: number;
        }>[];
        operationProtocolVersion: 1;
        crdtStateVersion: 1;
      }>)
  | (ArtifactPublicationSnapshotCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

/** Captures one immutable, native-canonical publication boundary. */
export function createArtifactPublicationSnapshot(
  artifact: ReferenceWorkbook | ReferenceDocument | ReferencePresentation,
): ArtifactPublicationSnapshot {
  const state = requireCompositeState(artifact);
  const native = state.native;
  const descriptor = EDITABLE_ARTIFACT_CODEC_REGISTRY[state.modality];
  const common = {
    schemaVersion: 1 as const,
    modality: state.modality,
    runtimeTarget: native.target,
    kernelVersion: native.buildIdentity,
    modelSchemaVersion: descriptor.modelSchemaVersion,
    snapshotVersion: descriptor.snapshotVersion,
    stateHash: native.stateHash(),
    snapshotBytes: Uint8Array.from(native.snapshot()),
  };
  if (state.modality === "spreadsheet") {
    if (!(native instanceof NativeSpreadsheetSession)) {
      throw new Error("Spreadsheet composite does not own a spreadsheet native session");
    }
    return Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      coveredCausalFrontier: decodeEditableArtifactCausalFrontier(native.frontier()),
      operationProtocolVersion: COMMITTED_TRANSACTION_PROTOCOL_VERSION,
      crdtStateVersion: descriptor.snapshotVersion,
    });
  }
  if (
    !(native instanceof NativeDocumentSession) &&
    !(native instanceof NativePresentationSession)
  ) {
    throw new Error("Serialized composite does not own its expected native session");
  }
  return Object.freeze({
    ...common,
    modality: state.modality,
    nativeRevision: safePublicationRevision(native.revision()),
  });
}

/**
 * Point-in-time diagnostics only. This is deliberately not a persistence,
 * restore, or provenance envelope: presentation layout snapshots omit media
 * bytes and host capabilities, and the two projections are not cryptographically
 * bound. Durable state uses canonical collaboration snapshots plus the owned
 * format-loss envelope instead of pretending this view is restorable.
 */
export function getArtifactCompositeDiagnostics(
  artifact: ReferenceWorkbook | ReferenceDocument | ReferencePresentation,
): ArtifactCompositeDiagnostics {
  const state = requireCompositeState(artifact);
  const root = state.rawRoot() as ReferenceWorkbook | ReferenceDocument | ReferencePresentation;
  const hostProjection =
    state.modality === "presentation"
      ? (root as ReferencePresentation).layoutSnapshot()
      : (root as ReferenceWorkbook | ReferenceDocument).toJSON();
  return Object.freeze({
    version: 1,
    modality: state.modality,
    namespace: u64Hex(state.namespace),
    runtimeTarget: state.native.target,
    runtimeBuildIdentity: state.native.buildIdentity,
    nativeRevision: state.native.revision(),
    nativeStateHash: state.native.stateHash(),
    nativeSnapshot: state.native.snapshot().slice(),
    hostProjection: structuredClone(hostProjection),
  });
}

/** Idempotently closes the exact native session owned by a facade artifact. */
export function disposeArtifact(
  artifact: ReferenceWorkbook | ReferenceDocument | ReferencePresentation,
): void {
  requireCompositeState(artifact).dispose();
}

function attachWorkbook(workbook: ReferenceWorkbook, namespace: bigint): Workbook {
  const runtime = requireConfiguredRuntime();
  const reconcile = (root: ReferenceWorkbook) =>
    reconcileSpreadsheetProjection(root, runtime, namespace);
  const reconciliation = reconcile(workbook);
  const state = new CompositeArtifactState({
    modality: "spreadsheet",
    namespace,
    root: workbook,
    reconciliation,
    reconcile,
    prepareMutation: prepareSpreadsheetMutation,
    installProjection: installSpreadsheetProjection,
    readProperty: readSpreadsheetProperty,
    captureAuxiliary: captureSpreadsheetAuxiliary,
    restoreAuxiliary: restoreSpreadsheetAuxiliary,
  });
  return state.proxy() as Workbook;
}

function attachDocument(document: ReferenceDocument, namespace: bigint): Document {
  const runtime = requireConfiguredRuntime();
  const reconcile = (root: ReferenceDocument) =>
    reconcileDocumentProjection(root, runtime, namespace);
  const reconciliation = reconcile(document);
  const state = new CompositeArtifactState({
    modality: "document",
    namespace,
    root: document,
    reconciliation,
    reconcile,
    prepareMutation: prepareDocumentMutation,
    captureAuxiliary: captureDocumentAuxiliary,
    restoreAuxiliary: restoreDocumentAuxiliary,
  });
  return state.proxy() as Document;
}

function attachPresentation(presentation: ReferencePresentation, namespace: bigint): Presentation {
  const runtime = requireConfiguredRuntime();
  const reconcile = (root: ReferencePresentation) =>
    reconcilePresentationProjection(root, runtime, namespace);
  const reconciliation = reconcile(presentation);
  const state = new CompositeArtifactState({
    modality: "presentation",
    namespace,
    root: presentation,
    reconciliation,
    reconcile,
    prepareMutation: preparePresentationMutation,
    captureAuxiliary: capturePresentationAuxiliary,
    restoreAuxiliary: restorePresentationAuxiliary,
  });
  return state.proxy() as Presentation;
}

function reconcileDocumentProjection(
  document: ReferenceDocument,
  runtime: ArtifactKernelRuntime,
  namespace: bigint,
): CompositeReconciliation {
  const session = NativeDocumentSession.create(runtime, namespace);
  try {
    const commands = encodeDocumentProjectionCommands(document.toJSON());
    if (envelopeCommandCount(commands) > 0) session.applyCommands(commands);
    return { session };
  } catch (cause) {
    session.dispose();
    throw cause;
  }
}

function prepareDocumentMutation(
  mutation: CompositeMutation,
  state: CompositeArtifactState<ReferenceDocument>,
): PreparedCompositeMutation | null {
  const root = state.rawRoot();
  const owner = mutation.owner;
  const member = mutation.member;

  if (owner instanceof DocumentBlockCollection || owner instanceof DocumentStory) {
    if (
      member === "addParagraph" ||
      member === "addHeading" ||
      member === "addTable" ||
      member === "addPageBreak"
    ) {
      const target =
        owner instanceof DocumentStory
          ? documentStoryTarget(root, owner)
          : { kind: "body" as const };
      return commitDocumentMutation(state, (result) => {
        if (!isSerializedDocumentBlock(result)) {
          throw new Error(`${String(member)} did not return a document block`);
        }
        return [{ kind: "block.add", target, block: result.serialize() }];
      });
    }
  }

  if (owner instanceof DocumentParagraph) {
    if (member === "setStyle") {
      const style = mutation.arguments?.[0] as Parameters<DocumentParagraph["setStyle"]>[0];
      return commitDocumentMutation(state, () => [
        { kind: "paragraph.style", id: owner.id, style },
      ]);
    }
    if (member === "format") {
      const format = mutation.arguments?.[0] as Parameters<DocumentParagraph["format"]>[0];
      return commitDocumentMutation(state, () => [
        { kind: "paragraph.format", id: owner.id, format },
      ]);
    }
    if (member === "edit") {
      const edit = documentParagraphEdit(mutation.arguments ?? []);
      if (!edit) return null;
      return commitDocumentMutation(state, () => [
        { kind: "paragraph.edit", id: owner.id, ...edit },
      ]);
    }
    if (member === "append") {
      const text = mutation.arguments?.[0];
      const style = mutation.arguments?.[1] ?? {};
      if (typeof text !== "string" || typeof style !== "object" || style === null) return null;
      const start = owner.text.length;
      return commitDocumentMutation(state, () => [
        {
          kind: "paragraph.edit",
          id: owner.id,
          start,
          end: start,
          text,
          style: style as DocumentTextStyle,
        },
      ]);
    }
    if (member === "text") {
      const before = owner.text;
      return commitDocumentMutation(state, () => {
        const edit = minimalDocumentTextEdit(before, owner.text);
        return edit ? [{ kind: "paragraph.edit", id: owner.id, ...edit }] : [];
      });
    }
    if (member === "replace") {
      const search = mutation.arguments?.[0];
      const before = owner.text;
      if (
        typeof search !== "string" ||
        search.length === 0 ||
        before.indexOf(search) !== before.lastIndexOf(search)
      ) {
        return null;
      }
      return commitDocumentMutation(state, () => {
        const edit = minimalDocumentTextEdit(before, owner.text);
        return edit ? [{ kind: "paragraph.edit", id: owner.id, ...edit }] : [];
      });
    }
  }

  if (owner instanceof DocumentTable && member === "setStyle") {
    const style = mutation.arguments?.[0] as Parameters<DocumentTable["setStyle"]>[0];
    return commitDocumentMutation(state, () => [{ kind: "table.style", id: owner.id, style }]);
  }
  if (owner === root && (member === "setEvenAndOddHeaders" || member === "setTrackRevisions")) {
    const enabled = mutation.arguments?.[0];
    if (typeof enabled !== "boolean") return null;
    return commitDocumentMutation(state, () => [
      {
        kind: "document.flags",
        ...(member === "setEvenAndOddHeaders"
          ? { evenAndOddHeaders: enabled }
          : { trackRevisions: enabled }),
      },
    ]);
  }
  if (owner instanceof DocumentSections && member === "add") {
    return commitDocumentMutation(state, (result) => {
      if (!(result instanceof DocumentSection))
        throw new Error("Section add did not return a section");
      return [{ kind: "section.add", section: result.serialize() }];
    });
  }
  if (owner instanceof DocumentSection && member === "setTitlePage") {
    const enabled = mutation.arguments?.[0];
    if (typeof enabled !== "boolean") return null;
    return commitDocumentMutation(state, () => [
      { kind: "section.title", id: owner.id, titlePage: enabled },
    ]);
  }
  if (owner instanceof DocumentComments) {
    if (member === "setSelf") return { commit: () => false };
    if (member === "addThread") {
      return commitDocumentMutation(state, (result) => {
        if (!(result instanceof DocumentCommentThread))
          throw new Error("Comment add did not return a thread");
        return [{ kind: "comment.add", comment: result.serialize() }];
      });
    }
  }
  if (owner instanceof DocumentCommentThread) {
    if (member === "addReply") {
      const before = owner.replies.length;
      return commitDocumentMutation(state, () => {
        const reply = owner.serialize().replies[before];
        return reply ? [{ kind: "comment.reply", id: owner.id, reply }] : [];
      });
    }
    if (member === "resolve" || member === "reopen") {
      const before = owner.resolved;
      return commitDocumentMutation(state, () =>
        before === owner.resolved
          ? []
          : [{ kind: "comment.resolved", id: owner.id, resolved: owner.resolved }],
      );
    }
  }
  if (owner instanceof TrackedChanges && member === "add") {
    return commitDocumentMutation(state, (result) => {
      if (
        !result ||
        typeof result !== "object" ||
        typeof Reflect.get(result, "serialize") !== "function"
      ) {
        throw new Error("Tracked-change add did not return a change");
      }
      return [
        {
          kind: "tracked.add",
          change: (
            Reflect.get(result, "serialize") as () => ReturnType<
              ReferenceDocument["toJSON"]
            >["changes"][number]
          ).call(result),
        },
      ];
    });
  }
  return null;
}

function commitDocumentMutation(
  state: CompositeArtifactState<ReferenceDocument>,
  commands: (result: unknown) => Parameters<typeof encodeDocumentIncrementalCommands>[0],
): PreparedCompositeMutation {
  return {
    commit(result) {
      const batch = commands(result);
      if (batch.length === 0) return false;
      const session = state.native;
      if (!(session instanceof NativeDocumentSession))
        throw new TypeError("Expected native document session");
      const before = session.revision();
      session.applyCommands(encodeDocumentIncrementalCommands(batch));
      return session.revision() > before;
    },
  };
}

function documentStoryTarget(
  document: ReferenceDocument,
  story: DocumentStory,
): DocumentProjectionTarget {
  for (const section of document.sections.items) {
    for (const storyKind of ["header", "footer"] as const) {
      const collection = storyKind === "header" ? section.headers : section.footers;
      for (const variant of ["default", "first", "even"] as const) {
        if (collection[variant] === story)
          return { kind: "story", sectionId: section.id, storyKind, variant };
      }
    }
  }
  throw new Error(`Document story is not attached: ${story.id}`);
}

function isSerializedDocumentBlock(value: unknown): value is {
  serialize(): SerializedDocumentBlock;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "serialize") === "function"
  );
}

function documentParagraphEdit(
  args: readonly unknown[],
): { start: number; end: number; text: string; style?: DocumentTextStyle } | null {
  if (typeof args[0] === "number") {
    if (typeof args[1] !== "number" || typeof args[2] !== "string") return null;
    return {
      start: args[0],
      end: args[1],
      text: args[2],
      ...(args[3] && typeof args[3] === "object" ? { style: args[3] as DocumentTextStyle } : {}),
    };
  }
  const edit = args[0] as
    | { start?: unknown; end?: unknown; text?: unknown; style?: unknown }
    | undefined;
  if (
    !edit ||
    typeof edit.start !== "number" ||
    typeof edit.end !== "number" ||
    typeof edit.text !== "string"
  ) {
    return null;
  }
  return {
    start: edit.start,
    end: edit.end,
    text: edit.text,
    ...(edit.style && typeof edit.style === "object"
      ? { style: edit.style as DocumentTextStyle }
      : {}),
  };
}

function minimalDocumentTextEdit(
  before: string,
  after: string,
): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start])
    start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { start, end: beforeEnd, text: after.slice(start, afterEnd) };
}

function reconcilePresentationProjection(
  presentation: ReferencePresentation,
  runtime: ArtifactKernelRuntime,
  namespace: bigint,
): CompositeReconciliation {
  const session = NativePresentationSession.create(runtime, namespace);
  try {
    const commands = encodePresentationProjectionCommands(presentation, namespace);
    if (envelopeCommandCount(commands) > 0) session.applyCommands(commands);
    return { session };
  } catch (cause) {
    session.dispose();
    throw cause;
  }
}

function preparePresentationMutation(
  mutation: CompositeMutation,
  state: CompositeArtifactState<ReferencePresentation>,
): PreparedCompositeMutation | null {
  const root = state.rawRoot();
  const owner = mutation.owner;
  const member = mutation.member;

  if (owner instanceof SlideCollection && member === "add") {
    const index = root.slides.items.length;
    return commitPresentationMutation(state, (result) => {
      if (!(result instanceof Slide)) throw new Error("Slide add did not return a slide");
      return [{ kind: "slide.create", slide: result, index }];
    });
  }

  if (
    (owner instanceof PresentationShapeCollection ||
      owner instanceof PresentationChartCollection ||
      owner instanceof PresentationImageCollection ||
      owner instanceof PresentationTableCollection ||
      owner instanceof PresentationGroupCollection) &&
    member === "add"
  ) {
    return commitPresentationMutation(state, (result) => {
      if (!isPresentationElement(result))
        throw new Error("Presentation add did not return an element");
      const index = result.slide.elements.indexOf(result);
      if (index < 0) throw new Error("Presentation element was not attached to its slide");
      return [{ kind: "node.insert", slideId: result.slide.id, index, element: result }];
    });
  }

  if (owner instanceof Slide) {
    if (member === "title") {
      return commitPresentationMutation(state, () => [
        { kind: "slide.title", id: owner.id, title: owner.title },
      ]);
    }
    if (member === "setLayout") {
      return commitPresentationMutation(state, () => [
        {
          kind: "slide.layout",
          id: owner.id,
          ...(owner.layout ? { layoutId: owner.layout.id } : {}),
        },
      ]);
    }
  }

  if (owner === root.slideSize && (member === "width" || member === "height")) {
    return commitPresentationMutation(state, () => [
      {
        kind: "presentation.size",
        width: root.slideSize.width,
        height: root.slideSize.height,
      },
    ]);
  }

  if (owner instanceof PresentationText) {
    const target = findPresentationTextOwner(root, owner);
    if (!target) return null;
    return commitPresentationMutation(state, () =>
      target.kind === "notes"
        ? [{ kind: "slide.notes", id: target.slide.id, notes: owner }]
        : [{ kind: "node.update", element: target.element }],
    );
  }

  if (isPresentationElement(owner)) {
    return commitPresentationMutation(state, () => [{ kind: "node.update", element: owner }]);
  }
  return null;
}

function commitPresentationMutation(
  state: CompositeArtifactState<ReferencePresentation>,
  commands: (result: unknown) => Parameters<typeof encodePresentationIncrementalCommands>[0],
): PreparedCompositeMutation {
  return {
    commit(result) {
      const batch = commands(result);
      if (batch.length === 0) return false;
      const session = state.native;
      if (!(session instanceof NativePresentationSession)) {
        throw new TypeError("Expected native presentation session");
      }
      const before = session.revision();
      session.applyCommands(encodePresentationIncrementalCommands(batch, state.namespace));
      return session.revision() > before;
    },
  };
}

function isPresentationElement(value: unknown): value is PresentationElement {
  return (
    value instanceof PresentationShape ||
    value instanceof PresentationChart ||
    value instanceof PresentationImage ||
    value instanceof PresentationTable ||
    value instanceof PresentationGroup
  );
}

function findPresentationTextOwner(
  presentation: ReferencePresentation,
  text: PresentationText,
): { kind: "notes"; slide: Slide } | { kind: "node"; element: PresentationElement } | null {
  const visit = (element: PresentationElement): PresentationElement | null => {
    if (element instanceof PresentationShape && element.text === text) return element;
    if (element instanceof PresentationGroup) {
      for (const child of element.children) {
        const match = visit(child);
        if (match) return match;
      }
    }
    if (element instanceof PresentationTable) {
      if (element.rows.some((row) => row.some((cell) => cell?.text === text))) return element;
    }
    return null;
  };
  for (const slide of presentation.slides.items) {
    if (slide.notes === text) return { kind: "notes", slide };
    for (const element of slide.elements) {
      const match = visit(element);
      if (match) return { kind: "node", element: match };
    }
  }
  return null;
}

function captureSpreadsheetAuxiliary(workbook: ReferenceWorkbook): unknown {
  const value = LOSS_PRESERVATION.get(workbook);
  return value ? structuredClone(value) : undefined;
}

function restoreSpreadsheetAuxiliary(workbook: ReferenceWorkbook, value: unknown): void {
  if (value)
    LOSS_PRESERVATION.set(workbook, value as NonNullable<ReturnType<typeof LOSS_PRESERVATION.get>>);
}

function captureDocumentAuxiliary(document: ReferenceDocument): unknown {
  const value = DOCUMENT_LOSS_PRESERVATION.get(document);
  return value ? structuredClone(value) : undefined;
}

function restoreDocumentAuxiliary(document: ReferenceDocument, value: unknown): void {
  if (value) {
    DOCUMENT_LOSS_PRESERVATION.set(
      document,
      value as NonNullable<ReturnType<typeof DOCUMENT_LOSS_PRESERVATION.get>>,
    );
  }
}

function capturePresentationAuxiliary(presentation: ReferencePresentation): unknown {
  const value = presentationLossState(presentation);
  return value ? structuredClone(value) : undefined;
}

function restorePresentationAuxiliary(presentation: ReferencePresentation, value: unknown): void {
  setPresentationLossState(presentation, value as ReturnType<typeof presentationLossState>);
}

function rawArtifact<Root extends object>(
  artifact: Root,
  modality: "spreadsheet" | "document" | "presentation",
): Root {
  return requireCompositeState(artifact, modality).rawRoot() as Root;
}

function createStaticFacade<Constructor extends Function>(
  reference: Constructor,
  name: string,
  statics: Readonly<Record<string, (...args: never[]) => unknown>>,
): Constructor {
  const facade = function ArtifactFacade(): never {
    throw new TypeError(`${name} cannot be constructed directly; use ${name}.create()`);
  };
  Object.setPrototypeOf(facade, reference);
  Object.defineProperty(facade, "name", { configurable: true, value: name });
  Object.defineProperty(facade, "prototype", { value: reference.prototype });
  for (const [key, value] of Object.entries(statics)) {
    Object.defineProperty(facade, key, { configurable: false, enumerable: false, value });
  }
  return facade as unknown as Constructor;
}

function requireConfiguredRuntime(): ArtifactKernelRuntime {
  if (!configuredRuntime) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "No exact artifact runtime is configured; host bootstrap must call configureArtifactRuntime()",
    );
  }
  return configuredRuntime;
}

function envelopeCommandCount(bytes: Uint8Array): number {
  if (bytes.byteLength < 16) throw new TypeError("Native command envelope is truncated");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
}

function randomNamespace(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(2));
  const namespace = (BigInt(words[0]!) << 32n) | BigInt(words[1]!);
  return namespace === 0n ? randomNamespace() : namespace;
}

function u64Hex(value: bigint): string {
  if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("Artifact namespace must be a nonzero u64");
  }
  return value.toString(16).padStart(16, "0");
}

function safePublicationRevision(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Artifact native revision exceeds the durable publication range");
  }
  return Number(value);
}
