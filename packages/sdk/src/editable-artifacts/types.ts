/** Opaque artifact identity. Workspace authority is carried by the ticket. */
export type EditableArtifactId = string;

export type EditableArtifactModality = "document" | "spreadsheet" | "presentation";
export type EditableArtifactSerializedModality = Exclude<EditableArtifactModality, "spreadsheet">;

export type EditableArtifactCausalEntry = Readonly<{
  replicaId: string;
  counter: number;
}>;

/** Sorted by replicaId, duplicate-free. */
export type EditableArtifactCausalFrontier = readonly EditableArtifactCausalEntry[];

/**
 * Short-lived, artifact-scoped credential minted over authenticated HTTP.
 * Implementations must never put a durable bearer token in a socket URL.
 */
export type EditableArtifactSyncTicket = {
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  replicaId: string;
  token: string;
  expiresAt: string;
  protocolVersion: number;
};

/** Immutable, server-verified canonical state. */
type EditableArtifactSnapshotCommon = {
  artifactId: EditableArtifactId;
  sequence: number;
  stateHash: string;
  digest: string;
  kernelVersion: string;
  modelSchemaVersion: number;
  bytes: Uint8Array;
};

export type EditableArtifactSpreadsheetSnapshot = EditableArtifactSnapshotCommon & {
  modality: "spreadsheet";
  causalFrontier: EditableArtifactCausalFrontier;
  protocolVersion: number;
};

export type EditableArtifactSerializedSnapshot = EditableArtifactSnapshotCommon & {
  modality: EditableArtifactSerializedModality;
  nativeRevision: number;
};

export type EditableArtifactSnapshot =
  | EditableArtifactSpreadsheetSnapshot
  | EditableArtifactSerializedSnapshot;

/** One authoritative, atomically committed artifact transaction. */
type EditableArtifactCommittedTransactionCommon = {
  artifactId: EditableArtifactId;
  transactionId: string;
  requestHash: string;
  startSequence: number;
  endSequence: number;
  priorStateHash: string;
  stateHash: string;
  committedTransactionBytes: Uint8Array;
};

export type EditableArtifactSpreadsheetCommittedTransaction =
  EditableArtifactCommittedTransactionCommon & {
    modality: "spreadsheet";
    causalFrontier: EditableArtifactCausalFrontier;
    protocolVersion: number;
    /** Exact whole canonical OGACO committed-transaction envelope. */
    committedTransactionBytes: Uint8Array;
  };

export type EditableArtifactSerializedCommittedTransaction =
  EditableArtifactCommittedTransactionCommon & {
    modality: EditableArtifactSerializedModality;
    priorNativeRevision: number;
    nativeRevision: number;
    commitProtocolVersion: number;
    /** Exact whole canonical OGAST committed-transaction envelope. */
    committedTransactionBytes: Uint8Array;
  };

export type EditableArtifactCommittedTransaction =
  | EditableArtifactSpreadsheetCommittedTransaction
  | EditableArtifactSerializedCommittedTransaction;

/** A locally durable command batch. Retried with exactly the same identity. */
type EditableArtifactPendingTransactionCommon = {
  artifactId: EditableArtifactId;
  /** Caller-authored portable OGATX client transaction identity. */
  clientTransactionId: string;
  requestHash: string;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandVersion: number;
  replicaId: string;
  /** Monotonic within one persisted replica epoch; never changed on retry. */
  replicaCounter: number;
  /** Symbolic predecessor resolved by the server to that transaction's causal stamp. */
  previousLocalTransactionId: string | null;
  observedHeadSequence: number;
  commandBytes: Uint8Array;
  /** Exact OGATX001 bytes persisted and retried byte-identically. */
  intentBytes: Uint8Array;
  createdAt: number;
};

export type EditableArtifactSpreadsheetPendingTransaction =
  EditableArtifactPendingTransactionCommon & {
    modality: "spreadsheet";
    causalBase: EditableArtifactCausalFrontier;
    selectiveUndoTargets: readonly string[];
  };

export type EditableArtifactSerializedPendingTransaction =
  EditableArtifactPendingTransactionCommon & {
    modality: EditableArtifactSerializedModality;
    /** Local proof that the strictly serialized command was authored over this native revision. */
    observedNativeRevision: number;
  };

export type EditableArtifactPendingTransaction =
  | EditableArtifactSpreadsheetPendingTransaction
  | EditableArtifactSerializedPendingTransaction;

export type EditableArtifactBlockedPending = Readonly<{
  clientTransactionId: string;
  code: string;
}>;

/** A bounded, sparse spreadsheet viewport requested from the Worker-owned kernel. */
export type EditableSpreadsheetViewportQuery = Readonly<{
  sheetId: string;
  startRow: number;
  startColumn: number;
  rowCount: number;
  columnCount: number;
  /** Hard-clamped by the Worker/kernel; never permits a partial response. */
  maxCells?: number;
  /** Hard-clamped by the Worker/kernel; never permits a partial response. */
  maxBytes?: number;
}>;

export type EditableSpreadsheetFormulaError =
  | "null"
  | "divide_by_zero"
  | "value"
  | "reference"
  | "name"
  | "number"
  | "not_available"
  | "spill"
  | "calculation"
  | Readonly<{ custom: string }>;

export type EditableSpreadsheetCellValue =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "number"; value: number }>
  /** Canonical `Date.prototype.toISOString()` output; never a numeric serial. */
  | Readonly<{ kind: "date"; value: string }>
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "error"; value: EditableSpreadsheetFormulaError }>;

export type EditableSpreadsheetProjectedCell = Readonly<{
  row: number;
  column: number;
  formula: string | null;
  value: EditableSpreadsheetCellValue;
}>;

/**
 * Immutable projection of one exact speculative kernel revision. Cells are
 * sparse, strictly row-major, unique, and all inside the requested rectangle.
 */
export type EditableSpreadsheetViewportProjection = Readonly<{
  revision: bigint;
  sheetId: string;
  /** Creation operation that pins the live CRDT generation, if collaborative. */
  generationId: string | null;
  startRow: number;
  startColumn: number;
  rowCount: number;
  columnCount: number;
  cells: readonly EditableSpreadsheetProjectedCell[];
}>;

export type EditableSpreadsheetUsedBounds = Readonly<{
  startRow: number;
  startColumn: number;
  /** Inclusive maximum occupied row. */
  endRow: number;
  /** Inclusive maximum occupied column. */
  endColumn: number;
}>;

export type EditableSpreadsheetSheetMetadata = Readonly<{
  sheetId: string;
  generationId: string | null;
  name: string;
  usedBounds: EditableSpreadsheetUsedBounds | null;
}>;

/**
 * Bounded workbook catalog from the Worker-owned kernel. False feature flags
 * mean the kernel does not model that feature; the SDK never invents authority.
 */
export type EditableSpreadsheetMetadataProjection = Readonly<{
  revision: bigint;
  modeledFeatures: Readonly<{
    dimensions: boolean;
    hidden: boolean;
    merges: boolean;
  }>;
  sheets: readonly EditableSpreadsheetSheetMetadata[];
}>;

export type EditableSpreadsheetMetadataQuery = Readonly<{
  maxSheets?: number;
  maxBytes?: number;
}>;

export type EditableArtifactStoredReplica = {
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  /** Last immutable server snapshot loaded and verified by the kernel. */
  snapshot: EditableArtifactSnapshot;
  /** Contiguous committed tail needed to reconstruct `cursor` after reload. */
  tail: EditableArtifactCommittedTransaction[];
  cursor: number;
  stateHash: string;
  updatedAt: number;
};

type EditableArtifactBootstrapCommon = {
  artifactId: EditableArtifactId;
  protocolVersion: number;
  headSequence: number;
  headStateHash: string;
  kernelVersion: string;
  modelSchemaVersion: number;
  writable: boolean;
  /** Earliest sequence still available through replay, inclusive. */
  minimumReplaySequence: number;
  /** Supplied for first load, requested resync, or a newer compact snapshot. */
  snapshot: EditableArtifactSnapshot | null;
  /** Server has expired this replica's history and requires a fresh snapshot. */
  resyncRequired: boolean;
};

export type EditableArtifactBootstrap = EditableArtifactBootstrapCommon &
  (
    | {
        modality: "spreadsheet";
        headCausalFrontier: EditableArtifactCausalFrontier;
      }
    | {
        modality: EditableArtifactSerializedModality;
        headNativeRevision: number;
      }
  );

export type EditableArtifactReplayPage = {
  artifactId: EditableArtifactId;
  transactions: EditableArtifactCommittedTransaction[];
  headSequence: number;
};

export type EditableArtifactSubmitReceipt = {
  artifactId: EditableArtifactId;
  /** Exact OGATX client identity acknowledged by the authority. */
  clientTransactionId: string;
  /** Authoritative OGACO (spreadsheet) or OGAST (document/presentation) transaction identity. */
  transactionId: string;
  requestHash: string;
  committed: EditableArtifactCommittedTransaction;
};

export type EditableArtifactLiveMessage =
  | {
      type: "transaction.committed";
      transaction: EditableArtifactCommittedTransaction;
    }
  | {
      type: "head";
      artifactId: EditableArtifactId;
      headSequence: number;
    }
  | {
      type: "authorization";
      artifactId: EditableArtifactId;
      writable: boolean;
    }
  | {
      type: "resync_required";
      artifactId: EditableArtifactId;
      reason: string;
    };

export type EditableArtifactLiveClose = {
  reason: "closed" | "ticket_expired" | "transport_error" | "permission_changed";
  error?: unknown;
};

/** Exact limits advertised by the authenticated OGALV stream epoch. */
export type EditableArtifactLiveLimits = Readonly<{
  maxClientFrameBytes: number;
  maxCommandBytes: number;
  maxIntentBytes: number;
  maxCommittedTransactionBytes: number;
  maxSnapshotBytes: number;
  maxInFlightTransactions: number;
  maxInFlightBytes: number;
}>;

export type EditableArtifactLiveConnection = {
  /** Opaque server session binding subscription, retention lease, and bootstrap. */
  streamEpoch: string;
  limits: EditableArtifactLiveLimits;
  readBootstrap: (input: {
    localCursor: number | null;
    localStateHash: string | null;
    resume:
      | {
          modality: "spreadsheet";
          localCausalFrontier: EditableArtifactCausalFrontier;
        }
      | {
          modality: EditableArtifactSerializedModality;
          localNativeRevision: number | null;
        };
    requireSnapshot: boolean;
    signal: AbortSignal;
  }) => Promise<EditableArtifactBootstrap>;
  replay: (input: {
    after: number;
    through: number;
    limit: number;
    signal: AbortSignal;
  }) => Promise<EditableArtifactReplayPage>;
  submit: (input: {
    transaction: EditableArtifactPendingTransaction;
    signal: AbortSignal;
  }) => Promise<EditableArtifactSubmitReceipt>;
  acknowledge: (input: {
    sequence: number;
    stateHash: string;
    signal: AbortSignal;
  }) => Promise<void>;
  /** Resolves once for every local or remote close. */
  closed: Promise<EditableArtifactLiveClose>;
  close: (reason?: string) => void;
};

/** HTTP/WebSocket details live behind this boundary. */
export type EditableArtifactSyncTransport = {
  mintTicket: (input: {
    artifactId: EditableArtifactId;
    replicaId: string;
    signal: AbortSignal;
  }) => Promise<EditableArtifactSyncTicket>;
  /** Must subscribe before returning; bootstrap is read only after this call. */
  openLive: (input: {
    ticket: EditableArtifactSyncTicket;
    after: number;
    stateHash: string | null;
    resume:
      | {
          modality: "spreadsheet";
          causalFrontier: EditableArtifactCausalFrontier;
        }
      | {
          modality: EditableArtifactSerializedModality;
          nativeRevision: number | null;
        };
    requireSnapshot: boolean;
    signal: AbortSignal;
    onMessage: (message: EditableArtifactLiveMessage) => void;
  }) => Promise<EditableArtifactLiveConnection>;
};

/**
 * Implemented by a dedicated browser Worker around the WASM kernel. The
 * controller never mutates artifact state on the UI thread.
 */
export type EditableArtifactWorkerKernel = {
  reset: () => Promise<void>;
  /** Computes the digest over owned bytes inside the Worker. */
  loadSnapshot: (
    snapshot: EditableArtifactSnapshot,
  ) => Promise<{ stateHash: string; digest: string }>;
  /** Rebuild-only path used before bootstrap exposes a visible revision. */
  applyRecovered: (
    transaction: EditableArtifactCommittedTransaction,
  ) => Promise<{ stateHash: string }>;
  /** Atomically commits confirmed state and publishes the rebased speculative layer. */
  reconcileCommitted: (
    transaction: EditableArtifactCommittedTransaction,
    remainingPending: readonly EditableArtifactPendingTransaction[],
  ) => Promise<{ stateHash: string; blockedPending: readonly EditableArtifactBlockedPending[] }>;
  /** Rebuilds the speculative layer without changing confirmed authority. */
  replacePending: (
    transactions: readonly EditableArtifactPendingTransaction[],
  ) => Promise<{ blockedPending: readonly EditableArtifactBlockedPending[] }>;
  /** Canonical encoding + request hashing occurs off the UI thread. */
  authorPending: (input: {
    modality: EditableArtifactModality;
    protocolVersion: number;
    kernelVersion: string;
    modelSchemaVersion: number;
    commandVersion: number;
    artifactId: EditableArtifactId;
    clientTransactionId: string;
    replicaId: string;
    replicaCounter: number;
    previousLocalTransactionId: string | null;
    observedHeadSequence: number;
    causalBase?: EditableArtifactCausalFrontier;
    selectiveUndoTargets?: readonly string[];
    commandBytes: Uint8Array;
    createdAt: number;
  }) => Promise<EditableArtifactPendingTransaction>;
  /** Runs against the speculative fork; canonical state remains Worker-only. */
  querySpreadsheetViewport: (
    query: EditableSpreadsheetViewportQuery,
  ) => Promise<EditableSpreadsheetViewportProjection>;
  querySpreadsheetMetadata: (
    query?: EditableSpreadsheetMetadataQuery,
  ) => Promise<EditableSpreadsheetMetadataProjection>;
  /** Canonical, bounded document projection produced by the real Worker WASM session. */
  queryDocument: (query: DocumentArtifactQuery) => Promise<DocumentArtifactProjection>;
  /** Canonical, bounded presentation projection produced by the real Worker WASM session. */
  queryPresentation: (
    query: PresentationArtifactQuery,
  ) => Promise<PresentationArtifactQueryResponse>;
};

export type EditableDocumentQuery = DocumentArtifactQuery;
export type EditableDocumentProjection = DocumentArtifactProjection;
export type EditablePresentationQuery = PresentationArtifactQuery;
export type EditablePresentationProjection = PresentationArtifactQueryResponse;
export type EditablePresentationSlideCatalogQuery = Extract<
  PresentationArtifactQuery,
  { kind: "slide-catalog" }
>;
export type EditablePresentationEditorSlideQuery = Extract<
  PresentationArtifactQuery,
  { kind: "editor-slide" }
>;
export type EditablePresentationSlideCatalogProjection = Extract<
  PresentationArtifactQueryResponse,
  { kind: "slide-catalog" }
>;
export type EditablePresentationEditorSlideProjection = Extract<
  PresentationArtifactQueryResponse,
  { kind: "editor-slide" }
>;

export type EditableArtifactSyncState =
  | "idle"
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "resyncing"
  | "unsupported"
  | "failed"
  | "closed";

export type EditableArtifactSyncView = {
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  state: EditableArtifactSyncState;
  cursor: number;
  headSequence: number;
  writable: boolean;
  pendingTransactions: number;
  blockedPending: readonly EditableArtifactBlockedPending[];
  queuedMessages: number;
  reconnectAttempt: number;
  lastError: Error | null;
};

export type EditableArtifactSyncListener = (view: EditableArtifactSyncView) => void;

export type EditableArtifactSyncScheduler = {
  now: () => number;
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
};
import type {
  DocumentArtifactProjection,
  DocumentArtifactQuery,
} from "@opengeni/contracts/document-artifact-query";
import type {
  PresentationArtifactQuery,
  PresentationArtifactQueryResponse,
} from "@opengeni/contracts/presentation-artifact-query";
