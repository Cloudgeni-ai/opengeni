import { bytesToHex } from "@noble/hashes/utils";

import {
  ArtifactBinaryReader,
  ArtifactBinaryWriter,
  EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES,
  EDITABLE_ARTIFACT_BINARY_HEADER_BYTES,
  decodeCountedEnvelope,
  equalBytes,
  fnv1a64,
  strictUtf8,
} from "./editable-artifact-binary";
import {
  DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS,
  DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER,
} from "./document-artifact-commands";
import {
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  decodeEditableArtifactMutationIntent,
  encodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntentBytes,
  type EditableArtifactMutationIntent,
} from "./editable-artifacts";
import { editableArtifactCodecFor } from "./editable-artifact-codec-registry";

export const EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION = 1 as const;
export const EDITABLE_ARTIFACT_SERIALIZED_COMMIT_MAX_BYTES = 8 * 1024 * 1024;
export const EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES = 512 * 1024;

const MAGIC = strictUtf8("OGAST001", "serialized commit magic");
const SHA256_TEXT = /^sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^[0-9a-f]{32}$/u;
const DOCUMENT_RECEIPT_MAGIC = "OGADR001";
const PRESENTATION_RECEIPT_MAGIC = strictUtf8("OGAPR001", "presentation receipt magic");
const DOCUMENT_RECEIPT_VERSION = 1;
const PRESENTATION_RECEIPT_VERSION = 1;
const DOCUMENT_CREATED_IDS_PER_COMMAND = 7;
const DOCUMENT_ID_BYTES = 17;
const PRESENTATION_RECEIPT_BYTES = 32;
const MODALITY_TAG = Object.freeze({ document: 1, presentation: 2 } as const);

export type EditableArtifactSerializedModality = "document" | "presentation";

export type EditableArtifactNativeReceiptSummary =
  | Readonly<{
      modality: "document";
      revision: number;
      commandCount: number;
      createdIdCount: number;
    }>
  | Readonly<{
      modality: "presentation";
      revision: number;
      commandCount: number;
    }>;

export type EditableArtifactSerializedCommitInput = Readonly<{
  modality: EditableArtifactSerializedModality;
  transactionId: string;
  parentHeadSequence: number;
  resultHeadSequence: number;
  /** Native model revision before applying this non-empty command batch. */
  priorNativeRevision: number;
  priorStateHash: string;
  stateHash: string;
  /** Exact canonical OGATX001 bytes accepted by the server. */
  intentBytes: Uint8Array;
  /** Exact canonical OGADR001 or OGAPR001 bytes returned by the native kernel. */
  nativeReceiptBytes: Uint8Array;
}>;

export type EditableArtifactSerializedCommitSummary = Readonly<{
  commitProtocolVersion: typeof EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION;
  modality: EditableArtifactSerializedModality;
  transactionId: string;
  parentHeadSequence: number;
  resultHeadSequence: number;
  priorNativeRevision: number;
  priorStateHash: string;
  stateHash: string;
  requestHash: string;
  /** Canonical client intent nested in this authoritative commit. */
  intent: EditableArtifactMutationIntent;
  intentBytes: Uint8Array;
  nativeReceiptBytes: Uint8Array;
  nativeReceipt: EditableArtifactNativeReceiptSummary;
}>;

/**
 * Server-only encoder for one authoritative, strictly serialized commit.
 * Client identity remains solely in the exact nested OGATX envelope.
 */
export function encodeEditableArtifactSerializedCommit(
  input: EditableArtifactSerializedCommitInput,
): Uint8Array {
  const normalized = normalizeSerializedCommit(input);
  const payload = new ArtifactBinaryWriter(
    EDITABLE_ARTIFACT_SERIALIZED_COMMIT_MAX_BYTES -
      EDITABLE_ARTIFACT_BINARY_HEADER_BYTES -
      EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES,
  );
  payload.stableId(normalized.transactionId, "serialized transaction id");
  payload.u64(normalized.parentHeadSequence);
  payload.u64(normalized.resultHeadSequence);
  payload.u64(normalized.priorNativeRevision);
  payload.bytes(hashBytes(normalized.priorStateHash));
  payload.bytes(hashBytes(normalized.stateHash));
  payload.u32(normalized.intentBytes.byteLength);
  payload.u32(normalized.nativeReceiptBytes.byteLength);
  payload.bytes(normalized.intentBytes);
  payload.bytes(normalized.nativeReceiptBytes);

  const payloadBytes = payload.finish();
  const output = new ArtifactBinaryWriter(EDITABLE_ARTIFACT_SERIALIZED_COMMIT_MAX_BYTES);
  output.bytes(MAGIC);
  output.u16(EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION);
  output.u16(0);
  output.u32(MODALITY_TAG[normalized.modality]);
  output.u64(payloadBytes.byteLength);
  output.bytes(payloadBytes);
  output.u64(fnv1a64(output.view()));
  return output.finish();
}

/** Durable modality must be selected before any nested receipt/command decode. */
export function decodeEditableArtifactSerializedCommit(
  bytes: Uint8Array,
  durableModality: EditableArtifactSerializedModality,
): EditableArtifactSerializedCommitSummary {
  assertUnsharedBytes(bytes, "serialized commit");
  const modality = serializedModality(durableModality);
  if (bytes.byteLength > EDITABLE_ARTIFACT_SERIALIZED_COMMIT_MAX_BYTES) {
    throw new RangeError("serialized commit exceeds its byte limit");
  }
  if (
    bytes.byteLength <
    EDITABLE_ARTIFACT_BINARY_HEADER_BYTES + EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES
  ) {
    throw new TypeError("truncated serialized commit envelope");
  }
  const header = new ArtifactBinaryReader(bytes);
  if (!equalBytes(header.bytes(8), MAGIC)) {
    throw new TypeError("invalid serialized commit magic");
  }
  if (header.u16() !== EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION) {
    throw new TypeError("unsupported serialized commit version");
  }
  if (header.u16() !== 0) {
    throw new TypeError("reserved serialized commit flags must be zero");
  }
  if (header.u32() !== MODALITY_TAG[modality]) {
    throw new TypeError("serialized commit modality disagrees with durable artifact");
  }
  const payloadLength = header.u64Safe("serialized commit payload length");
  const expectedLength =
    EDITABLE_ARTIFACT_BINARY_HEADER_BYTES + payloadLength + EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES;
  if (bytes.byteLength < expectedLength) {
    throw new TypeError("truncated serialized commit payload");
  }
  if (bytes.byteLength > expectedLength) {
    throw new TypeError("serialized commit contains trailing bytes");
  }
  const payloadBytes = header.bytes(payloadLength);
  const checksum = header.u64BigInt();
  header.done();
  if (
    checksum !==
    fnv1a64(bytes.subarray(0, bytes.byteLength - EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES))
  ) {
    throw new TypeError("serialized commit checksum does not match");
  }

  const payload = new ArtifactBinaryReader(payloadBytes);
  const transactionId = payload.stableId("serialized transaction id");
  const parentHeadSequence = payload.u64Safe("serialized parent head sequence");
  const resultHeadSequence = payload.u64Safe("serialized result head sequence");
  const priorNativeRevision = payload.u64Safe("serialized prior native revision");
  const priorStateHash = stateHashText(payload.bytes(32));
  const stateHash = stateHashText(payload.bytes(32));
  const intentLength = payload.count(
    EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
    "serialized intent bytes",
    1,
  );
  const receiptLength = payload.count(
    EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES,
    "serialized native receipt bytes",
    1,
  );
  if (payload.remaining !== intentLength + receiptLength) {
    throw new TypeError("serialized commit nested byte lengths are inconsistent");
  }
  const intentBytes = payload.bytes(intentLength).slice();
  const nativeReceiptBytes = payload.bytes(receiptLength).slice();
  payload.done();

  const normalized = normalizeSerializedCommit({
    modality,
    transactionId,
    parentHeadSequence,
    resultHeadSequence,
    priorNativeRevision,
    priorStateHash,
    stateHash,
    intentBytes,
    nativeReceiptBytes,
  });
  const canonical = encodeEditableArtifactSerializedCommit(normalized);
  if (!equalBytes(bytes, canonical)) {
    throw new TypeError("serialized commit is not canonically encoded");
  }
  return Object.freeze({
    commitProtocolVersion: EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION,
    modality,
    transactionId,
    parentHeadSequence,
    resultHeadSequence,
    priorNativeRevision,
    priorStateHash,
    stateHash,
    requestHash: normalized.requestHash,
    intent: normalized.intent,
    intentBytes,
    nativeReceiptBytes,
    nativeReceipt: normalized.nativeReceipt,
  });
}

export function assertCanonicalEditableArtifactSerializedCommit(
  bytes: Uint8Array,
  durableModality: EditableArtifactSerializedModality,
): void {
  decodeEditableArtifactSerializedCommit(bytes, durableModality);
}

type NormalizedSerializedCommit = EditableArtifactSerializedCommitInput &
  Readonly<{
    requestHash: string;
    intent: EditableArtifactMutationIntent;
    nativeReceipt: EditableArtifactNativeReceiptSummary;
  }>;

function normalizeSerializedCommit(
  input: EditableArtifactSerializedCommitInput,
): NormalizedSerializedCommit {
  const modality = serializedModality(input.modality);
  const transactionId = canonicalStableId(input.transactionId, "serialized transaction id");
  const parentHeadSequence = safeSequence(
    input.parentHeadSequence,
    "serialized parent head sequence",
  );
  const resultHeadSequence = safeSequence(
    input.resultHeadSequence,
    "serialized result head sequence",
  );
  if (resultHeadSequence !== parentHeadSequence + 1) {
    throw new TypeError("serialized commit must advance the durable head exactly once");
  }
  const priorNativeRevision = safeSequence(
    input.priorNativeRevision,
    "serialized prior native revision",
  );
  const priorStateHash = canonicalSha256(input.priorStateHash, "serialized prior state hash");
  const stateHash = canonicalSha256(input.stateHash, "serialized resulting state hash");
  assertUnsharedBytes(input.intentBytes, "serialized intent");
  assertUnsharedBytes(input.nativeReceiptBytes, "serialized native receipt");
  if (
    input.intentBytes.byteLength < 1 ||
    input.intentBytes.byteLength > EDITABLE_ARTIFACT_INTENT_MAX_BYTES
  ) {
    throw new RangeError("serialized intent bytes exceed their limit");
  }
  if (
    input.nativeReceiptBytes.byteLength < 1 ||
    input.nativeReceiptBytes.byteLength > EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES
  ) {
    throw new RangeError("serialized native receipt bytes exceed their limit");
  }
  const intentBytes = input.intentBytes.slice();
  const decodedIntent = decodeEditableArtifactMutationIntent(intentBytes);
  if (!equalBytes(intentBytes, encodeEditableArtifactMutationIntent(decodedIntent))) {
    throw new TypeError("nested serialized intent is not canonical OGATX001");
  }
  if (
    decodedIntent.causalBase.length !== 0 ||
    decodedIntent.selectiveUndoOperationIds.length !== 0
  ) {
    throw new TypeError("serialized commits cannot carry CRDT causality or selective undo");
  }
  if (decodedIntent.observedHeadSequence !== parentHeadSequence) {
    throw new TypeError("serialized intent observed head does not match its parent");
  }
  const descriptor = editableArtifactCodecFor({
    durableModality: modality,
    modelSchemaVersion: decodedIntent.modelSchemaVersion,
    commandProtocolVersion: decodedIntent.commandProtocolVersion,
  });
  descriptor.command.assertCanonical(decodedIntent.commandBytes);
  const commandCount = decodedCommandCount(descriptor.command.decode(decodedIntent.commandBytes));
  if (commandCount < 1) {
    throw new TypeError("serialized commits require a non-empty command batch");
  }
  const nativeReceiptBytes = input.nativeReceiptBytes.slice();
  const nativeReceipt = decodeNativeReceipt(modality, nativeReceiptBytes, commandCount);
  if (modality === "presentation") {
    if (nativeReceipt.revision !== priorNativeRevision + 1) {
      throw new TypeError(
        "presentation receipt must advance its prior native revision exactly once",
      );
    }
    if (stateHash === priorStateHash) {
      throw new TypeError("presentation commit must change its canonical state hash");
    }
  } else if (nativeReceipt.revision === priorNativeRevision) {
    if (stateHash !== priorStateHash) {
      throw new TypeError("document no-op receipt cannot change the canonical state hash");
    }
  } else {
    if (nativeReceipt.revision !== priorNativeRevision + 1) {
      throw new TypeError(
        "document receipt must preserve or advance its prior native revision once",
      );
    }
    if (stateHash === priorStateHash) {
      throw new TypeError("document revision advance must change the canonical state hash");
    }
  }
  const requestHash = hashEditableArtifactMutationIntentBytes(intentBytes);
  return Object.freeze({
    modality,
    transactionId,
    parentHeadSequence,
    resultHeadSequence,
    priorNativeRevision,
    priorStateHash,
    stateHash,
    intentBytes,
    nativeReceiptBytes,
    requestHash,
    intent: decodedIntent,
    nativeReceipt,
  });
}

function decodeNativeReceipt(
  modality: EditableArtifactSerializedModality,
  bytes: Uint8Array,
  expectedCommandCount: number,
): EditableArtifactNativeReceiptSummary {
  return modality === "document"
    ? decodeDocumentReceipt(bytes, expectedCommandCount)
    : decodePresentationReceipt(bytes, expectedCommandCount);
}

function decodeDocumentReceipt(
  bytes: Uint8Array,
  expectedCommandCount: number,
): Extract<EditableArtifactNativeReceiptSummary, { modality: "document" }> {
  const envelope = decodeCountedEnvelope(
    bytes,
    DOCUMENT_RECEIPT_MAGIC,
    DOCUMENT_RECEIPT_VERSION,
    EDITABLE_ARTIFACT_NATIVE_RECEIPT_MAX_BYTES,
    DOCUMENT_ARTIFACT_COMMAND_MAX_COMMANDS,
  );
  const payload = new ArtifactBinaryReader(envelope.payload);
  const revision = payload.u64Safe("document receipt revision");
  const commandCount = payload.u32();
  if (commandCount !== envelope.count || commandCount !== expectedCommandCount) {
    throw new TypeError("document receipt command count does not match its intent");
  }
  const maximumCreatedIds = commandCount * DOCUMENT_CREATED_IDS_PER_COMMAND;
  const createdIdCount = payload.count(
    maximumCreatedIds,
    "document receipt created ids",
    DOCUMENT_ID_BYTES,
  );
  for (let index = 0; index < createdIdCount; index += 1) {
    const tag = payload.u8();
    if (tag < 1 || tag > 8) {
      throw new TypeError("document receipt contains an invalid id kind");
    }
    payload.u64BigInt();
    const counter = payload.u64BigInt();
    if (counter === 0n || counter > BigInt(DOCUMENT_ARTIFACT_MAX_STRUCTURAL_COUNTER)) {
      throw new TypeError("document receipt contains an invalid id counter");
    }
  }
  payload.done("document receipt contains trailing bytes");
  return Object.freeze({
    modality: "document",
    revision,
    commandCount,
    createdIdCount,
  });
}

function decodePresentationReceipt(
  bytes: Uint8Array,
  expectedCommandCount: number,
): Extract<EditableArtifactNativeReceiptSummary, { modality: "presentation" }> {
  if (bytes.byteLength !== PRESENTATION_RECEIPT_BYTES) {
    throw new TypeError(
      bytes.byteLength < PRESENTATION_RECEIPT_BYTES
        ? "truncated presentation receipt"
        : "presentation receipt contains trailing bytes",
    );
  }
  const reader = new ArtifactBinaryReader(bytes);
  if (!equalBytes(reader.bytes(8), PRESENTATION_RECEIPT_MAGIC)) {
    throw new TypeError("invalid presentation receipt magic");
  }
  if (reader.u16() !== PRESENTATION_RECEIPT_VERSION) {
    throw new TypeError("unsupported presentation receipt version");
  }
  if (reader.u16() !== 0) {
    throw new TypeError("reserved presentation receipt flags must be zero");
  }
  const revision = reader.u64Safe("presentation receipt revision");
  const commandCount = reader.u32();
  if (commandCount !== expectedCommandCount) {
    throw new TypeError("presentation receipt command count does not match its intent");
  }
  const checksum = reader.u64BigInt();
  reader.done();
  if (
    checksum !==
    fnv1a64(bytes.subarray(0, bytes.byteLength - EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES))
  ) {
    throw new TypeError("presentation receipt checksum does not match");
  }
  return Object.freeze({ modality: "presentation", revision, commandCount });
}

function decodedCommandCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("serialized command decoder returned an invalid batch");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "commands");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) {
    throw new TypeError("serialized command decoder returned an invalid batch");
  }
  return descriptor.value.length;
}

function serializedModality(value: unknown): EditableArtifactSerializedModality {
  if (value !== "document" && value !== "presentation") {
    throw new TypeError("serialized commit modality is invalid");
  }
  return value;
}

function canonicalStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value) || /^0+$/u.test(value)) {
    throw new TypeError(`${label} must be a nonzero lowercase 128-bit hexadecimal id`);
  }
  return value;
}

function canonicalSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_TEXT.test(value)) {
    throw new TypeError(`${label} must be canonical sha256 text`);
  }
  return value;
}

function safeSequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function hashBytes(value: string): Uint8Array {
  const hex = value.slice("sha256:".length);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function stateHashText(value: Uint8Array): string {
  return `sha256:${bytesToHex(value)}`;
}

function assertUnsharedBytes(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} bytes must be a Uint8Array`);
  }
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} bytes must not use shared mutable memory`);
  }
}
