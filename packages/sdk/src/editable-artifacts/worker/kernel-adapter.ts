import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
} from "@opengeni/contracts/editable-artifacts";
import { MAX_COMMITTED_TRANSACTION_BYTES } from "@opengeni/contracts/editable-artifact-committed-transaction";
import type { ArtifactWorkerInitializeInput } from "./wire-codec";
import type { EditableArtifactModality } from "../types";
import { ArtifactWorkerProtocolError } from "./rpc-protocol";

export type ArtifactWorkerKernelSession = {
  readonly modality: EditableArtifactModality;
  /** Replays one exact whole canonical OGACO001 transaction. */
  applyCommitted: (committedTransactionBytes: Uint8Array) => void;
  /** Authors and applies one exact OGATX001 intent over the current frontier. */
  applyPending: (intentBytes: Uint8Array) => void;
  /** Applies one exact document/presentation command and returns its native receipt. */
  applyCommands: (commandBytes: Uint8Array) => Uint8Array;
  /** Native serialized-model revision; unavailable for spreadsheets. */
  nativeRevision: () => number;
  /** Stages an atomic candidate without serializing/reopening the model. */
  fork: () => ArtifactWorkerKernelSession;
  /** Kernel-defined canonical hash; never synthesized from transport bytes. */
  stateHash: () => Promise<string>;
  snapshot: () => Uint8Array;
  /** Canonical bounded OGAKQ request to canonical OGAKV projection. */
  query: (queryBytes: Uint8Array) => Uint8Array;
  dispose: () => void;
};

/** A valid local intent whose structural preconditions no longer project. */
export class ArtifactWorkerPendingProjectionError extends Error {
  readonly code: string;

  constructor(code: string, message = "pending transaction cannot project over confirmed state") {
    super(message);
    this.name = "ArtifactWorkerPendingProjectionError";
    this.code = requireErrorCode(code, "pending projection code");
  }
}

/** Entirely Worker-owned adapter over one compatible collaboration WASM build. */
export type ArtifactWorkerKernelAdapter = {
  readonly modality: EditableArtifactModality;
  readonly protocolVersion: number;
  readonly kernelVersion: string;
  readonly modelSchemaVersion: number;
  readonly commandVersion: number;
  readonly maximumSnapshotBytes: number;
  readonly maximumCommandBytes: number;
  readonly maximumIntentBytes: number;
  readonly maximumCommittedTransactionBytes: number;
  readonly maximumQueryBytes: number;
  readonly maximumQueryResponseBytes: number;
  canonicalizeSnapshot: (snapshotBytes: Uint8Array) => Uint8Array;
  open: (snapshotBytes: Uint8Array) => ArtifactWorkerKernelSession;
  dispose?: () => void;
};

export type ArtifactWorkerKernelAdapterFactory = (
  input: ArtifactWorkerInitializeInput,
) => Promise<ArtifactWorkerKernelAdapter>;

type WasmCollaborationSession = {
  authorTransaction: (intentBytes: Uint8Array, resolvedBaseBytes: Uint8Array) => Uint8Array;
  applyCommitted: (committedTransactionBytes: Uint8Array) => void;
  snapshot: () => Uint8Array;
  frontier: () => Uint8Array;
  fork: () => WasmCollaborationSession;
  stateHash: () => string;
  revision: () => bigint;
  query: (queryEnvelope: Uint8Array) => Uint8Array;
  isClosed?: () => boolean;
  close?: () => void;
  dispose?: () => void;
  free?: () => void;
};

type WasmModalitySession = {
  applyCommands: (commandBytes: Uint8Array) => Uint8Array;
  snapshot: () => Uint8Array;
  revision: () => bigint;
  fork: () => WasmModalitySession;
  stateHash: () => string;
  query: (queryEnvelope: Uint8Array) => Uint8Array;
  isClosed?: () => boolean;
  close?: () => void;
  dispose?: () => void;
  free?: () => void;
};

type WasmKernelModuleBase = {
  default?: (input: { module_or_path: string | URL }) => Promise<unknown>;
  capabilities: () => Uint8Array;
  buildIdentity: () => Uint8Array;
};

type WasmKernelModule =
  | (WasmKernelModuleBase &
      Readonly<{
        modality: "spreadsheet";
        canonicalizeSnapshot: (snapshotBytes: Uint8Array) => Uint8Array;
        open: (snapshotBytes: Uint8Array) => WasmCollaborationSession;
      }>)
  | (WasmKernelModuleBase &
      Readonly<{
        modality: "document" | "presentation";
        canonicalizeSnapshot: (snapshotBytes: Uint8Array) => Uint8Array;
        open: (snapshotBytes: Uint8Array) => WasmModalitySession;
      }>);

type WasmCapabilities = Readonly<{
  abiVersion: number;
  buildIdentityFormat: "utf8";
  canonicalStateHash: "sha256:canonical-snapshot";
  collaboration: boolean;
  collaborationSnapshotVersion: number;
  commandSchemaVersion: number;
  committedTransactionVersion: number;
  document: boolean;
  documentCommandVersion: number;
  documentQueryResponseVersion: number;
  documentQueryVersion: number;
  documentReceiptVersion: number;
  documentSnapshotVersion: number;
  documentStatefulSessions: boolean;
  editableArtifactIntentVersion: number;
  kernelSnapshotVersion: number;
  spreadsheetCommandVersion: number;
  maxCellsPerBatch: number;
  maxCommandBytes: number;
  maxCommands: number;
  maxSnapshotBytes: number;
  maxSpreadsheetCommandBytes: number;
  maxIntentBytes: number;
  maxCommittedTransactionBytes: number;
  maxDocumentCommandBytes: number;
  maxDocumentCommands: number;
  maxDocumentQueryBytes: number;
  maxDocumentQueryResponseBytes: number;
  maxDocumentSnapshotBytes: number;
  maxMetadataScannedCells: number;
  maxQueryBytes: number;
  maxQueryResponseBytes: number;
  maxViewportArea: number;
  maxViewportCells: number;
  maxMetadataSheets: number;
  maxPresentationCommandBytes: number;
  maxPresentationQueryBytes: number;
  maxPresentationResponseBytes: number;
  maxPresentationSnapshotBytes: number;
  maxTextLayoutFontBundleBytes: number;
  maxTextLayoutRequestBytes: number;
  maxTextLayoutResponseBytes: number;
  presentation: boolean;
  presentationCommandVersion: number;
  presentationQueryResponseVersion: number;
  presentationQueryVersion: number;
  presentationSnapshotVersion: number;
  presentationStatefulSessions: boolean;
  queryResponseVersion: number;
  queryVersion: number;
  receiptSchemaVersion: number;
  retainedRenderPatchVersion: number;
  retainedRenderTileVersion: number;
  safeRust: true;
  statefulSessions: boolean;
  textLayout: boolean;
  textLayoutFontBundleVersion: number;
  textLayoutRequestVersion: number;
  textLayoutResponseVersion: number;
  textLayoutStatefulSessions: boolean;
  sessionForks: boolean;
  transport: "bounded-uint8array";
  workbookMetadataQueries: boolean;
}>;

const MAX_BUILD_IDENTITY_BYTES = 512;
const MAX_CAPABILITIES_BYTES = 8 * 1024;
const MAX_FRONTIER_BYTES = 8 + 2 + 2 + 4 + 1_024 * 16 + 8;
const WASM_MAX_CELLS_PER_BATCH = 500_000;
const WASM_MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const WASM_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const loadBrowserWasmKernelAdapter: ArtifactWorkerKernelAdapterFactory = async (input) => {
  const rawWasm = await import(/* @vite-ignore */ input.wasmGlueUrl);
  const wasm = validateWasmModule(rawWasm, input.modality);
  if (wasm.default) await wasm.default({ module_or_path: input.wasmBinaryUrl });

  const buildIdentity = decodeUtf8(
    requireBoundedBytes(wasm.buildIdentity(), "WASM build identity", MAX_BUILD_IDENTITY_BYTES),
    "WASM build identity",
  );
  if (buildIdentity.length === 0) {
    throw adapterError("incompatible_wasm_build", "WASM build identity is empty");
  }
  const capabilities = decodeCapabilities(
    requireBoundedBytes(wasm.capabilities(), "WASM capabilities", MAX_CAPABILITIES_BYTES),
  );
  assertRequestedLimits(input, capabilities);

  const profile = capabilityProfile(input.modality, capabilities);
  const adapter: ArtifactWorkerKernelAdapter = {
    modality: input.modality,
    protocolVersion: capabilities.editableArtifactIntentVersion,
    kernelVersion: buildIdentity,
    modelSchemaVersion: profile.modelSchemaVersion,
    commandVersion: profile.commandVersion,
    maximumSnapshotBytes: profile.maximumSnapshotBytes,
    maximumCommandBytes: profile.maximumCommandBytes,
    maximumIntentBytes: capabilities.maxIntentBytes,
    maximumCommittedTransactionBytes: capabilities.maxCommittedTransactionBytes,
    maximumQueryBytes: profile.maximumQueryBytes,
    maximumQueryResponseBytes: profile.maximumQueryResponseBytes,
    canonicalizeSnapshot(snapshotBytes) {
      return requireOwnedOutput(
        wasm.canonicalizeSnapshot(snapshotBytes),
        `canonical ${input.modality} snapshot`,
        input.maximumSnapshotBytes,
      );
    },
    open(snapshotBytes) {
      if (wasm.modality === "spreadsheet") {
        return wrapWasmCollaborationSession(wasm.open(snapshotBytes), input);
      }
      return wrapWasmModalitySession(wasm.open(snapshotBytes), input);
    },
  };
  return Object.freeze(adapter);
};

function wrapWasmCollaborationSession(
  session: WasmCollaborationSession,
  limits: ArtifactWorkerInitializeInput,
): ArtifactWorkerKernelSession {
  requireSessionAbi(session);
  let disposed = false;
  const requireOpen = (): void => {
    if (disposed || session.isClosed?.() === true) {
      throw adapterError("session_closed", "artifact collaboration session is closed");
    }
  };
  return {
    modality: "spreadsheet",
    applyCommitted(committedTransactionBytes) {
      requireOpen();
      requireInputBytes(
        committedTransactionBytes,
        "committed transaction",
        limits.maximumCommittedTransactionBytes,
      );
      session.applyCommitted(committedTransactionBytes);
    },
    applyPending(intentBytes) {
      requireOpen();
      requireInputBytes(intentBytes, "pending intent", limits.maximumIntentBytes);
      const frontier = requireOwnedOutput(
        session.frontier(),
        "causal frontier",
        MAX_FRONTIER_BYTES,
      );
      try {
        // The exact OGATX contains its sole OGASC mutation payload. The return
        // value is a whole OGACO proof for this speculative branch; validating
        // its bound is sufficient because speculative OGACO is never persisted.
        requireOwnedOutput(
          session.authorTransaction(intentBytes, frontier),
          "speculative committed transaction",
          limits.maximumCommittedTransactionBytes,
        );
      } catch (error) {
        const projectionCode = classifyProjectionFailure(error);
        if (projectionCode !== null) {
          throw new ArtifactWorkerPendingProjectionError(projectionCode);
        }
        throw error;
      }
    },
    applyCommands() {
      throw adapterError(
        "unsupported_modality",
        "spreadsheet session does not apply serialized commands",
      );
    },
    nativeRevision() {
      throw adapterError("unsupported_modality", "spreadsheet session has no native revision");
    },
    fork() {
      requireOpen();
      return wrapWasmCollaborationSession(session.fork(), limits);
    },
    async stateHash() {
      requireOpen();
      const result = session.stateHash();
      if (!SHA256_PATTERN.test(result)) {
        throw adapterError("invalid_state_hash", "WASM kernel returned an invalid state hash");
      }
      return result;
    },
    snapshot() {
      requireOpen();
      return requireOwnedOutput(
        session.snapshot(),
        "collaboration snapshot",
        limits.maximumSnapshotBytes,
      );
    },
    query(queryBytes) {
      requireOpen();
      requireInputBytes(queryBytes, "kernel query", limits.maximumQueryBytes);
      return requireOwnedOutput(
        session.query(queryBytes),
        "kernel projection",
        limits.maximumQueryResponseBytes,
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        session.dispose?.();
      } finally {
        try {
          session.close?.();
        } finally {
          session.free?.();
        }
      }
    },
  };
}

function wrapWasmModalitySession(
  session: WasmModalitySession,
  limits: ArtifactWorkerInitializeInput,
): ArtifactWorkerKernelSession {
  requireModalitySessionAbi(session);
  let disposed = false;
  const requireOpen = (): void => {
    if (disposed || session.isClosed?.() === true) {
      throw adapterError("session_closed", `artifact ${limits.modality} session is closed`);
    }
  };
  return {
    modality: limits.modality,
    applyCommitted() {
      throw adapterError(
        "unsupported_modality",
        "serialized session requires decoded OGAST replay",
      );
    },
    applyPending() {
      throw adapterError("unsupported_modality", "serialized session requires exact command bytes");
    },
    applyCommands(commandBytes) {
      requireOpen();
      requireInputBytes(commandBytes, `${limits.modality} command`, limits.maximumCommandBytes);
      return requireOwnedOutput(
        session.applyCommands(commandBytes),
        `${limits.modality} native receipt`,
        limits.maximumCommittedTransactionBytes,
      );
    },
    nativeRevision() {
      requireOpen();
      const revision = session.revision();
      if (revision < 0n || revision > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw adapterError("invalid_revision", "WASM kernel returned an unsafe native revision");
      }
      return Number(revision);
    },
    fork() {
      requireOpen();
      return wrapWasmModalitySession(session.fork(), limits);
    },
    async stateHash() {
      requireOpen();
      const result = session.stateHash();
      if (!SHA256_PATTERN.test(result)) {
        throw adapterError("invalid_state_hash", "WASM kernel returned an invalid state hash");
      }
      return result;
    },
    snapshot() {
      requireOpen();
      return requireOwnedOutput(
        session.snapshot(),
        `${limits.modality} snapshot`,
        limits.maximumSnapshotBytes,
      );
    },
    query(queryBytes) {
      requireOpen();
      requireInputBytes(queryBytes, `${limits.modality} query`, limits.maximumQueryBytes);
      return requireOwnedOutput(
        session.query(queryBytes),
        `${limits.modality} projection`,
        limits.maximumQueryResponseBytes,
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        session.dispose?.();
      } finally {
        try {
          session.close?.();
        } finally {
          session.free?.();
        }
      }
    },
  };
}

function requireModalitySessionAbi(session: WasmModalitySession): void {
  if (
    !isObject(session) ||
    typeof session.applyCommands !== "function" ||
    typeof session.snapshot !== "function" ||
    typeof session.revision !== "function" ||
    typeof session.fork !== "function" ||
    typeof session.stateHash !== "function" ||
    typeof session.query !== "function"
  ) {
    session?.dispose?.();
    session?.close?.();
    session?.free?.();
    throw adapterError(
      "incompatible_wasm_build",
      "WASM modality session lacks the required stateful ABI",
    );
  }
}

function requireSessionAbi(session: WasmCollaborationSession): void {
  if (
    !isObject(session) ||
    typeof session.authorTransaction !== "function" ||
    typeof session.applyCommitted !== "function" ||
    typeof session.snapshot !== "function" ||
    typeof session.frontier !== "function" ||
    typeof session.fork !== "function" ||
    typeof session.stateHash !== "function" ||
    typeof session.revision !== "function" ||
    typeof session.query !== "function"
  ) {
    session?.dispose?.();
    session?.close?.();
    session?.free?.();
    throw adapterError(
      "incompatible_wasm_build",
      "WASM collaboration session lacks the required stateful ABI",
    );
  }
}

function validateWasmModule(input: unknown, modality: EditableArtifactModality): WasmKernelModule {
  if (!isObject(input)) throw adapterError("invalid_wasm_module", "WASM glue module is invalid");
  const capabilities = callable(input, "capabilities");
  const buildIdentity = callable(input, "buildIdentity");
  const initializer = optionalCallable(input, "default");
  const base: WasmKernelModuleBase = {
    capabilities: capabilities as WasmKernelModuleBase["capabilities"],
    buildIdentity: buildIdentity as WasmKernelModuleBase["buildIdentity"],
    ...(initializer
      ? { default: initializer as NonNullable<WasmKernelModuleBase["default"]> }
      : {}),
  };
  const canonicalizeName =
    modality === "spreadsheet"
      ? "canonicalizeCollaborationSnapshot"
      : modality === "document"
        ? "canonicalizeDocumentSnapshot"
        : "canonicalizePresentationSnapshot";
  const sessionName =
    modality === "spreadsheet"
      ? "ArtifactCollaborationSession"
      : modality === "document"
        ? "ArtifactDocumentSession"
        : "ArtifactPresentationSession";
  const canonicalizeSnapshot = callable(input, canonicalizeName);
  const sessionClass = data(input, sessionName);
  if (!isObject(sessionClass)) {
    throw adapterError("invalid_wasm_module", `WASM glue has no ${sessionName} export`);
  }
  const open = callable(sessionClass, "open");
  if (modality === "spreadsheet") {
    return {
      ...base,
      modality,
      canonicalizeSnapshot: canonicalizeSnapshot as (snapshotBytes: Uint8Array) => Uint8Array,
      open: open as (snapshotBytes: Uint8Array) => WasmCollaborationSession,
    };
  }
  return {
    ...base,
    modality,
    canonicalizeSnapshot: canonicalizeSnapshot as (snapshotBytes: Uint8Array) => Uint8Array,
    open: open as (snapshotBytes: Uint8Array) => WasmModalitySession,
  };
}

function decodeCapabilities(bytes: Uint8Array): WasmCapabilities {
  let value: unknown;
  try {
    const text = decodeUtf8(bytes, "WASM capabilities");
    value = JSON.parse(text) as unknown;
    if (JSON.stringify(value) !== text) {
      throw new TypeError("capabilities JSON is not canonical");
    }
  } catch (error) {
    throw new ArtifactWorkerProtocolError(
      "incompatible_wasm_build",
      "WASM capabilities are not canonical UTF-8 JSON",
      { cause: error },
    );
  }
  if (!isPlainRecord(value)) {
    throw adapterError("incompatible_wasm_build", "WASM capabilities must be a plain record");
  }
  const expectedKeys = [
    "abiVersion",
    "buildIdentityFormat",
    "canonicalStateHash",
    "collaboration",
    "collaborationSnapshotVersion",
    "commandSchemaVersion",
    "committedTransactionVersion",
    "document",
    "documentCommandVersion",
    "documentQueryResponseVersion",
    "documentQueryVersion",
    "documentReceiptVersion",
    "documentSnapshotVersion",
    "documentStatefulSessions",
    "editableArtifactIntentVersion",
    "kernelSnapshotVersion",
    "maxCellsPerBatch",
    "maxCommandBytes",
    "maxCommands",
    "maxCommittedTransactionBytes",
    "maxDocumentCommandBytes",
    "maxDocumentCommands",
    "maxDocumentQueryBytes",
    "maxDocumentQueryResponseBytes",
    "maxDocumentSnapshotBytes",
    "maxIntentBytes",
    "maxMetadataScannedCells",
    "maxMetadataSheets",
    "maxPresentationCommandBytes",
    "maxPresentationQueryBytes",
    "maxPresentationResponseBytes",
    "maxPresentationSnapshotBytes",
    "maxQueryBytes",
    "maxQueryResponseBytes",
    "maxSnapshotBytes",
    "maxSpreadsheetCommandBytes",
    "maxTextLayoutFontBundleBytes",
    "maxTextLayoutRequestBytes",
    "maxTextLayoutResponseBytes",
    "maxViewportArea",
    "maxViewportCells",
    "presentation",
    "presentationCommandVersion",
    "presentationQueryResponseVersion",
    "presentationQueryVersion",
    "presentationSnapshotVersion",
    "presentationStatefulSessions",
    "queryResponseVersion",
    "queryVersion",
    "receiptSchemaVersion",
    "retainedRenderPatchVersion",
    "retainedRenderTileVersion",
    "safeRust",
    "sessionForks",
    "spreadsheetCommandVersion",
    "statefulSessions",
    "textLayout",
    "textLayoutFontBundleVersion",
    "textLayoutRequestVersion",
    "textLayoutResponseVersion",
    "textLayoutStatefulSessions",
    "transport",
    "workbookMetadataQueries",
  ] as const;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw adapterError(
      "incompatible_wasm_build",
      "WASM collaboration capabilities have unknown or missing fields",
    );
  }
  const normalized = {
    abiVersion: positiveInteger(value.abiVersion, "abiVersion"),
    buildIdentityFormat: value.buildIdentityFormat,
    canonicalStateHash: value.canonicalStateHash,
    collaboration: strictBoolean(value.collaboration, "collaboration"),
    collaborationSnapshotVersion: positiveInteger(
      value.collaborationSnapshotVersion,
      "collaborationSnapshotVersion",
    ),
    commandSchemaVersion: positiveInteger(value.commandSchemaVersion, "commandSchemaVersion"),
    committedTransactionVersion: positiveInteger(
      value.committedTransactionVersion,
      "committedTransactionVersion",
    ),
    document: strictBoolean(value.document, "document"),
    documentCommandVersion: positiveInteger(value.documentCommandVersion, "documentCommandVersion"),
    documentQueryResponseVersion: positiveInteger(
      value.documentQueryResponseVersion,
      "documentQueryResponseVersion",
    ),
    documentQueryVersion: positiveInteger(value.documentQueryVersion, "documentQueryVersion"),
    documentReceiptVersion: positiveInteger(value.documentReceiptVersion, "documentReceiptVersion"),
    documentSnapshotVersion: positiveInteger(
      value.documentSnapshotVersion,
      "documentSnapshotVersion",
    ),
    documentStatefulSessions: strictBoolean(
      value.documentStatefulSessions,
      "documentStatefulSessions",
    ),
    editableArtifactIntentVersion: positiveInteger(
      value.editableArtifactIntentVersion,
      "editableArtifactIntentVersion",
    ),
    kernelSnapshotVersion: positiveInteger(value.kernelSnapshotVersion, "kernelSnapshotVersion"),
    spreadsheetCommandVersion: positiveInteger(
      value.spreadsheetCommandVersion,
      "spreadsheetCommandVersion",
    ),
    maxCellsPerBatch: positiveInteger(value.maxCellsPerBatch, "maxCellsPerBatch"),
    maxCommands: positiveInteger(value.maxCommands, "maxCommands"),
    maxSnapshotBytes: positiveInteger(value.maxSnapshotBytes, "maxSnapshotBytes"),
    maxCommandBytes: positiveInteger(value.maxCommandBytes, "maxCommandBytes"),
    maxSpreadsheetCommandBytes: positiveInteger(
      value.maxSpreadsheetCommandBytes,
      "maxSpreadsheetCommandBytes",
    ),
    maxIntentBytes: positiveInteger(value.maxIntentBytes, "maxIntentBytes"),
    maxCommittedTransactionBytes: positiveInteger(
      value.maxCommittedTransactionBytes,
      "maxCommittedTransactionBytes",
    ),
    maxDocumentCommandBytes: positiveInteger(
      value.maxDocumentCommandBytes,
      "maxDocumentCommandBytes",
    ),
    maxDocumentCommands: positiveInteger(value.maxDocumentCommands, "maxDocumentCommands"),
    maxDocumentQueryBytes: positiveInteger(value.maxDocumentQueryBytes, "maxDocumentQueryBytes"),
    maxDocumentQueryResponseBytes: positiveInteger(
      value.maxDocumentQueryResponseBytes,
      "maxDocumentQueryResponseBytes",
    ),
    maxDocumentSnapshotBytes: positiveInteger(
      value.maxDocumentSnapshotBytes,
      "maxDocumentSnapshotBytes",
    ),
    maxMetadataScannedCells: positiveInteger(
      value.maxMetadataScannedCells,
      "maxMetadataScannedCells",
    ),
    maxQueryBytes: positiveInteger(value.maxQueryBytes, "maxQueryBytes"),
    maxQueryResponseBytes: positiveInteger(value.maxQueryResponseBytes, "maxQueryResponseBytes"),
    maxViewportArea: positiveInteger(value.maxViewportArea, "maxViewportArea"),
    maxViewportCells: positiveInteger(value.maxViewportCells, "maxViewportCells"),
    maxMetadataSheets: positiveInteger(value.maxMetadataSheets, "maxMetadataSheets"),
    maxPresentationCommandBytes: positiveInteger(
      value.maxPresentationCommandBytes,
      "maxPresentationCommandBytes",
    ),
    maxPresentationQueryBytes: positiveInteger(
      value.maxPresentationQueryBytes,
      "maxPresentationQueryBytes",
    ),
    maxPresentationResponseBytes: positiveInteger(
      value.maxPresentationResponseBytes,
      "maxPresentationResponseBytes",
    ),
    maxPresentationSnapshotBytes: positiveInteger(
      value.maxPresentationSnapshotBytes,
      "maxPresentationSnapshotBytes",
    ),
    maxTextLayoutFontBundleBytes: positiveInteger(
      value.maxTextLayoutFontBundleBytes,
      "maxTextLayoutFontBundleBytes",
    ),
    maxTextLayoutRequestBytes: positiveInteger(
      value.maxTextLayoutRequestBytes,
      "maxTextLayoutRequestBytes",
    ),
    maxTextLayoutResponseBytes: positiveInteger(
      value.maxTextLayoutResponseBytes,
      "maxTextLayoutResponseBytes",
    ),
    queryResponseVersion: positiveInteger(value.queryResponseVersion, "queryResponseVersion"),
    queryVersion: positiveInteger(value.queryVersion, "queryVersion"),
    receiptSchemaVersion: positiveInteger(value.receiptSchemaVersion, "receiptSchemaVersion"),
    retainedRenderPatchVersion: positiveInteger(
      value.retainedRenderPatchVersion,
      "retainedRenderPatchVersion",
    ),
    retainedRenderTileVersion: positiveInteger(
      value.retainedRenderTileVersion,
      "retainedRenderTileVersion",
    ),
    presentation: strictBoolean(value.presentation, "presentation"),
    presentationCommandVersion: positiveInteger(
      value.presentationCommandVersion,
      "presentationCommandVersion",
    ),
    presentationQueryResponseVersion: positiveInteger(
      value.presentationQueryResponseVersion,
      "presentationQueryResponseVersion",
    ),
    presentationQueryVersion: positiveInteger(
      value.presentationQueryVersion,
      "presentationQueryVersion",
    ),
    presentationSnapshotVersion: positiveInteger(
      value.presentationSnapshotVersion,
      "presentationSnapshotVersion",
    ),
    presentationStatefulSessions: strictBoolean(
      value.presentationStatefulSessions,
      "presentationStatefulSessions",
    ),
    safeRust: strictBoolean(value.safeRust, "safeRust"),
    statefulSessions: strictBoolean(value.statefulSessions, "statefulSessions"),
    textLayout: strictBoolean(value.textLayout, "textLayout"),
    textLayoutFontBundleVersion: positiveInteger(
      value.textLayoutFontBundleVersion,
      "textLayoutFontBundleVersion",
    ),
    textLayoutRequestVersion: positiveInteger(
      value.textLayoutRequestVersion,
      "textLayoutRequestVersion",
    ),
    textLayoutResponseVersion: positiveInteger(
      value.textLayoutResponseVersion,
      "textLayoutResponseVersion",
    ),
    textLayoutStatefulSessions: strictBoolean(
      value.textLayoutStatefulSessions,
      "textLayoutStatefulSessions",
    ),
    sessionForks: strictBoolean(value.sessionForks, "sessionForks"),
    transport: value.transport,
    workbookMetadataQueries: strictBoolean(
      value.workbookMetadataQueries,
      "workbookMetadataQueries",
    ),
  };
  if (
    normalized.abiVersion !== 1 ||
    normalized.buildIdentityFormat !== "utf8" ||
    normalized.canonicalStateHash !== "sha256:canonical-snapshot" ||
    normalized.editableArtifactIntentVersion !== EDITABLE_ARTIFACT_INTENT_VERSION ||
    normalized.spreadsheetCommandVersion !== SPREADSHEET_ARTIFACT_COMMAND_VERSION ||
    normalized.collaborationSnapshotVersion !== 1 ||
    normalized.commandSchemaVersion !== 1 ||
    normalized.committedTransactionVersion !== 1 ||
    normalized.documentCommandVersion !== 1 ||
    normalized.documentQueryResponseVersion !== 1 ||
    normalized.documentQueryVersion !== 1 ||
    normalized.documentReceiptVersion !== 1 ||
    normalized.documentSnapshotVersion !== 1 ||
    normalized.documentStatefulSessions !== normalized.document ||
    normalized.kernelSnapshotVersion !== 1 ||
    normalized.maxCellsPerBatch !== WASM_MAX_CELLS_PER_BATCH ||
    normalized.maxCommandBytes !== WASM_MAX_COMMAND_BYTES ||
    normalized.maxSpreadsheetCommandBytes !== EDITABLE_ARTIFACT_COMMAND_MAX_BYTES ||
    normalized.maxCommands !== 10_000 ||
    normalized.maxIntentBytes !== EDITABLE_ARTIFACT_INTENT_MAX_BYTES ||
    normalized.maxCommittedTransactionBytes !== MAX_COMMITTED_TRANSACTION_BYTES ||
    normalized.maxDocumentCommandBytes !== WASM_MAX_COMMAND_BYTES ||
    normalized.maxDocumentCommands !== 4_096 ||
    normalized.maxDocumentQueryBytes !== 256 ||
    normalized.maxDocumentQueryResponseBytes !== 8 * 1024 * 1024 ||
    normalized.maxDocumentSnapshotBytes !== WASM_MAX_SNAPSHOT_BYTES ||
    normalized.maxMetadataScannedCells !== 4_000_000 ||
    normalized.maxQueryBytes !== 68 ||
    normalized.maxQueryResponseBytes !== 8 * 1024 * 1024 ||
    normalized.maxViewportArea !== 1_048_576 ||
    normalized.maxViewportCells !== 262_144 ||
    normalized.maxMetadataSheets !== 10_000 ||
    normalized.maxPresentationCommandBytes !== 4 * 1024 * 1024 ||
    normalized.maxPresentationQueryBytes !== 96 ||
    normalized.maxPresentationResponseBytes !== 8 * 1024 * 1024 ||
    normalized.maxPresentationSnapshotBytes !== WASM_MAX_SNAPSHOT_BYTES ||
    normalized.maxTextLayoutFontBundleBytes !== 48 * 1024 * 1024 ||
    normalized.maxTextLayoutRequestBytes !== 4 * 1024 * 1024 ||
    normalized.maxTextLayoutResponseBytes !== 32 * 1024 * 1024 ||
    normalized.maxSnapshotBytes !== WASM_MAX_SNAPSHOT_BYTES ||
    normalized.queryResponseVersion !== 1 ||
    normalized.queryVersion !== 1 ||
    normalized.receiptSchemaVersion !== 1 ||
    normalized.retainedRenderPatchVersion !== 1 ||
    normalized.retainedRenderTileVersion !== 1 ||
    normalized.presentationCommandVersion !== 1 ||
    normalized.presentationQueryResponseVersion !== 1 ||
    normalized.presentationQueryVersion !== 1 ||
    normalized.presentationSnapshotVersion !== 1 ||
    normalized.presentationStatefulSessions !== normalized.presentation ||
    normalized.safeRust !== true ||
    normalized.statefulSessions !== true ||
    normalized.textLayoutFontBundleVersion !== 1 ||
    normalized.textLayoutRequestVersion !== 1 ||
    normalized.textLayoutResponseVersion !== 1 ||
    normalized.textLayoutStatefulSessions !== normalized.textLayout ||
    normalized.sessionForks !== true ||
    normalized.transport !== "bounded-uint8array" ||
    normalized.workbookMetadataQueries !== normalized.collaboration
  ) {
    throw adapterError(
      "incompatible_wasm_build",
      "WASM capabilities do not match the SDK protocol",
    );
  }
  return Object.freeze(normalized) as WasmCapabilities;
}

function assertRequestedLimits(
  input: ArtifactWorkerInitializeInput,
  capabilities: WasmCapabilities,
): void {
  const profile = capabilityProfile(input.modality, capabilities);
  const pairs = [
    ["maximumSnapshotBytes", input.maximumSnapshotBytes, profile.maximumSnapshotBytes],
    ["maximumCommandBytes", input.maximumCommandBytes, profile.maximumCommandBytes],
    ["maximumIntentBytes", input.maximumIntentBytes, capabilities.maxIntentBytes],
    [
      "maximumCommittedTransactionBytes",
      input.maximumCommittedTransactionBytes,
      capabilities.maxCommittedTransactionBytes,
    ],
    ["maximumQueryBytes", input.maximumQueryBytes, profile.maximumQueryBytes],
    [
      "maximumQueryResponseBytes",
      input.maximumQueryResponseBytes,
      profile.maximumQueryResponseBytes,
    ],
  ] as const;
  for (const [label, requested, advertised] of pairs) {
    if (requested > advertised) {
      throw adapterError(
        "incompatible_wasm_build",
        `${label} exceeds the loaded WASM build capability`,
      );
    }
  }
}

function capabilityProfile(modality: EditableArtifactModality, capabilities: WasmCapabilities) {
  if (modality === "spreadsheet") {
    if (!capabilities.collaboration || !capabilities.workbookMetadataQueries) {
      throw adapterError(
        "incompatible_wasm_build",
        "WASM module does not provide the spreadsheet collaboration ABI",
      );
    }
    return {
      modelSchemaVersion: capabilities.collaborationSnapshotVersion,
      commandVersion: capabilities.spreadsheetCommandVersion,
      maximumSnapshotBytes: capabilities.maxSnapshotBytes,
      maximumCommandBytes: capabilities.maxSpreadsheetCommandBytes,
      maximumQueryBytes: capabilities.maxQueryBytes,
      maximumQueryResponseBytes: capabilities.maxQueryResponseBytes,
    } as const;
  }
  if (modality === "document") {
    if (!capabilities.document || !capabilities.documentStatefulSessions) {
      throw adapterError(
        "incompatible_wasm_build",
        "WASM module does not provide the document ABI",
      );
    }
    return {
      modelSchemaVersion: capabilities.documentSnapshotVersion,
      commandVersion: capabilities.documentCommandVersion,
      maximumSnapshotBytes: capabilities.maxDocumentSnapshotBytes,
      maximumCommandBytes: capabilities.maxDocumentCommandBytes,
      maximumQueryBytes: capabilities.maxDocumentQueryBytes,
      maximumQueryResponseBytes: capabilities.maxDocumentQueryResponseBytes,
    } as const;
  }
  if (!capabilities.presentation || !capabilities.presentationStatefulSessions) {
    throw adapterError(
      "incompatible_wasm_build",
      "WASM module does not provide the presentation ABI",
    );
  }
  return {
    modelSchemaVersion: capabilities.presentationSnapshotVersion,
    commandVersion: capabilities.presentationCommandVersion,
    maximumSnapshotBytes: capabilities.maxPresentationSnapshotBytes,
    maximumCommandBytes: capabilities.maxPresentationCommandBytes,
    maximumQueryBytes: capabilities.maxPresentationQueryBytes,
    maximumQueryResponseBytes: capabilities.maxPresentationResponseBytes,
  } as const;
}

function classifyProjectionFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  const match = /^\[([A-Z][A-Z0-9_]{0,127})\]/u.exec(message);
  if (!match) return null;
  switch (match[1]) {
    case "ARTIFACT_COLLABORATION_REJECTED":
      return "structural_conflict";
    case "ARTIFACT_PROJECTION_REJECTED":
      return "projection_conflict";
    default:
      return null;
  }
}

function requireInputBytes(value: unknown, label: string, maximumBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw adapterError("invalid_kernel_input", `${label} must be non-empty bytes`);
  }
  if (value.byteLength > maximumBytes) {
    throw adapterError("limit_exceeded", `${label} exceeds its byte limit`);
  }
  return value;
}

function requireBoundedBytes(value: unknown, label: string, maximumBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw adapterError("invalid_kernel_output", `${label} must be non-empty bytes`);
  }
  if (value.byteLength > maximumBytes) {
    throw adapterError("limit_exceeded", `${label} exceeds its byte limit`);
  }
  return value;
}

/**
 * Wasm-bindgen returns a fresh Uint8Array. Keep its exact ArrayBuffer when
 * possible so the Worker can transfer it without another large copy; normalize
 * only aliased/subarray outputs from test or custom glue.
 */
function requireOwnedOutput(value: unknown, label: string, maximumBytes: number): Uint8Array {
  const bytes = requireBoundedBytes(value, label, maximumBytes);
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes;
  }
  return bytes.slice();
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ArtifactWorkerProtocolError("incompatible_wasm_build", `${label} is not UTF-8`, {
      cause: error,
    });
  }
}

function callable(
  record: Record<PropertyKey, unknown>,
  key: string,
): (...args: never[]) => unknown {
  const value = data(record, key);
  if (typeof value !== "function") {
    throw adapterError("invalid_wasm_module", `${key} must be a function`);
  }
  return value as (...args: never[]) => unknown;
}

function optionalCallable(
  record: Record<PropertyKey, unknown>,
  key: string,
): ((...args: never[]) => unknown) | undefined {
  const value = data(record, key, false);
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw adapterError("invalid_wasm_module", `${key} must be a function`);
  }
  return value as (...args: never[]) => unknown;
}

function data(record: Record<PropertyKey, unknown>, key: string, required = true): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  // ES module namespace exports are accessor descriptors by specification.
  if (descriptor) return "value" in descriptor ? descriptor.value : Reflect.get(record, key);
  if (required) throw adapterError("invalid_wasm_module", `module is missing ${key}`);
  return undefined;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function adapterError(code: string, message: string): ArtifactWorkerProtocolError {
  return new ArtifactWorkerProtocolError(code, message);
}

function requireErrorCode(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(value)) {
    throw adapterError("invalid_wasm_module", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw adapterError("incompatible_wasm_build", `${label} must be a positive safe integer`);
  }
  return value as number;
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw adapterError("incompatible_wasm_build", `${label} must be a boolean`);
  }
  return value;
}
