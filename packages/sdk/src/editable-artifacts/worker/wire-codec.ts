import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
} from "@opengeni/contracts/editable-artifacts";
import { MAX_COMMITTED_TRANSACTION_BYTES } from "@opengeni/contracts/editable-artifact-committed-transaction";
import type {
  EditableArtifactBlockedPending,
  EditableArtifactCommittedTransaction,
  EditableArtifactModality,
  EditableArtifactPendingTransaction,
  EditableArtifactSnapshot,
  EditableArtifactWorkerKernel,
} from "../types";
import {
  ArtifactWorkerBinaryReader,
  ArtifactWorkerBinaryWriter,
  ArtifactWorkerProtocolError,
} from "./rpc-protocol";

const MAX_ID_BYTES = 256;
const MAX_VERSION_BYTES = 512;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HARD_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const HARD_MAX_COMMAND_BYTES = EDITABLE_ARTIFACT_COMMAND_MAX_BYTES;
const HARD_MAX_INTENT_BYTES = EDITABLE_ARTIFACT_INTENT_MAX_BYTES;
const HARD_MAX_COMMITTED_TRANSACTION_BYTES = MAX_COMMITTED_TRANSACTION_BYTES;
const HARD_MAX_QUERY_BYTES = 256;
const HARD_MAX_QUERY_RESPONSE_BYTES = 8 * 1024 * 1024;
const HARD_MAX_PENDING_TRANSACTIONS = 1_024;

export type ArtifactWorkerInitializeInput = {
  modality: EditableArtifactModality;
  kernelVersion: string;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandVersion: number;
  wasmGlueUrl: string;
  wasmBinaryUrl: string;
  maximumSnapshotBytes: number;
  maximumCommandBytes: number;
  maximumIntentBytes: number;
  maximumCommittedTransactionBytes: number;
  maximumQueryBytes: number;
  maximumQueryResponseBytes: number;
  maximumPendingTransactions: number;
};

export type ArtifactWorkerAuthorPendingInput = Parameters<
  EditableArtifactWorkerKernel["authorPending"]
>[0];

export type ArtifactWorkerErrorPayload = {
  code: string;
  message: string;
  retryable: boolean;
};

export function encodeInitialize(input: ArtifactWorkerInitializeInput): Uint8Array {
  validateInitializeLimits(input);
  const writer = new ArtifactWorkerBinaryWriter();
  writer
    .u8(modalityTag(input.modality))
    .string(requireVersion(input.kernelVersion, "kernelVersion"), MAX_VERSION_BYTES)
    .u32(positiveSafeInteger(input.protocolVersion, "protocolVersion"))
    .u32(positiveSafeInteger(input.modelSchemaVersion, "modelSchemaVersion"))
    .u32(positiveSafeInteger(input.commandVersion, "commandVersion"))
    .string(requireUrl(input.wasmGlueUrl, "wasmGlueUrl"), MAX_URL_BYTES)
    .string(requireUrl(input.wasmBinaryUrl, "wasmBinaryUrl"), MAX_URL_BYTES)
    .safeUint(positiveSafeInteger(input.maximumSnapshotBytes, "maximumSnapshotBytes"))
    .safeUint(positiveSafeInteger(input.maximumCommandBytes, "maximumCommandBytes"))
    .safeUint(positiveSafeInteger(input.maximumIntentBytes, "maximumIntentBytes"))
    .safeUint(
      positiveSafeInteger(
        input.maximumCommittedTransactionBytes,
        "maximumCommittedTransactionBytes",
      ),
    )
    .safeUint(positiveSafeInteger(input.maximumQueryBytes, "maximumQueryBytes"))
    .safeUint(positiveSafeInteger(input.maximumQueryResponseBytes, "maximumQueryResponseBytes"))
    .safeUint(positiveSafeInteger(input.maximumPendingTransactions, "maximumPendingTransactions"));
  return writer.finish();
}

export function decodeInitialize(bytes: Uint8Array): ArtifactWorkerInitializeInput {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const value = {
    modality: decodeModality(reader.u8()),
    kernelVersion: requireVersion(reader.string(MAX_VERSION_BYTES), "kernelVersion"),
    protocolVersion: positiveSafeInteger(reader.u32(), "protocolVersion"),
    modelSchemaVersion: positiveSafeInteger(reader.u32(), "modelSchemaVersion"),
    commandVersion: positiveSafeInteger(reader.u32(), "commandVersion"),
    wasmGlueUrl: requireUrl(reader.string(MAX_URL_BYTES), "wasmGlueUrl"),
    wasmBinaryUrl: requireUrl(reader.string(MAX_URL_BYTES), "wasmBinaryUrl"),
    maximumSnapshotBytes: positiveSafeInteger(reader.safeUint(), "maximumSnapshotBytes"),
    maximumCommandBytes: positiveSafeInteger(reader.safeUint(), "maximumCommandBytes"),
    maximumIntentBytes: positiveSafeInteger(reader.safeUint(), "maximumIntentBytes"),
    maximumCommittedTransactionBytes: positiveSafeInteger(
      reader.safeUint(),
      "maximumCommittedTransactionBytes",
    ),
    maximumQueryBytes: positiveSafeInteger(reader.safeUint(), "maximumQueryBytes"),
    maximumQueryResponseBytes: positiveSafeInteger(reader.safeUint(), "maximumQueryResponseBytes"),
    maximumPendingTransactions: positiveSafeInteger(
      reader.safeUint(),
      "maximumPendingTransactions",
    ),
  };
  reader.done();
  validateInitializeLimits(value);
  return value;
}

export function encodeSnapshotMetadata(snapshot: EditableArtifactSnapshot): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter();
  writer
    .u8(modalityTag(snapshot.modality))
    .string(requireIdentifier(snapshot.artifactId, "snapshot.artifactId"), MAX_ID_BYTES)
    .safeUint(nonNegativeSafeInteger(snapshot.sequence, "snapshot.sequence"))
    .string(requireSha256(snapshot.stateHash, "snapshot.stateHash"), 71)
    .string(requireSha256(snapshot.digest, "snapshot.digest"), 71)
    .string(requireVersion(snapshot.kernelVersion, "snapshot.kernelVersion"), MAX_VERSION_BYTES)
    .u32(positiveSafeInteger(snapshot.modelSchemaVersion, "snapshot.modelSchemaVersion"));
  if (snapshot.modality === "spreadsheet") {
    writer
      .frontier(snapshot.causalFrontier)
      .u32(positiveSafeInteger(snapshot.protocolVersion, "snapshot.protocolVersion"));
  } else {
    writer.safeUint(nonNegativeSafeInteger(snapshot.nativeRevision, "snapshot.nativeRevision"));
  }
  return writer.finish();
}

export function decodeSnapshotMetadata(
  bytes: Uint8Array,
  snapshotBytes: Uint8Array,
): EditableArtifactSnapshot {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const modality = decodeModality(reader.u8());
  const common = {
    artifactId: requireIdentifier(reader.string(MAX_ID_BYTES), "snapshot.artifactId"),
    sequence: nonNegativeSafeInteger(reader.safeUint(), "snapshot.sequence"),
    stateHash: requireSha256(reader.string(71), "snapshot.stateHash"),
    digest: requireSha256(reader.string(71), "snapshot.digest"),
    kernelVersion: requireVersion(reader.string(MAX_VERSION_BYTES), "snapshot.kernelVersion"),
    modelSchemaVersion: positiveSafeInteger(reader.u32(), "snapshot.modelSchemaVersion"),
    bytes: snapshotBytes,
  } as const;
  const value: EditableArtifactSnapshot =
    modality === "spreadsheet"
      ? {
          ...common,
          modality,
          causalFrontier: reader.frontier(),
          protocolVersion: positiveSafeInteger(reader.u32(), "snapshot.protocolVersion"),
        }
      : {
          ...common,
          modality,
          nativeRevision: nonNegativeSafeInteger(reader.safeUint(), "snapshot.nativeRevision"),
        };
  reader.done();
  return Object.freeze(value);
}

export function encodeCommittedMetadata(
  transaction: EditableArtifactCommittedTransaction,
): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter();
  encodeCommittedFields(writer, transaction);
  return writer.finish();
}

export function decodeCommittedMetadata(
  bytes: Uint8Array,
  committedTransactionBytes: Uint8Array,
): EditableArtifactCommittedTransaction {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const modality = decodeModality(reader.u8());
  const common = {
    artifactId: requireIdentifier(reader.string(MAX_ID_BYTES), "transaction.artifactId"),
    transactionId: requireIdentifier(reader.string(MAX_ID_BYTES), "transaction.transactionId"),
    requestHash: requireSha256(reader.string(71), "transaction.requestHash"),
    startSequence: positiveSafeInteger(reader.safeUint(), "transaction.startSequence"),
    endSequence: positiveSafeInteger(reader.safeUint(), "transaction.endSequence"),
    priorStateHash: requireSha256(reader.string(71), "transaction.priorStateHash"),
    stateHash: requireSha256(reader.string(71), "transaction.stateHash"),
    committedTransactionBytes,
  } as const;
  const value: EditableArtifactCommittedTransaction =
    modality === "spreadsheet"
      ? {
          ...common,
          modality,
          causalFrontier: reader.frontier(),
          protocolVersion: positiveSafeInteger(reader.u32(), "transaction.protocolVersion"),
        }
      : {
          ...common,
          modality,
          priorNativeRevision: nonNegativeSafeInteger(
            reader.safeUint(),
            "transaction.priorNativeRevision",
          ),
          nativeRevision: nonNegativeSafeInteger(reader.safeUint(), "transaction.nativeRevision"),
          commitProtocolVersion: positiveSafeInteger(
            reader.u32(),
            "transaction.commitProtocolVersion",
          ),
        };
  reader.done();
  if (value.endSequence < value.startSequence) {
    throw wireError("invalid_sequence", "transaction endSequence precedes startSequence");
  }
  return Object.freeze(value);
}

export function encodePendingListMetadata(
  transactions: readonly EditableArtifactPendingTransaction[],
): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter();
  if (!Array.isArray(transactions))
    throw wireError("invalid_pending", "pending transactions must be an array");
  writer.u32(transactions.length);
  for (const transaction of transactions) encodePendingFields(writer, transaction);
  return writer.finish();
}

export function decodePendingListMetadata(
  bytes: Uint8Array,
  segments: readonly Uint8Array[],
  maximumTransactions: number,
): readonly EditableArtifactPendingTransaction[] {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const count = reader.u32();
  if (count > maximumTransactions || count * 2 !== segments.length) {
    throw wireError("invalid_pending", "pending metadata and command segments do not match");
  }
  const transactions: EditableArtifactPendingTransaction[] = [];
  for (let index = 0; index < count; index += 1) {
    transactions.push(decodePendingFields(reader, segments[index * 2]!, segments[index * 2 + 1]!));
  }
  reader.done();
  return Object.freeze(transactions);
}

export function encodeReconcileMetadata(
  committed: EditableArtifactCommittedTransaction,
  pending: readonly EditableArtifactPendingTransaction[],
): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter();
  encodeCommittedFields(writer, committed);
  writer.u32(pending.length);
  for (const transaction of pending) encodePendingFields(writer, transaction);
  return writer.finish();
}

export function decodeReconcileMetadata(
  bytes: Uint8Array,
  segments: readonly Uint8Array[],
  maximumPendingTransactions: number,
): {
  committed: EditableArtifactCommittedTransaction;
  pending: readonly EditableArtifactPendingTransaction[];
} {
  if (segments.length < 1) throw wireError("invalid_segment", "reconcile requires operation bytes");
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const committed = decodeCommittedFields(reader, segments[0]!);
  if (committed.endSequence < committed.startSequence) {
    throw wireError("invalid_sequence", "transaction endSequence precedes startSequence");
  }
  const count = reader.u32();
  if (count > maximumPendingTransactions || segments.length !== count * 2 + 1) {
    throw wireError("invalid_pending", "reconcile pending metadata and segments do not match");
  }
  const pending: EditableArtifactPendingTransaction[] = [];
  for (let index = 0; index < count; index += 1) {
    pending.push(decodePendingFields(reader, segments[index * 2 + 1]!, segments[index * 2 + 2]!));
  }
  reader.done();
  return { committed, pending: Object.freeze(pending) };
}

export function encodeAuthorPendingMetadata(input: ArtifactWorkerAuthorPendingInput): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter();
  encodeAuthorPendingFields(writer, input);
  return writer.finish();
}

export function decodeAuthorPendingMetadata(
  bytes: Uint8Array,
  commandBytes: Uint8Array,
): ArtifactWorkerAuthorPendingInput {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const value = decodeAuthorPendingFields(reader, commandBytes);
  reader.done();
  return value;
}

export function encodeStateResponse(stateHash: string, digest?: string): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter(256);
  writer
    .string(requireSha256(stateHash, "stateHash"), 71)
    .optionalString(digest === undefined ? null : requireSha256(digest, "digest"), 71);
  return writer.finish();
}

export function decodeStateResponse(bytes: Uint8Array): { stateHash: string; digest?: string } {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const stateHash = requireSha256(reader.string(71), "stateHash");
  const digest = reader.optionalString(71);
  reader.done();
  return digest === null ? { stateHash } : { stateHash, digest: requireSha256(digest, "digest") };
}

export function encodeProjectionResponse(
  blockedPending: readonly EditableArtifactBlockedPending[],
  stateHash?: string,
): Uint8Array {
  if (!Array.isArray(blockedPending) || blockedPending.length > HARD_MAX_PENDING_TRANSACTIONS) {
    throw wireError("invalid_pending", "blocked pending result exceeds its item limit");
  }
  const writer = new ArtifactWorkerBinaryWriter();
  writer.optionalString(stateHash === undefined ? null : requireSha256(stateHash, "stateHash"), 71);
  writer.u32(blockedPending.length);
  const seen = new Set<string>();
  for (const blocked of blockedPending) {
    const clientTransactionId = requireIdentifier(
      blocked.clientTransactionId,
      "blocked.clientTransactionId",
    );
    if (seen.has(clientTransactionId))
      throw wireError("noncanonical", "blocked transaction is duplicated");
    seen.add(clientTransactionId);
    writer.string(clientTransactionId, MAX_ID_BYTES).string(requireErrorCode(blocked.code), 128);
  }
  return writer.finish();
}

export function decodeProjectionResponse(bytes: Uint8Array): {
  stateHash?: string;
  blockedPending: readonly EditableArtifactBlockedPending[];
} {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const stateHash = reader.optionalString(71);
  const count = reader.u32();
  if (count > HARD_MAX_PENDING_TRANSACTIONS) {
    throw wireError("invalid_pending", "blocked pending result exceeds its item limit");
  }
  const blockedPending: EditableArtifactBlockedPending[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const clientTransactionId = requireIdentifier(
      reader.string(MAX_ID_BYTES),
      "blocked.clientTransactionId",
    );
    if (seen.has(clientTransactionId))
      throw wireError("noncanonical", "blocked transaction is duplicated");
    seen.add(clientTransactionId);
    blockedPending.push(
      Object.freeze({ clientTransactionId, code: requireErrorCode(reader.string(128)) }),
    );
  }
  reader.done();
  return {
    ...(stateHash === null ? {} : { stateHash: requireSha256(stateHash, "stateHash") }),
    blockedPending: Object.freeze(blockedPending),
  };
}

export function encodeErrorPayload(error: ArtifactWorkerErrorPayload): Uint8Array {
  const writer = new ArtifactWorkerBinaryWriter(MAX_ERROR_BYTES * 2 + 32);
  writer
    .string(requireErrorCode(error.code), 128)
    .string(requireBoundedString(error.message, "error.message", MAX_ERROR_BYTES), MAX_ERROR_BYTES)
    .u8(error.retryable ? 1 : 0);
  return writer.finish();
}

export function decodeErrorPayload(bytes: Uint8Array): ArtifactWorkerErrorPayload {
  const reader = new ArtifactWorkerBinaryReader(bytes);
  const value = {
    code: requireErrorCode(reader.string(128)),
    message: requireBoundedString(reader.string(MAX_ERROR_BYTES), "error.message", MAX_ERROR_BYTES),
    retryable: decodeBoolean(reader.u8(), "error.retryable"),
  };
  reader.done();
  return value;
}

export function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array))
    throw wireError("invalid_bytes", "SHA-256 input must be bytes");
  const owned = new Uint8Array(bytes);
  return globalThis.crypto.subtle
    .digest("SHA-256", owned)
    .then(
      (digest) =>
        `sha256:${[...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")}`,
    );
}

export function requireMatchingHash(actual: string, expected: string, label: string): void {
  requireSha256(actual, `${label}.actual`);
  requireSha256(expected, `${label}.expected`);
  if (actual !== expected)
    throw wireError("kernel_diverged", `${label} hash does not match authority`);
}

function encodeCommittedFields(
  writer: ArtifactWorkerBinaryWriter,
  transaction: EditableArtifactCommittedTransaction,
): void {
  writer
    .u8(modalityTag(transaction.modality))
    .string(requireIdentifier(transaction.artifactId, "transaction.artifactId"), MAX_ID_BYTES)
    .string(requireIdentifier(transaction.transactionId, "transaction.transactionId"), MAX_ID_BYTES)
    .string(requireSha256(transaction.requestHash, "transaction.requestHash"), 71)
    .safeUint(positiveSafeInteger(transaction.startSequence, "transaction.startSequence"))
    .safeUint(positiveSafeInteger(transaction.endSequence, "transaction.endSequence"))
    .string(requireSha256(transaction.priorStateHash, "transaction.priorStateHash"), 71)
    .string(requireSha256(transaction.stateHash, "transaction.stateHash"), 71);
  if (transaction.modality === "spreadsheet") {
    writer
      .frontier(transaction.causalFrontier)
      .u32(positiveSafeInteger(transaction.protocolVersion, "transaction.protocolVersion"));
  } else {
    writer
      .safeUint(
        nonNegativeSafeInteger(transaction.priorNativeRevision, "transaction.priorNativeRevision"),
      )
      .safeUint(nonNegativeSafeInteger(transaction.nativeRevision, "transaction.nativeRevision"))
      .u32(
        positiveSafeInteger(transaction.commitProtocolVersion, "transaction.commitProtocolVersion"),
      );
  }
}

function decodeCommittedFields(
  reader: ArtifactWorkerBinaryReader,
  committedTransactionBytes: Uint8Array,
): EditableArtifactCommittedTransaction {
  const modality = decodeModality(reader.u8());
  const common = {
    artifactId: requireIdentifier(reader.string(MAX_ID_BYTES), "transaction.artifactId"),
    transactionId: requireIdentifier(reader.string(MAX_ID_BYTES), "transaction.transactionId"),
    requestHash: requireSha256(reader.string(71), "transaction.requestHash"),
    startSequence: positiveSafeInteger(reader.safeUint(), "transaction.startSequence"),
    endSequence: positiveSafeInteger(reader.safeUint(), "transaction.endSequence"),
    priorStateHash: requireSha256(reader.string(71), "transaction.priorStateHash"),
    stateHash: requireSha256(reader.string(71), "transaction.stateHash"),
    committedTransactionBytes,
  } as const;
  return Object.freeze(
    modality === "spreadsheet"
      ? {
          ...common,
          modality,
          causalFrontier: reader.frontier(),
          protocolVersion: positiveSafeInteger(reader.u32(), "transaction.protocolVersion"),
        }
      : {
          ...common,
          modality,
          priorNativeRevision: nonNegativeSafeInteger(
            reader.safeUint(),
            "transaction.priorNativeRevision",
          ),
          nativeRevision: nonNegativeSafeInteger(reader.safeUint(), "transaction.nativeRevision"),
          commitProtocolVersion: positiveSafeInteger(
            reader.u32(),
            "transaction.commitProtocolVersion",
          ),
        },
  );
}

function modalityTag(modality: EditableArtifactModality): number {
  switch (modality) {
    case "document":
      return 1;
    case "spreadsheet":
      return 2;
    case "presentation":
      return 3;
  }
}

function decodeModality(tag: number): EditableArtifactModality {
  if (tag === 1) return "document";
  if (tag === 2) return "spreadsheet";
  if (tag === 3) return "presentation";
  throw wireError("invalid_modality", "artifact modality tag is invalid");
}

function encodePendingFields(
  writer: ArtifactWorkerBinaryWriter,
  transaction: EditableArtifactPendingTransaction,
): void {
  writer
    .u8(modalityTag(transaction.modality))
    .string(requireIdentifier(transaction.artifactId, "pending.artifactId"), MAX_ID_BYTES)
    .string(
      requireIdentifier(transaction.clientTransactionId, "pending.clientTransactionId"),
      MAX_ID_BYTES,
    )
    .string(requireSha256(transaction.requestHash, "pending.requestHash"), 71)
    .u32(positiveSafeInteger(transaction.protocolVersion, "pending.protocolVersion"))
    .u32(positiveSafeInteger(transaction.modelSchemaVersion, "pending.modelSchemaVersion"))
    .u32(positiveSafeInteger(transaction.commandVersion, "pending.commandVersion"))
    .string(requireReplicaId(transaction.replicaId, "pending.replicaId"), 16)
    .safeUint(positiveSafeInteger(transaction.replicaCounter, "pending.replicaCounter"))
    .optionalString(
      transaction.previousLocalTransactionId === null
        ? null
        : requireIdentifier(
            transaction.previousLocalTransactionId,
            "pending.previousLocalTransactionId",
          ),
      MAX_ID_BYTES,
    )
    .safeUint(
      nonNegativeSafeInteger(transaction.observedHeadSequence, "pending.observedHeadSequence"),
    );
  if (transaction.modality === "spreadsheet") {
    writer.frontier(transaction.causalBase).u32(transaction.selectiveUndoTargets.length);
    encodeSortedIdentifiers(
      writer,
      transaction.selectiveUndoTargets,
      "pending.selectiveUndoTargets",
    );
  } else {
    writer.safeUint(
      nonNegativeSafeInteger(transaction.observedNativeRevision, "pending.observedNativeRevision"),
    );
  }
  writer.safeUint(nonNegativeSafeInteger(transaction.createdAt, "pending.createdAt"));
}

function decodePendingFields(
  reader: ArtifactWorkerBinaryReader,
  commandBytes: Uint8Array,
  intentBytes: Uint8Array,
): EditableArtifactPendingTransaction {
  const modality = decodeModality(reader.u8());
  const artifactId = requireIdentifier(reader.string(MAX_ID_BYTES), "pending.artifactId");
  const clientTransactionId = requireIdentifier(
    reader.string(MAX_ID_BYTES),
    "pending.clientTransactionId",
  );
  const requestHash = requireSha256(reader.string(71), "pending.requestHash");
  const protocolVersion = positiveSafeInteger(reader.u32(), "pending.protocolVersion");
  const modelSchemaVersion = positiveSafeInteger(reader.u32(), "pending.modelSchemaVersion");
  const commandVersion = positiveSafeInteger(reader.u32(), "pending.commandVersion");
  const replicaId = requireReplicaId(reader.string(16), "pending.replicaId");
  const replicaCounter = positiveSafeInteger(reader.safeUint(), "pending.replicaCounter");
  const previousLocalTransactionId = optionalIdentifier(
    reader.optionalString(MAX_ID_BYTES),
    "pending.previousLocalTransactionId",
  );
  const observedHeadSequence = nonNegativeSafeInteger(
    reader.safeUint(),
    "pending.observedHeadSequence",
  );
  const common = {
    artifactId,
    clientTransactionId,
    requestHash,
    protocolVersion,
    modelSchemaVersion,
    commandVersion,
    replicaId,
    replicaCounter,
    previousLocalTransactionId,
    observedHeadSequence,
    commandBytes,
    intentBytes,
  } as const;
  if (modality === "spreadsheet") {
    const causalBase = reader.frontier();
    const selectiveUndoTargets = decodeSortedIdentifiers(
      reader,
      reader.u32(),
      "pending.selectiveUndoTargets",
    );
    return Object.freeze({
      ...common,
      modality,
      causalBase,
      selectiveUndoTargets,
      createdAt: nonNegativeSafeInteger(reader.safeUint(), "pending.createdAt"),
    });
  }
  const observedNativeRevision = nonNegativeSafeInteger(
    reader.safeUint(),
    "pending.observedNativeRevision",
  );
  return Object.freeze({
    ...common,
    modality,
    observedNativeRevision,
    createdAt: nonNegativeSafeInteger(reader.safeUint(), "pending.createdAt"),
  });
}

function encodeAuthorPendingFields(
  writer: ArtifactWorkerBinaryWriter,
  input: ArtifactWorkerAuthorPendingInput,
): void {
  writer
    .u8(modalityTag(input.modality))
    .u32(positiveSafeInteger(input.protocolVersion, "author.protocolVersion"))
    .string(requireVersion(input.kernelVersion, "author.kernelVersion"), MAX_VERSION_BYTES)
    .u32(positiveSafeInteger(input.modelSchemaVersion, "author.modelSchemaVersion"))
    .u32(positiveSafeInteger(input.commandVersion, "author.commandVersion"))
    .string(requireIdentifier(input.artifactId, "author.artifactId"), MAX_ID_BYTES)
    .string(
      requireIdentifier(input.clientTransactionId, "author.clientTransactionId"),
      MAX_ID_BYTES,
    )
    .string(requireReplicaId(input.replicaId, "author.replicaId"), 16)
    .safeUint(positiveSafeInteger(input.replicaCounter, "author.replicaCounter"))
    .optionalString(
      input.previousLocalTransactionId === null
        ? null
        : requireIdentifier(input.previousLocalTransactionId, "author.previousLocalTransactionId"),
      MAX_ID_BYTES,
    )
    .safeUint(nonNegativeSafeInteger(input.observedHeadSequence, "author.observedHeadSequence"));
  if (input.modality === "spreadsheet") {
    const causalBase = input.causalBase ?? [];
    const selectiveUndoTargets = input.selectiveUndoTargets ?? [];
    writer.frontier(causalBase).u32(selectiveUndoTargets.length);
    encodeSortedIdentifiers(writer, selectiveUndoTargets, "author.selectiveUndoTargets");
  }
  writer.safeUint(input.commandBytes.byteLength);
  writer.safeUint(nonNegativeSafeInteger(input.createdAt, "author.createdAt"));
}

function decodeAuthorPendingFields(
  reader: ArtifactWorkerBinaryReader,
  commandBytes: Uint8Array,
): ArtifactWorkerAuthorPendingInput {
  const modality = decodeModality(reader.u8());
  const value: ArtifactWorkerAuthorPendingInput = {
    modality,
    protocolVersion: positiveSafeInteger(reader.u32(), "author.protocolVersion"),
    kernelVersion: requireVersion(reader.string(MAX_VERSION_BYTES), "author.kernelVersion"),
    modelSchemaVersion: positiveSafeInteger(reader.u32(), "author.modelSchemaVersion"),
    commandVersion: positiveSafeInteger(reader.u32(), "author.commandVersion"),
    artifactId: requireIdentifier(reader.string(MAX_ID_BYTES), "author.artifactId"),
    clientTransactionId: requireIdentifier(
      reader.string(MAX_ID_BYTES),
      "author.clientTransactionId",
    ),
    replicaId: requireReplicaId(reader.string(16), "author.replicaId"),
    replicaCounter: positiveSafeInteger(reader.safeUint(), "author.replicaCounter"),
    previousLocalTransactionId: optionalIdentifier(
      reader.optionalString(MAX_ID_BYTES),
      "author.previousLocalTransactionId",
    ),
    observedHeadSequence: nonNegativeSafeInteger(reader.safeUint(), "author.observedHeadSequence"),
    ...(modality === "spreadsheet"
      ? {
          causalBase: reader.frontier(),
          selectiveUndoTargets: decodeSortedIdentifiers(
            reader,
            reader.u32(),
            "author.selectiveUndoTargets",
          ),
        }
      : {}),
    commandBytes,
    createdAt: 0,
  };
  const declaredCommandBytes = reader.safeUint();
  if (declaredCommandBytes !== commandBytes.byteLength) {
    throw wireError("invalid_segment", "author command length does not match its segment");
  }
  value.createdAt = nonNegativeSafeInteger(reader.safeUint(), "author.createdAt");
  return Object.freeze(value);
}

function requireUrl(value: string, label: string): string {
  const bounded = requireBoundedString(value, label, MAX_URL_BYTES);
  let url: URL;
  try {
    url = new URL(bounded);
  } catch (error) {
    throw wireError("invalid_url", `${label} must be an absolute URL`, error);
  }
  if (!new Set(["https:", "http:", "file:"]).has(url.protocol)) {
    throw wireError("invalid_url", `${label} uses an unsupported URL scheme`);
  }
  if (url.username || url.password || url.hash) {
    throw wireError("invalid_url", `${label} must not contain credentials or a fragment`);
  }
  url.username = "";
  url.password = "";
  if (url.href !== bounded) {
    throw wireError("noncanonical", `${label} must be a canonical URL without credentials`);
  }
  return bounded;
}

function requireIdentifier(value: string, label: string): string {
  const bounded = requireBoundedString(value, label, MAX_ID_BYTES);
  if (/\p{Cc}/u.test(bounded))
    throw wireError("invalid_identifier", `${label} contains control characters`);
  return bounded;
}

function requireVersion(value: string, label: string): string {
  const bounded = requireBoundedString(value, label, MAX_VERSION_BYTES);
  if (/\p{Cc}/u.test(bounded))
    throw wireError("invalid_identifier", `${label} contains control characters`);
  return bounded;
}

function optionalIdentifier(value: string | null, label: string): string | null {
  return value === null ? null : requireIdentifier(value, label);
}

function requireReplicaId(value: string, label: string): string {
  if (!/^(?!0{16}$)[0-9a-f]{16}$/.test(value)) {
    throw wireError(
      "invalid_identifier",
      `${label} must be 16 lowercase nonzero hexadecimal digits`,
    );
  }
  return value;
}

function requireSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value))
    throw wireError("invalid_hash", `${label} must be 64 lowercase hex characters`);
  return value;
}

function requireErrorCode(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(value))
    throw wireError("invalid_error", "invalid worker error code");
  return value;
}

function requireBoundedString(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0)
    throw wireError("invalid_string", `${label} is empty`);
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw wireError("string_too_large", `${label} exceeds its byte limit`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw wireError("invalid_number", `${label} must be positive`);
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw wireError("invalid_number", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function decodeBoolean(value: number, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw wireError("noncanonical", `${label} has an invalid boolean tag`);
}

function encodeSortedIdentifiers(
  writer: ArtifactWorkerBinaryWriter,
  values: readonly string[],
  label: string,
): void {
  if (!Array.isArray(values) || values.length > 10_000) {
    throw wireError("invalid_identifiers", `${label} exceeds its item limit`);
  }
  let previous = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = requireIdentifier(values[index]!, `${label}[${index}]`);
    if (index > 0 && previous >= value) {
      throw wireError("noncanonical", `${label} must be unique and code-unit sorted`);
    }
    writer.string(value, MAX_ID_BYTES);
    previous = value;
  }
}

function decodeSortedIdentifiers(
  reader: ArtifactWorkerBinaryReader,
  count: number,
  label: string,
): readonly string[] {
  if (count > 10_000) throw wireError("invalid_identifiers", `${label} exceeds its item limit`);
  const values: string[] = [];
  let previous = "";
  for (let index = 0; index < count; index += 1) {
    const value = requireIdentifier(reader.string(MAX_ID_BYTES), `${label}[${index}]`);
    if (index > 0 && previous >= value) {
      throw wireError("noncanonical", `${label} must be unique and code-unit sorted`);
    }
    values.push(value);
    previous = value;
  }
  return Object.freeze(values);
}

function wireError(code: string, message: string, cause?: unknown): ArtifactWorkerProtocolError {
  return new ArtifactWorkerProtocolError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function validateInitializeLimits(input: ArtifactWorkerInitializeInput): void {
  requireVersion(input.kernelVersion, "kernelVersion");
  for (const [value, label] of [
    [input.protocolVersion, "protocolVersion"],
    [input.modelSchemaVersion, "modelSchemaVersion"],
    [input.commandVersion, "commandVersion"],
  ] as const) {
    positiveSafeInteger(value, label);
    if (value > 65_535) throw wireError("invalid_version", `${label} exceeds uint16`);
  }
  const limits = [
    [input.maximumSnapshotBytes, HARD_MAX_SNAPSHOT_BYTES, "maximumSnapshotBytes"],
    [input.maximumCommandBytes, HARD_MAX_COMMAND_BYTES, "maximumCommandBytes"],
    [input.maximumIntentBytes, HARD_MAX_INTENT_BYTES, "maximumIntentBytes"],
    [
      input.maximumCommittedTransactionBytes,
      HARD_MAX_COMMITTED_TRANSACTION_BYTES,
      "maximumCommittedTransactionBytes",
    ],
    [input.maximumQueryBytes, HARD_MAX_QUERY_BYTES, "maximumQueryBytes"],
    [input.maximumQueryResponseBytes, HARD_MAX_QUERY_RESPONSE_BYTES, "maximumQueryResponseBytes"],
    [input.maximumPendingTransactions, HARD_MAX_PENDING_TRANSACTIONS, "maximumPendingTransactions"],
  ] as const;
  for (const [value, maximum, label] of limits) {
    positiveSafeInteger(value, label);
    if (value > maximum)
      throw wireError("invalid_limit", `${label} exceeds the hard safety ceiling`);
  }
}
