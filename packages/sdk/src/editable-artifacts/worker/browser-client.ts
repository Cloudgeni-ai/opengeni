import {
  decodeSpreadsheetMetadataKernelProjection,
  decodeSpreadsheetViewportKernelProjection,
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  encodeSpreadsheetMetadataKernelQuery,
  encodeSpreadsheetViewportKernelQuery,
  spreadsheetSheetId,
  SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS,
  SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
  SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS,
  type SpreadsheetArtifactViewportQuery,
} from "@opengeni/contracts/editable-artifacts";
import {
  decodeDocumentArtifactQueryResponse,
  encodeDocumentArtifactQuery,
} from "@opengeni/contracts/document-artifact-query";
import {
  decodePresentationArtifactQueryResponse,
  encodePresentationArtifactQuery,
} from "@opengeni/contracts/presentation-artifact-query";
import type {
  EditableDocumentProjection,
  EditableDocumentQuery,
  EditableArtifactModality,
  EditableArtifactPendingTransaction,
  EditableArtifactWorkerKernel,
  EditableSpreadsheetMetadataQuery,
  EditableSpreadsheetViewportQuery,
  EditablePresentationProjection,
  EditablePresentationQuery,
  EditablePresentationEditorSlideProjection,
  EditablePresentationEditorSlideQuery,
  EditablePresentationSlideCatalogProjection,
  EditablePresentationSlideCatalogQuery,
} from "../types";
import {
  ArtifactWorkerRpcKind,
  DEFAULT_ARTIFACT_WORKER_RPC_LIMITS,
  decodeArtifactWorkerRpcMessage,
  encodeArtifactWorkerRpcMessage,
  ownedTransferBuffer,
  transferListForArtifactWorkerRpcMessage,
  type ArtifactWorkerRpcLimits,
  type ArtifactWorkerRpcMessage,
} from "./rpc-protocol";
import {
  decodeErrorPayload,
  decodePendingListMetadata,
  decodeProjectionResponse,
  decodeStateResponse,
  encodeAuthorPendingMetadata,
  encodeCommittedMetadata,
  encodeInitialize,
  encodePendingListMetadata,
  encodeReconcileMetadata,
  encodeSnapshotMetadata,
  type ArtifactWorkerInitializeInput,
} from "./wire-codec";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const DEFAULT_MAX_COMMAND_BYTES = EDITABLE_ARTIFACT_COMMAND_MAX_BYTES;
const DEFAULT_MAX_INTENT_BYTES = EDITABLE_ARTIFACT_INTENT_MAX_BYTES;
const DEFAULT_MAX_COMMITTED_TRANSACTION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_QUERY_BYTES = 256;
const DEFAULT_MAX_QUERY_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PENDING_TRANSACTIONS = 1_024;
const DEFAULT_MAX_PENDING_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_CLIENT_QUEUED_REQUESTS = 64;
const MAX_VIEWPORT_AREA = 1_048_576;
const UINT32_MAX = 0xffff_ffff;

export type ArtifactWorkerClientMessageEvent = { data: unknown };
export type ArtifactWorkerClientErrorEvent = { error?: unknown; message?: string };

export type ArtifactWorkerClientEndpoint = {
  postMessage: (message: ArtifactWorkerRpcMessage, transfer: Transferable[]) => void;
  addEventListener: {
    (type: "message", listener: (event: ArtifactWorkerClientMessageEvent) => void): void;
    (
      type: "error" | "messageerror",
      listener: (event: ArtifactWorkerClientErrorEvent) => void,
    ): void;
  };
  removeEventListener: {
    (type: "message", listener: (event: ArtifactWorkerClientMessageEvent) => void): void;
    (
      type: "error" | "messageerror",
      listener: (event: ArtifactWorkerClientErrorEvent) => void,
    ): void;
  };
  terminate: () => void;
};

export type CreateBrowserEditableArtifactWorkerKernelOptions = {
  modality: EditableArtifactModality;
  /** Exact package/runtime identity; checked before the Worker accepts state. */
  kernelVersion: string;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandVersion: number;
  /**
   * Prebuilt module-Worker entry. No blob/eval worker is ever synthesized.
   * Bundler example: import `workerUrl` from
   * `@opengeni/sdk/editable-artifacts/worker?worker&url`, then pass it here.
   */
  workerUrl: string | URL;
  /** wasm-bindgen ESM glue built from the pinned artifact kernel. */
  wasmGlueUrl: string | URL;
  /** Exact `.wasm` asset paired with the glue. */
  wasmBinaryUrl: string | URL;
  /**
   * Origin hosting the embedding application. Browser runtimes default to
   * `location.origin`; non-browser/custom Worker hosts must supply it.
   */
  applicationOrigin?: string | URL;
  /** Additional explicitly trusted asset origins; same-origin is the default. */
  allowedAssetOrigins?: readonly string[];
  /** Only for local development. Production assets must use HTTPS. */
  allowInsecureDevelopmentAssets?: boolean;
  requestTimeoutMs?: number;
  initializationTimeoutMs?: number;
  maximumSnapshotBytes?: number;
  maximumCommandBytes?: number;
  maximumIntentBytes?: number;
  maximumCommittedTransactionBytes?: number;
  maximumQueryBytes?: number;
  maximumQueryResponseBytes?: number;
  maximumPendingTransactions?: number;
  maximumPendingAggregateBytes?: number;
  rpcLimits?: Readonly<ArtifactWorkerRpcLimits>;
  workerFactory?: (
    url: URL,
    options: { type: "module"; name: string },
  ) => ArtifactWorkerClientEndpoint;
};

export type BrowserEditableArtifactWorkerKernel = EditableArtifactWorkerKernel & {
  queryPresentationSlideCatalog: (
    query: EditablePresentationSlideCatalogQuery,
  ) => Promise<EditablePresentationSlideCatalogProjection>;
  queryPresentationEditorSlide: (
    query: EditablePresentationEditorSlideQuery,
  ) => Promise<EditablePresentationEditorSlideProjection>;
  /** Requests bounded graceful cleanup, then terminates the Worker. Idempotent. */
  dispose: () => Promise<void>;
  /** Retires a failed generation; the next method call lazily starts a fresh Worker. */
  restart: () => void;
};

export class ArtifactWorkerClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactWorkerClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

type RpcResult = {
  metadata: Uint8Array;
  segments: Uint8Array[];
};

type PendingRequest = {
  resolve: (result: RpcResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type WorkerGeneration = {
  endpoint: ArtifactWorkerClientEndpoint;
  generation: number;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  ready: Promise<void>;
  initialized: boolean;
  onMessage: (event: ArtifactWorkerClientMessageEvent) => void;
  onError: (event: ArtifactWorkerClientErrorEvent) => void;
};

export function createBrowserEditableArtifactWorkerKernel(
  options: CreateBrowserEditableArtifactWorkerKernelOptions,
): BrowserEditableArtifactWorkerKernel {
  return new BrowserArtifactWorkerKernelClient(options);
}

class BrowserArtifactWorkerKernelClient implements BrowserEditableArtifactWorkerKernel {
  private readonly workerUrl: URL;
  private readonly initialization: ArtifactWorkerInitializeInput;
  private readonly requestTimeoutMs: number;
  private readonly initializationTimeoutMs: number;
  private readonly maximumPendingAggregateBytes: number;
  private readonly maximumQueuedTransferBytes: number;
  private readonly rpcLimits: Readonly<ArtifactWorkerRpcLimits>;
  private readonly workerFactory: NonNullable<
    CreateBrowserEditableArtifactWorkerKernelOptions["workerFactory"]
  >;
  private generationCounter = 0;
  private admittedRequests = 0;
  private admittedTransferBytes = 0;
  private active: WorkerGeneration | null = null;
  private disposed = false;

  constructor(options: CreateBrowserEditableArtifactWorkerKernelOptions) {
    this.workerUrl = canonicalUrl(options.workerUrl, "workerUrl");
    const wasmGlueUrl = canonicalUrl(options.wasmGlueUrl, "wasmGlueUrl");
    const wasmBinaryUrl = canonicalUrl(options.wasmBinaryUrl, "wasmBinaryUrl");
    validateAssetPolicy(
      [this.workerUrl, wasmGlueUrl, wasmBinaryUrl],
      resolveApplicationOrigin(options.applicationOrigin),
      options.allowedAssetOrigins ?? [],
      options.allowInsecureDevelopmentAssets ?? false,
    );
    const modality = requireModality(options.modality);
    const modalityQueryBytes =
      modality === "document" ? 256 : modality === "presentation" ? 96 : 68;
    this.initialization = {
      modality,
      kernelVersion: boundedVersion(options.kernelVersion, "kernelVersion"),
      protocolVersion: positiveVersion(options.protocolVersion, "protocolVersion"),
      modelSchemaVersion: positiveVersion(options.modelSchemaVersion, "modelSchemaVersion"),
      commandVersion: positiveVersion(options.commandVersion, "commandVersion"),
      wasmGlueUrl: wasmGlueUrl.href,
      wasmBinaryUrl: wasmBinaryUrl.href,
      maximumSnapshotBytes: boundedMaximum(
        options.maximumSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
        DEFAULT_MAX_SNAPSHOT_BYTES,
        "maximumSnapshotBytes",
      ),
      maximumCommandBytes: boundedMaximum(
        options.maximumCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES,
        DEFAULT_MAX_COMMAND_BYTES,
        "maximumCommandBytes",
      ),
      maximumIntentBytes: boundedMaximum(
        options.maximumIntentBytes ?? DEFAULT_MAX_INTENT_BYTES,
        DEFAULT_MAX_INTENT_BYTES,
        "maximumIntentBytes",
      ),
      maximumCommittedTransactionBytes: boundedMaximum(
        options.maximumCommittedTransactionBytes ?? DEFAULT_MAX_COMMITTED_TRANSACTION_BYTES,
        DEFAULT_MAX_COMMITTED_TRANSACTION_BYTES,
        "maximumCommittedTransactionBytes",
      ),
      maximumQueryBytes: boundedMaximum(
        options.maximumQueryBytes ?? modalityQueryBytes,
        DEFAULT_MAX_QUERY_BYTES,
        "maximumQueryBytes",
      ),
      maximumQueryResponseBytes: boundedMaximum(
        options.maximumQueryResponseBytes ?? DEFAULT_MAX_QUERY_RESPONSE_BYTES,
        DEFAULT_MAX_QUERY_RESPONSE_BYTES,
        "maximumQueryResponseBytes",
      ),
      maximumPendingTransactions: boundedMaximum(
        options.maximumPendingTransactions ?? DEFAULT_MAX_PENDING_TRANSACTIONS,
        DEFAULT_MAX_PENDING_TRANSACTIONS,
        "maximumPendingTransactions",
      ),
    };
    this.maximumPendingAggregateBytes = boundedMaximum(
      options.maximumPendingAggregateBytes ?? DEFAULT_MAX_PENDING_AGGREGATE_BYTES,
      DEFAULT_MAX_PENDING_AGGREGATE_BYTES,
      "maximumPendingAggregateBytes",
    );
    this.maximumQueuedTransferBytes = Math.max(
      this.initialization.maximumSnapshotBytes,
      this.initialization.maximumCommittedTransactionBytes + this.maximumPendingAggregateBytes,
      this.initialization.maximumCommandBytes,
    );
    this.requestTimeoutMs = positiveSafeInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.initializationTimeoutMs = positiveSafeInteger(
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
      "initializationTimeoutMs",
    );
    this.rpcLimits = normalizeClientRpcLimits(
      options.rpcLimits ?? DEFAULT_ARTIFACT_WORKER_RPC_LIMITS,
    );
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
  }

  async reset(): Promise<void> {
    return await this.withAdmission(0, async () => {
      const result = await this.request(ArtifactWorkerRpcKind.Reset);
      requireEmptyResult(result, "reset");
    });
  }

  async loadSnapshot(
    snapshot: Parameters<EditableArtifactWorkerKernel["loadSnapshot"]>[0],
  ): ReturnType<EditableArtifactWorkerKernel["loadSnapshot"]> {
    const transferBytes = this.segmentByteLength(
      snapshot.bytes,
      this.initialization.maximumSnapshotBytes,
      "snapshot",
    );
    return await this.withAdmission(transferBytes, async () => {
      const segment = this.ownedSegment(
        snapshot.bytes,
        this.initialization.maximumSnapshotBytes,
        "snapshot",
      );
      const result = await this.request(
        ArtifactWorkerRpcKind.LoadSnapshot,
        encodeSnapshotMetadata(snapshot),
        [segment],
      );
      if (result.segments.length !== 0)
        throw clientError("invalid_response", "snapshot response has segments");
      const decoded = decodeStateResponse(result.metadata);
      if (!decoded.digest)
        throw clientError("invalid_response", "snapshot response omitted its digest");
      return { stateHash: decoded.stateHash, digest: decoded.digest };
    });
  }

  async applyRecovered(
    transaction: Parameters<EditableArtifactWorkerKernel["applyRecovered"]>[0],
  ): ReturnType<EditableArtifactWorkerKernel["applyRecovered"]> {
    const transferBytes = this.segmentByteLength(
      transaction.committedTransactionBytes,
      this.initialization.maximumCommittedTransactionBytes,
      "committed operation",
    );
    return await this.withAdmission(transferBytes, async () => {
      const segment = this.ownedSegment(
        transaction.committedTransactionBytes,
        this.initialization.maximumCommittedTransactionBytes,
        "committed operation",
      );
      const result = await this.request(
        ArtifactWorkerRpcKind.ApplyRecovered,
        encodeCommittedMetadata(transaction),
        [segment],
      );
      if (result.segments.length !== 0)
        throw clientError("invalid_response", "apply response has segments");
      const decoded = decodeStateResponse(result.metadata);
      if (decoded.digest)
        throw clientError("invalid_response", "apply response unexpectedly contains a digest");
      return { stateHash: decoded.stateHash };
    });
  }

  async reconcileCommitted(
    transaction: Parameters<EditableArtifactWorkerKernel["reconcileCommitted"]>[0],
    remainingPending: Parameters<EditableArtifactWorkerKernel["reconcileCommitted"]>[1],
  ): ReturnType<EditableArtifactWorkerKernel["reconcileCommitted"]> {
    const transferBytes = this.measurePendingTransfer(
      remainingPending,
      transaction.committedTransactionBytes,
    );
    return await this.withAdmission(transferBytes, async () => {
      const segments = this.pendingSegments(
        remainingPending,
        transaction.committedTransactionBytes,
      );
      const result = await this.request(
        ArtifactWorkerRpcKind.ReconcileCommitted,
        encodeReconcileMetadata(transaction, remainingPending),
        segments,
      );
      if (result.segments.length !== 0) {
        throw clientError("invalid_response", "reconcile response has segments");
      }
      const decoded = decodeProjectionResponse(result.metadata);
      if (!decoded.stateHash)
        throw clientError("invalid_response", "reconcile response omitted stateHash");
      return { stateHash: decoded.stateHash, blockedPending: decoded.blockedPending };
    });
  }

  async replacePending(
    transactions: Parameters<EditableArtifactWorkerKernel["replacePending"]>[0],
  ): ReturnType<EditableArtifactWorkerKernel["replacePending"]> {
    const transferBytes = this.measurePendingTransfer(transactions);
    return await this.withAdmission(transferBytes, async () => {
      const segments = this.pendingSegments(transactions);
      const result = await this.request(
        ArtifactWorkerRpcKind.ReplacePending,
        encodePendingListMetadata(transactions),
        segments,
      );
      if (result.segments.length !== 0) {
        throw clientError("invalid_response", "pending response has segments");
      }
      const decoded = decodeProjectionResponse(result.metadata);
      if (decoded.stateHash) {
        throw clientError("invalid_response", "pending response unexpectedly contains stateHash");
      }
      return { blockedPending: decoded.blockedPending };
    });
  }

  async authorPending(
    input: Parameters<EditableArtifactWorkerKernel["authorPending"]>[0],
  ): ReturnType<EditableArtifactWorkerKernel["authorPending"]> {
    if (input.modality !== this.initialization.modality) {
      throw clientError("modality_mismatch", "pending modality does not match Worker", false);
    }
    const transferBytes = this.segmentByteLength(
      input.commandBytes,
      this.initialization.maximumCommandBytes,
      "pending command",
    );
    return await this.withAdmission(transferBytes, async () => {
      const segment = this.ownedSegment(
        input.commandBytes,
        this.initialization.maximumCommandBytes,
        "pending command",
      );
      const result = await this.request(
        ArtifactWorkerRpcKind.AuthorPending,
        encodeAuthorPendingMetadata(input),
        [segment],
      );
      const pending = decodePendingListMetadata(
        result.metadata,
        result.segments,
        this.initialization.maximumPendingTransactions,
      );
      if (pending.length !== 1)
        throw clientError("invalid_response", "author response count is invalid");
      return pending[0]!;
    });
  }

  async querySpreadsheetViewport(
    query: EditableSpreadsheetViewportQuery,
  ): ReturnType<EditableArtifactWorkerKernel["querySpreadsheetViewport"]> {
    if (this.initialization.modality !== "spreadsheet") {
      throw clientError(
        "modality_mismatch",
        "spreadsheet query requires a spreadsheet Worker",
        false,
      );
    }
    const normalized = normalizeViewportQuery(query);
    const queryBytes = encodeSpreadsheetViewportKernelQuery(normalized);
    return await this.withAdmission(queryBytes.byteLength, async () => {
      const result = await this.request(ArtifactWorkerRpcKind.QuerySpreadsheet, undefined, [
        ownedTransferBuffer(queryBytes),
      ]);
      if (result.metadata.byteLength !== 0 || result.segments.length !== 1) {
        throw clientError("invalid_response", "spreadsheet viewport response is malformed");
      }
      return decodeSpreadsheetViewportKernelProjection(result.segments[0]!, normalized);
    });
  }

  async querySpreadsheetMetadata(
    query: EditableSpreadsheetMetadataQuery = {},
  ): ReturnType<EditableArtifactWorkerKernel["querySpreadsheetMetadata"]> {
    if (this.initialization.modality !== "spreadsheet") {
      throw clientError(
        "modality_mismatch",
        "spreadsheet query requires a spreadsheet Worker",
        false,
      );
    }
    const normalized = normalizeMetadataQuery(query);
    const queryBytes = encodeSpreadsheetMetadataKernelQuery(normalized);
    return await this.withAdmission(queryBytes.byteLength, async () => {
      const result = await this.request(ArtifactWorkerRpcKind.QuerySpreadsheet, undefined, [
        ownedTransferBuffer(queryBytes),
      ]);
      if (result.metadata.byteLength !== 0 || result.segments.length !== 1) {
        throw clientError("invalid_response", "spreadsheet metadata response is malformed");
      }
      return decodeSpreadsheetMetadataKernelProjection(result.segments[0]!, normalized);
    });
  }

  async queryDocument(query: EditableDocumentQuery): Promise<EditableDocumentProjection> {
    if (this.initialization.modality !== "document") {
      throw clientError("modality_mismatch", "document query requires a document Worker", false);
    }
    const queryBytes = encodeDocumentArtifactQuery(query);
    return await this.withAdmission(queryBytes.byteLength, async () => {
      const result = await this.request(ArtifactWorkerRpcKind.QuerySpreadsheet, undefined, [
        ownedTransferBuffer(queryBytes),
      ]);
      if (result.metadata.byteLength !== 0 || result.segments.length !== 1) {
        throw clientError("invalid_response", "document projection response is malformed");
      }
      return decodeDocumentArtifactQueryResponse(result.segments[0]!);
    });
  }

  async queryPresentation(
    query: EditablePresentationQuery,
  ): Promise<EditablePresentationProjection> {
    if (this.initialization.modality !== "presentation") {
      throw clientError(
        "modality_mismatch",
        "presentation query requires a presentation Worker",
        false,
      );
    }
    const queryBytes = encodePresentationArtifactQuery(query);
    return await this.withAdmission(queryBytes.byteLength, async () => {
      const result = await this.request(ArtifactWorkerRpcKind.QuerySpreadsheet, undefined, [
        ownedTransferBuffer(queryBytes),
      ]);
      if (result.metadata.byteLength !== 0 || result.segments.length !== 1) {
        throw clientError("invalid_response", "presentation projection response is malformed");
      }
      if (result.segments[0]!.byteLength > query.maxBytes) {
        throw clientError(
          "invalid_response",
          "presentation projection exceeds its requested bound",
        );
      }
      const response = decodePresentationArtifactQueryResponse(result.segments[0]!);
      assertPresentationProjectionMatchesQuery(query, response);
      return response;
    });
  }

  async queryPresentationSlideCatalog(
    query: EditablePresentationSlideCatalogQuery,
  ): Promise<EditablePresentationSlideCatalogProjection> {
    const response = await this.queryPresentation(query);
    if (response.kind !== "slide-catalog") {
      throw clientError("invalid_response", "presentation slide catalog response is malformed");
    }
    return response;
  }

  async queryPresentationEditorSlide(
    query: EditablePresentationEditorSlideQuery,
  ): Promise<EditablePresentationEditorSlideProjection> {
    const response = await this.queryPresentation(query);
    if (response.kind !== "editor-slide") {
      throw clientError("invalid_response", "presentation editor slide response is malformed");
    }
    return response;
  }

  restart(): void {
    if (this.disposed) throw clientError("disposed", "artifact Worker client is disposed");
    this.retire(
      this.active,
      clientError("worker_restarted", "artifact Worker generation was retired", true),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    if (active?.initialized && this.active === active) {
      await this.requestOn(
        active,
        ArtifactWorkerRpcKind.Dispose,
        undefined,
        undefined,
        1_000,
      ).catch(() => {});
    }
    this.retire(active, clientError("disposed", "artifact Worker client is disposed"));
  }

  private async request(
    kind: ArtifactWorkerRpcKind,
    metadata?: Uint8Array,
    segments?: ArrayBuffer[],
  ): Promise<RpcResult> {
    const active = await this.ensureActive();
    return await this.requestOn(active, kind, metadata, segments, this.requestTimeoutMs);
  }

  private async ensureActive(): Promise<WorkerGeneration> {
    if (this.disposed) throw clientError("disposed", "artifact Worker client is disposed");
    if (!this.active) this.spawn();
    const active = this.active!;
    await active.ready;
    if (this.active !== active) return await this.ensureActive();
    return active;
  }

  private spawn(): void {
    this.generationCounter += 1;
    if (this.generationCounter > 0xffffffff) {
      throw clientError("generation_exhausted", "artifact Worker generation space is exhausted");
    }
    const endpoint = this.workerFactory(this.workerUrl, {
      type: "module",
      name: `opengeni-artifact-${this.generationCounter}`,
    });
    const active: WorkerGeneration = {
      endpoint,
      generation: this.generationCounter,
      nextRequestId: 1,
      pending: new Map(),
      ready: Promise.resolve(),
      initialized: false,
      onMessage: () => {},
      onError: () => {},
    };
    active.onMessage = (event) => this.receive(active, event);
    active.onError = (event) => {
      this.retire(
        active,
        clientError(
          "worker_crashed",
          event.message || "artifact Worker crashed",
          true,
          event.error,
        ),
      );
    };
    endpoint.addEventListener("message", active.onMessage);
    endpoint.addEventListener("error", active.onError);
    endpoint.addEventListener("messageerror", active.onError);
    this.active = active;
    active.ready = this.requestOn(
      active,
      ArtifactWorkerRpcKind.Initialize,
      encodeInitialize(this.initialization),
      undefined,
      this.initializationTimeoutMs,
    )
      .then((result) => {
        requireEmptyResult(result, "initialize");
        active.initialized = true;
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof Error
            ? error
            : clientError("initialization_failed", "artifact Worker initialization failed", true);
        this.retire(active, failure);
        throw failure;
      });
    active.ready.catch(() => {});
  }

  private requestOn(
    active: WorkerGeneration,
    kind: ArtifactWorkerRpcKind,
    metadata: Uint8Array | undefined,
    segments: ArrayBuffer[] | undefined,
    timeoutMs: number,
  ): Promise<RpcResult> {
    if (this.active !== active) {
      return Promise.reject(
        clientError("stale_generation", "artifact Worker generation is retired", true),
      );
    }
    const requestId = nextRequestId(active);
    const message = encodeArtifactWorkerRpcMessage({
      kind,
      generation: active.generation,
      requestId,
      ...(metadata ? { metadata } : {}),
      ...(segments ? { segments } : {}),
      limits: this.rpcLimits,
    });
    return new Promise<RpcResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!active.pending.has(requestId)) return;
        this.sendCancel(active, requestId);
        this.retire(
          active,
          clientError("worker_timeout", `artifact Worker request exceeded ${timeoutMs}ms`, true),
        );
      }, timeoutMs);
      active.pending.set(requestId, { resolve, reject, timeout });
      try {
        active.endpoint.postMessage(message, transferListForArtifactWorkerRpcMessage(message));
      } catch (error) {
        clearTimeout(timeout);
        active.pending.delete(requestId);
        const failure = clientError(
          "post_failed",
          "failed to post artifact Worker request",
          true,
          error,
        );
        reject(failure);
        this.retire(active, failure);
      }
    });
  }

  private receive(active: WorkerGeneration, event: ArtifactWorkerClientMessageEvent): void {
    if (this.active !== active) return;
    let frame;
    try {
      frame = decodeArtifactWorkerRpcMessage(event.data, this.rpcLimits);
    } catch (error) {
      this.retire(
        active,
        clientError("invalid_response", "artifact Worker sent an invalid frame", true, error),
      );
      return;
    }
    if (frame.generation !== active.generation) {
      this.retire(
        active,
        clientError("invalid_response", "artifact Worker response generation is invalid", true),
      );
      return;
    }
    if (
      frame.flags !== 0 ||
      (frame.kind !== ArtifactWorkerRpcKind.Response && frame.kind !== ArtifactWorkerRpcKind.Error)
    ) {
      this.retire(
        active,
        clientError("invalid_response", "artifact Worker sent an unexpected frame", true),
      );
      return;
    }
    const pending = active.pending.get(frame.requestId);
    if (!pending) return;
    active.pending.delete(frame.requestId);
    clearTimeout(pending.timeout);
    if (frame.kind === ArtifactWorkerRpcKind.Error) {
      if (frame.segments.length !== 0) {
        pending.reject(clientError("invalid_response", "artifact Worker error has segments", true));
        return;
      }
      try {
        const error = decodeErrorPayload(frame.metadata);
        pending.reject(
          new ArtifactWorkerClientError(error.code, error.message, { retryable: error.retryable }),
        );
      } catch (decodeError) {
        pending.reject(
          clientError("invalid_response", "artifact Worker error is malformed", true, decodeError),
        );
      }
      return;
    }
    pending.resolve({ metadata: frame.metadata, segments: frame.segments });
  }

  private sendCancel(active: WorkerGeneration, requestId: number): void {
    if (this.active !== active) return;
    try {
      const message = encodeArtifactWorkerRpcMessage({
        kind: ArtifactWorkerRpcKind.Cancel,
        generation: active.generation,
        requestId,
        limits: this.rpcLimits,
      });
      active.endpoint.postMessage(message, transferListForArtifactWorkerRpcMessage(message));
    } catch {
      // The watchdog immediately terminates the generation; cancel is best-effort.
    }
  }

  private retire(active: WorkerGeneration | null, error: Error): void {
    if (!active || this.active !== active) return;
    this.active = null;
    active.endpoint.removeEventListener("message", active.onMessage);
    active.endpoint.removeEventListener("error", active.onError);
    active.endpoint.removeEventListener("messageerror", active.onError);
    active.endpoint.terminate();
    for (const request of active.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    active.pending.clear();
  }

  private pendingSegments(
    transactions: readonly EditableArtifactPendingTransaction[],
    committedTransaction?: Uint8Array,
  ): ArrayBuffer[] {
    const segments: ArrayBuffer[] = [];
    if (committedTransaction) {
      const segment = this.ownedSegment(
        committedTransaction,
        this.initialization.maximumCommittedTransactionBytes,
        "committed transaction",
      );
      segments.push(segment);
    }
    for (const transaction of transactions) {
      const command = this.ownedSegment(
        transaction.commandBytes,
        this.initialization.maximumCommandBytes,
        "pending command",
      );
      const intent = this.ownedSegment(
        transaction.intentBytes,
        EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
        "pending intent",
      );
      segments.push(command, intent);
    }
    return segments;
  }

  private measurePendingTransfer(
    transactions: readonly EditableArtifactPendingTransaction[],
    committedTransaction?: Uint8Array,
  ): number {
    if (
      !Array.isArray(transactions) ||
      transactions.length > this.initialization.maximumPendingTransactions
    ) {
      throw clientError("limit_exceeded", "pending transaction count exceeds its limit");
    }
    let pendingBytes = 0;
    for (const transaction of transactions) {
      const commandBytes = this.segmentByteLength(
        transaction.commandBytes,
        this.initialization.maximumCommandBytes,
        "pending command",
      );
      const intentBytes = this.segmentByteLength(
        transaction.intentBytes,
        EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
        "pending intent",
      );
      pendingBytes += commandBytes + intentBytes;
      if (!Number.isSafeInteger(pendingBytes) || pendingBytes > this.maximumPendingAggregateBytes) {
        throw clientError("limit_exceeded", "pending transfer exceeds its aggregate byte limit");
      }
    }
    const committedBytes =
      committedTransaction === undefined
        ? 0
        : this.segmentByteLength(
            committedTransaction,
            this.initialization.maximumCommittedTransactionBytes,
            "committed transaction",
          );
    return pendingBytes + committedBytes;
  }

  private async withAdmission<T>(transferBytes: number, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw clientError("disposed", "artifact Worker client is disposed");
    if (
      this.admittedRequests >= MAX_CLIENT_QUEUED_REQUESTS ||
      !Number.isSafeInteger(this.admittedTransferBytes + transferBytes) ||
      this.admittedTransferBytes + transferBytes > this.maximumQueuedTransferBytes
    ) {
      throw clientError(
        "client_busy",
        "artifact Worker request queue exceeds its bounded capacity",
        true,
      );
    }
    this.admittedRequests += 1;
    this.admittedTransferBytes += transferBytes;
    try {
      return await operation();
    } finally {
      this.admittedRequests -= 1;
      this.admittedTransferBytes -= transferBytes;
    }
  }

  private segmentByteLength(bytes: Uint8Array, maximumBytes: number, label: string): number {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw clientError("invalid_bytes", `${label} must be non-empty bytes`);
    }
    if (bytes.byteLength > maximumBytes) {
      throw clientError("limit_exceeded", `${label} exceeds its byte limit`);
    }
    return bytes.byteLength;
  }

  private ownedSegment(bytes: Uint8Array, maximumBytes: number, label: string): ArrayBuffer {
    this.segmentByteLength(bytes, maximumBytes, label);
    return ownedTransferBuffer(bytes);
  }
}

function nextRequestId(active: WorkerGeneration): number {
  for (let attempts = 0; attempts < 0xffffffff; attempts += 1) {
    const candidate = active.nextRequestId;
    active.nextRequestId = candidate === 0xffffffff ? 1 : candidate + 1;
    if (!active.pending.has(candidate)) return candidate;
  }
  throw clientError("request_exhausted", "artifact Worker request id space is exhausted");
}

function requireEmptyResult(result: RpcResult, label: string): void {
  if (result.metadata.byteLength !== 0 || result.segments.length !== 0) {
    throw clientError("invalid_response", `${label} response must be empty`);
  }
}

function canonicalUrl(input: string | URL, label: string): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (error) {
    throw clientError("invalid_asset_url", `${label} must be an absolute URL`, false, error);
  }
  if (url.username || url.password || url.hash) {
    throw clientError("invalid_asset_url", `${label} must not contain credentials or a fragment`);
  }
  return url;
}

function validateAssetPolicy(
  urls: readonly URL[],
  applicationOrigin: string | null,
  configuredOrigins: readonly string[],
  allowInsecureDevelopmentAssets: boolean,
): void {
  const allowedOrigins = new Set<string>();
  if (applicationOrigin !== null) allowedOrigins.add(applicationOrigin);
  for (const originInput of configuredOrigins) {
    const origin = canonicalUrl(originInput, "allowedAssetOrigins entry").origin;
    allowedOrigins.add(origin);
  }
  for (const url of urls) {
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "file:") {
      throw clientError("invalid_asset_url", `unsupported artifact asset scheme: ${url.protocol}`);
    }
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback);
    if (!secure && !allowInsecureDevelopmentAssets) {
      throw clientError(
        "insecure_asset_url",
        "artifact Worker assets must use HTTPS (loopback HTTP allowed)",
      );
    }
    if (!allowedOrigins.has(url.origin)) {
      throw clientError(
        "untrusted_asset_origin",
        `artifact Worker asset origin is not allowed: ${url.origin}`,
      );
    }
  }
}

function resolveApplicationOrigin(input: string | URL | undefined): string | null {
  if (input !== undefined) return canonicalUrl(input, "applicationOrigin").origin;
  const location = globalThis.location;
  if (location && typeof location.origin === "string" && location.origin !== "null") {
    return canonicalUrl(location.origin, "application origin").origin;
  }
  return null;
}

function boundedMaximum(value: number, hardMaximum: number, label: string): number {
  positiveSafeInteger(value, label);
  if (value > hardMaximum)
    throw clientError("invalid_limit", `${label} exceeds its hard safety ceiling`);
  return value;
}

function normalizeClientRpcLimits(
  input: Readonly<ArtifactWorkerRpcLimits>,
): Readonly<ArtifactWorkerRpcLimits> {
  const values = {
    maxMetadataBytes: positiveSafeInteger(input.maxMetadataBytes, "rpcLimits.maxMetadataBytes"),
    maxSegmentBytes: positiveSafeInteger(input.maxSegmentBytes, "rpcLimits.maxSegmentBytes"),
    maxTotalSegmentBytes: positiveSafeInteger(
      input.maxTotalSegmentBytes,
      "rpcLimits.maxTotalSegmentBytes",
    ),
    maxSegments: positiveSafeInteger(input.maxSegments, "rpcLimits.maxSegments"),
  };
  for (const key of Object.keys(values) as Array<keyof ArtifactWorkerRpcLimits>) {
    if (values[key] > DEFAULT_ARTIFACT_WORKER_RPC_LIMITS[key]) {
      throw clientError(
        "invalid_limit",
        `rpcLimits.${key} exceeds the dedicated Worker hard limit`,
      );
    }
  }
  return Object.freeze(values);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw clientError("invalid_number", `${label} must be a positive safe integer`);
  }
  return value;
}

function positiveVersion(value: number, label: string): number {
  const version = positiveSafeInteger(value, label);
  if (version > 65_535) throw clientError("invalid_number", `${label} exceeds uint16`);
  return version;
}

function boundedVersion(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > 512
  ) {
    throw clientError("invalid_runtime_identity", `${label} is malformed`);
  }
  return value;
}

function normalizeViewportQuery(
  query: EditableSpreadsheetViewportQuery,
): SpreadsheetArtifactViewportQuery {
  if (!query || typeof query !== "object") {
    throw clientError("invalid_query", "spreadsheet viewport query must be an object");
  }
  const sheetId = spreadsheetSheetId(requireStableId(query.sheetId, "query.sheetId"));
  const startRow = uint32(query.startRow, "query.startRow");
  const startColumn = uint32(query.startColumn, "query.startColumn");
  const rowCount = positiveUint32(query.rowCount, "query.rowCount");
  const columnCount = positiveUint32(query.columnCount, "query.columnCount");
  if (startRow + rowCount - 1 > UINT32_MAX || startColumn + columnCount - 1 > UINT32_MAX) {
    throw clientError("invalid_query", "spreadsheet viewport exceeds uint32 coordinates");
  }
  const area = rowCount * columnCount;
  if (!Number.isSafeInteger(area) || area > MAX_VIEWPORT_AREA) {
    throw clientError("limit_exceeded", `spreadsheet viewport exceeds ${MAX_VIEWPORT_AREA} cells`);
  }
  const maxCells = positiveUint32(
    query.maxCells ?? SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS,
    "query.maxCells",
  );
  const maxBytes = positiveUint32(
    query.maxBytes ?? SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
    "query.maxBytes",
  );
  if (maxCells > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS) {
    throw clientError("limit_exceeded", "spreadsheet viewport maxCells exceeds its hard bound");
  }
  if (maxBytes > SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES) {
    throw clientError("limit_exceeded", "spreadsheet viewport maxBytes exceeds its hard bound");
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

function normalizeMetadataQuery(
  query: EditableSpreadsheetMetadataQuery,
): Required<EditableSpreadsheetMetadataQuery> {
  if (!query || typeof query !== "object") {
    throw clientError("invalid_query", "spreadsheet metadata query must be an object");
  }
  const maxSheets = positiveUint32(query.maxSheets ?? 4_096, "query.maxSheets");
  const maxBytes = positiveUint32(
    query.maxBytes ?? SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
    "query.maxBytes",
  );
  if (maxSheets > SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS) {
    throw clientError("limit_exceeded", "spreadsheet metadata maxSheets exceeds its hard bound");
  }
  if (maxBytes > SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES) {
    throw clientError("limit_exceeded", "spreadsheet metadata maxBytes exceeds its hard bound");
  }
  return Object.freeze({ maxSheets, maxBytes });
}

function assertPresentationProjectionMatchesQuery(
  query: EditablePresentationQuery,
  response: EditablePresentationProjection,
): void {
  if (query.kind !== response.kind) {
    throw clientError("invalid_response", "presentation projection kind does not match its query");
  }
  if (query.kind === "resolved-slide" && response.kind === "resolved-slide") {
    if (response.slideId !== query.slideId || response.nodes.length > query.maxNodes)
      throw clientError(
        "invalid_response",
        "resolved presentation projection does not match its query",
      );
  } else if (query.kind === "slide-catalog" && response.kind === "slide-catalog") {
    if (
      response.startSlide !== query.startSlide ||
      response.slides.length > query.maxSlides ||
      response.projectedTextBytes > query.maxTextBytes
    )
      throw clientError("invalid_response", "presentation slide catalog does not match its query");
  } else if (query.kind === "editor-slide" && response.kind === "editor-slide") {
    if (
      response.slide.id !== query.slideId ||
      response.nodes.length > query.maxNodes ||
      response.projectedTextBytes > query.maxTextBytes
    )
      throw clientError("invalid_response", "presentation editor slide does not match its query");
  } else if (
    (query.kind === "viewport" || query.kind === "hit-test") &&
    (response.kind === "viewport" || response.kind === "hit-test") &&
    response.nodes.length > query.maxNodes
  ) {
    throw clientError("invalid_response", "presentation projection exceeds its requested nodes");
  }
}

function uint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw clientError("invalid_query", `${label} must be a uint32`);
  }
  return value;
}

function positiveUint32(value: number, label: string): number {
  const output = uint32(value, label);
  if (output === 0) throw clientError("invalid_query", `${label} must be positive`);
  return output;
}

function requireStableId(value: string, label: string): string {
  if (!/^[0-9a-f]{32}$/u.test(value) || /^0+$/u.test(value)) {
    throw clientError(
      "invalid_query",
      `${label} must be nonzero fixed-width lowercase hexadecimal text`,
    );
  }
  return value;
}

function requireModality(value: unknown): EditableArtifactModality {
  if (value !== "document" && value !== "spreadsheet" && value !== "presentation") {
    throw clientError("invalid_modality", "artifact modality is invalid");
  }
  return value;
}

function defaultWorkerFactory(
  url: URL,
  options: { type: "module"; name: string },
): ArtifactWorkerClientEndpoint {
  if (typeof globalThis.Worker !== "function") {
    throw clientError(
      "worker_unavailable",
      "browser artifact Worker is unavailable in this SSR/runtime environment",
    );
  }
  return new globalThis.Worker(url, options) as unknown as ArtifactWorkerClientEndpoint;
}

function clientError(
  code: string,
  message: string,
  retryable = false,
  cause?: unknown,
): ArtifactWorkerClientError {
  return new ArtifactWorkerClientError(code, message, {
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}
