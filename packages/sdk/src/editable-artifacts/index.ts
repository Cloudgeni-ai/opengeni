export {
  createEditableArtifactSyncController,
  editableArtifactCacheNamespace,
  type CreateEditableArtifactSyncControllerOptions,
  type EditableArtifactCacheAuthority,
  type EditableArtifactQueueCommandsInput,
  type EditableArtifactSyncController,
} from "./controller";
export {
  createBrowserEditableArtifactSession,
  createEditableArtifactReplicaId,
} from "./browser-session";
export type {
  CreateBrowserEditableArtifactSessionOptions,
  EditableArtifactBrowserRuntime,
} from "./browser-session";
export { EditableArtifactSyncError, EditableArtifactTransportError } from "./errors";
export type { EditableArtifactSyncErrorCode } from "./errors";
export { createEditableArtifactHttpLiveTransport } from "./http-live-transport";
export type {
  CreateEditableArtifactHttpLiveTransportOptions,
  EditableArtifactWebSocketCloseEvent,
  EditableArtifactWebSocketLike,
  EditableArtifactWebSocketMessageEvent,
} from "./http-live-transport";
export {
  EditableArtifactStorageConflictError,
  IndexedDbEditableArtifactStorage,
  MemoryEditableArtifactStorage,
} from "./storage";
export type {
  EditableArtifactAppendCommittedInput,
  EditableArtifactExpectedStoredHead,
  EditableArtifactStoragePort,
  EditableArtifactStorageScope,
  IndexedDbEditableArtifactStorageOptions,
} from "./storage";
export { EditableArtifactSyncPool } from "./pool";
export type { EditableArtifactSyncControllerFactory, EditableArtifactSyncLease } from "./pool";
export { createEditableArtifactSession } from "./session";
export type {
  CreateEditableArtifactSessionOptions,
  ApplySerializedArtifactCommandsOptions,
  ApplySpreadsheetCommandsOptions,
  CreateDocumentParagraphInput,
  CreateDocumentParagraphResult,
  CreatePresentationSlideInput,
  CreatePresentationSlideResult,
  CreateSpreadsheetSheetInput,
  CreateSpreadsheetSheetResult,
  EditableArtifactSession,
  EditableSpreadsheetMetadataListener,
  EditableSpreadsheetViewportListener,
  EditableSpreadsheetViewportSubscriptionOptions,
} from "./session";
export type {
  EditableArtifactBootstrap,
  EditableArtifactBlockedPending,
  EditableArtifactCausalEntry,
  EditableArtifactCausalFrontier,
  EditableArtifactCommittedTransaction,
  EditableArtifactId,
  EditableArtifactModality,
  EditableArtifactLiveClose,
  EditableArtifactLiveConnection,
  EditableArtifactLiveLimits,
  EditableArtifactLiveMessage,
  EditableArtifactPendingTransaction,
  EditableArtifactSerializedCommittedTransaction,
  EditableArtifactSerializedModality,
  EditableArtifactSerializedPendingTransaction,
  EditableArtifactSerializedSnapshot,
  EditableArtifactReplayPage,
  EditableArtifactSnapshot,
  EditableArtifactSpreadsheetCommittedTransaction,
  EditableArtifactSpreadsheetPendingTransaction,
  EditableArtifactSpreadsheetSnapshot,
  EditableArtifactStoredReplica,
  EditableArtifactSubmitReceipt,
  EditableArtifactSyncListener,
  EditableArtifactSyncScheduler,
  EditableArtifactSyncState,
  EditableArtifactSyncTicket,
  EditableArtifactSyncTransport,
  EditableArtifactSyncView,
  EditableArtifactWorkerKernel,
  EditableDocumentProjection,
  EditableDocumentQuery,
  EditablePresentationProjection,
  EditablePresentationQuery,
  EditablePresentationEditorSlideProjection,
  EditablePresentationEditorSlideQuery,
  EditablePresentationSlideCatalogProjection,
  EditablePresentationSlideCatalogQuery,
  EditableSpreadsheetCellValue,
  EditableSpreadsheetFormulaError,
  EditableSpreadsheetMetadataProjection,
  EditableSpreadsheetMetadataQuery,
  EditableSpreadsheetProjectedCell,
  EditableSpreadsheetSheetMetadata,
  EditableSpreadsheetUsedBounds,
  EditableSpreadsheetViewportProjection,
  EditableSpreadsheetViewportQuery,
} from "./types";
export {
  ArtifactWorkerClientError,
  createBrowserEditableArtifactWorkerKernel,
} from "./worker/browser-client";
export type {
  ArtifactWorkerClientEndpoint,
  ArtifactWorkerClientErrorEvent,
  ArtifactWorkerClientMessageEvent,
  BrowserEditableArtifactWorkerKernel,
  CreateBrowserEditableArtifactWorkerKernelOptions,
} from "./worker/browser-client";

// Exact spreadsheet command construction used by SDK-backed UI adapters.
// Re-exporting the narrow codec leaf keeps React consumers on the SDK public
// boundary instead of coupling them directly to contracts internals.
export {
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  editableArtifactStableId,
  spreadsheetSheetId,
  type SpreadsheetArtifactCommandBatch,
  type SpreadsheetCellInput,
  type SpreadsheetSheetGeneration,
} from "@opengeni/contracts/spreadsheet-artifact-commands";

export {
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  encodeDocumentArtifactCommandBatch,
  type DocumentArtifactCommand,
  type DocumentArtifactCommandBatch,
  type DocumentArtifactCommentReply,
  type DocumentArtifactId,
  type DocumentArtifactPageGeometry,
  type DocumentArtifactPageGeometryProjection,
  type DocumentArtifactParagraphStyle,
  type DocumentArtifactProjection,
  type DocumentArtifactProjectionItem,
  type DocumentArtifactQuery,
  type DocumentArtifactQueryLimits,
  type DocumentArtifactTableStyle,
  type DocumentArtifactTextRange,
  type DocumentArtifactTextRun,
  type DocumentArtifactTextStyle,
  type DocumentArtifactTextStylePatch,
} from "@opengeni/contracts/document-artifact-commands";

export {
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  PRESENTATION_ARTIFACT_QUERY_MAX_NODES,
  PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES,
  PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES,
  PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  encodePresentationArtifactCommandBatch,
  type PresentationArtifactEditorSceneNode,
  type PresentationArtifactEditorSlideResponse,
  type PresentationArtifactFill,
  type PresentationArtifactLine,
  type PresentationArtifactNodeKind,
  type PresentationArtifactOwner,
  type PresentationArtifactRect,
  type PresentationArtifactRichText,
  type PresentationArtifactCommand,
  type PresentationArtifactCommandBatch,
  type PresentationArtifactSlideCatalogItem,
  type PresentationArtifactSlideCatalogResponse,
  type PresentationArtifactSlideLayoutFacts,
  type PresentationArtifactTableCell,
  type PresentationArtifactTextParagraph,
  type PresentationArtifactTextRun,
  type PresentationArtifactTextStyle,
  type PresentationArtifactTransform,
} from "@opengeni/contracts/presentation-artifact-commands";
