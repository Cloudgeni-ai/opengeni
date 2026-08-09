import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export * from "./spreadsheet-artifact-commands";
export * from "./spreadsheet-artifact-query";
export * from "./editable-artifact-causal-frontier";
export * from "./document-artifact-commands";
export * from "./presentation-artifact-commands";
export * from "./editable-artifact-codec-registry";

export const EDITABLE_ARTIFACT_INTENT_VERSION = 1 as const;
export const EDITABLE_ARTIFACT_INTENT_MAX_BYTES = 5 * 1024 * 1024;
export const EDITABLE_ARTIFACT_COMMAND_MAX_BYTES = 4 * 1024 * 1024;
export const EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES = 512;
/** Largest durable snapshot every supported browser/WASM client can open. */
export const EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const EDITABLE_ARTIFACT_INTENT_MAX_CAUSAL_ACTORS = 1_024;
export const EDITABLE_ARTIFACT_INTENT_MAX_UNDO_TARGETS = 10_000;

const MAGIC = new TextEncoder().encode("OGATX001");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const STABLE_ID = /^[0-9a-f]{32}$/u;
const REPLICA_ID = /^[0-9a-f]{16}$/u;
const CLIENT_TRANSACTION_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const REQUEST_HASH = /^sha256:[0-9a-f]{64}$/u;

export type EditableArtifactCausalEntry = Readonly<{
  replicaId: string;
  counter: number;
}>;

/**
 * Exact client-authored mutation identity. Scope and actor authority are
 * deliberately absent: the server derives them and binds them in the
 * idempotency lookup tuple instead of trusting client bytes.
 */
export type EditableArtifactMutationIntent = Readonly<{
  envelopeVersion: typeof EDITABLE_ARTIFACT_INTENT_VERSION;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandProtocolVersion: number;
  artifactId: string;
  clientTransactionId: string;
  replicaId: string;
  replicaCounter: number;
  previousLocalTransactionId: string | null;
  observedHeadSequence: number;
  causalBase: readonly EditableArtifactCausalEntry[];
  selectiveUndoOperationIds: readonly string[];
  commandBytes: Uint8Array;
}>;

export function encodeEditableArtifactMutationIntent(
  input: EditableArtifactMutationIntent,
): Uint8Array {
  // The writer owns the emitted bytes, so a second eager copy of a potentially
  // multi-megabyte command block would add no safety.
  const intent = normalizeIntent(input, false);
  const writer = new BinaryWriter(EDITABLE_ARTIFACT_INTENT_MAX_BYTES);
  writer.bytes(MAGIC);
  writer.u16(intent.envelopeVersion);
  writer.u16(intent.protocolVersion);
  writer.u16(intent.modelSchemaVersion);
  writer.u16(intent.commandProtocolVersion);
  writer.string(intent.artifactId);
  writer.string(intent.clientTransactionId);
  writer.string(intent.replicaId);
  writer.u64(intent.replicaCounter);
  writer.u8(intent.previousLocalTransactionId === null ? 0 : 1);
  if (intent.previousLocalTransactionId !== null) {
    writer.string(intent.previousLocalTransactionId);
  }
  writer.u64(intent.observedHeadSequence);
  writer.u16(intent.causalBase.length);
  for (const entry of intent.causalBase) {
    writer.string(entry.replicaId);
    writer.u64(entry.counter);
  }
  writer.u16(intent.selectiveUndoOperationIds.length);
  for (const operationId of intent.selectiveUndoOperationIds) writer.string(operationId);
  writer.byteBlock(intent.commandBytes);
  return writer.finish();
}

export function decodeEditableArtifactMutationIntent(
  bytes: Uint8Array,
): EditableArtifactMutationIntent {
  return parseEditableArtifactMutationIntent(bytes, true);
}

function parseEditableArtifactMutationIntent(
  bytes: Uint8Array,
  copyCommandBytes: boolean,
): EditableArtifactMutationIntent {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("intent bytes must be a Uint8Array");
  if (bytes.byteLength > EDITABLE_ARTIFACT_INTENT_MAX_BYTES) {
    throw new RangeError("editable artifact intent exceeds its byte limit");
  }
  const reader = new BinaryReader(bytes);
  const magic = reader.bytes(MAGIC.byteLength);
  if (!equalBytes(magic, MAGIC)) throw new TypeError("invalid editable artifact intent magic");
  const envelopeVersion = reader.u16();
  if (envelopeVersion !== EDITABLE_ARTIFACT_INTENT_VERSION) {
    throw new TypeError(`unsupported editable artifact intent version: ${envelopeVersion}`);
  }
  const protocolVersion = reader.u16();
  const modelSchemaVersion = reader.u16();
  const commandProtocolVersion = reader.u16();
  const artifactId = reader.string();
  const clientTransactionId = reader.string();
  const replicaId = reader.string();
  const replicaCounter = reader.u64();
  const predecessorFlag = reader.u8();
  if (predecessorFlag > 1) throw new TypeError("invalid predecessor presence flag");
  const previousLocalTransactionId = predecessorFlag === 1 ? reader.string() : null;
  const observedHeadSequence = reader.u64();
  const causalCount = reader.u16();
  if (causalCount > EDITABLE_ARTIFACT_INTENT_MAX_CAUSAL_ACTORS) {
    throw new RangeError("editable artifact causal base exceeds its actor limit");
  }
  const causalBase: EditableArtifactCausalEntry[] = [];
  let previousReplicaId = "";
  for (let index = 0; index < causalCount; index += 1) {
    const causalReplicaId = reader.string();
    if (causalReplicaId <= previousReplicaId) {
      throw new TypeError("causal base replica ids must be unique and canonically sorted");
    }
    previousReplicaId = causalReplicaId;
    causalBase.push(Object.freeze({ replicaId: causalReplicaId, counter: reader.u64() }));
  }
  const undoCount = reader.u16();
  if (undoCount > EDITABLE_ARTIFACT_INTENT_MAX_UNDO_TARGETS) {
    throw new RangeError("editable artifact undo targets exceed their limit");
  }
  const selectiveUndoOperationIds: string[] = [];
  let previousOperationId = "";
  for (let index = 0; index < undoCount; index += 1) {
    const operationId = reader.string();
    if (operationId <= previousOperationId) {
      throw new TypeError("undo operation ids must be unique and canonically sorted");
    }
    previousOperationId = operationId;
    selectiveUndoOperationIds.push(operationId);
  }
  const commandBytes = reader.byteBlock(EDITABLE_ARTIFACT_COMMAND_MAX_BYTES);
  reader.done();
  return normalizeIntent(
    {
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion,
      modelSchemaVersion,
      commandProtocolVersion,
      artifactId,
      clientTransactionId,
      replicaId,
      replicaCounter,
      previousLocalTransactionId,
      observedHeadSequence,
      causalBase,
      selectiveUndoOperationIds,
      commandBytes,
    },
    copyCommandBytes,
  );
}

export function hashEditableArtifactMutationIntentBytes(bytes: Uint8Array): string {
  // Decode first so noncanonical or malformed bytes can never acquire a valid
  // application-level request hash merely because SHA-256 accepts any bytes.
  parseEditableArtifactMutationIntent(bytes, false);
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

export function hashEditableArtifactMutationIntent(intent: EditableArtifactMutationIntent): {
  bytes: Uint8Array;
  requestHash: string;
} {
  const bytes = encodeEditableArtifactMutationIntent(intent);
  return { bytes, requestHash: `sha256:${bytesToHex(sha256(bytes))}` };
}

export function assertEditableArtifactRequestHash(value: string): string {
  if (!REQUEST_HASH.test(value)) {
    throw new TypeError("editable artifact request hash must be canonical sha256 text");
  }
  return value;
}

function normalizeIntent(
  input: EditableArtifactMutationIntent,
  copyCommandBytes = true,
): EditableArtifactMutationIntent {
  if (!isPlainRecord(input)) throw new TypeError("editable artifact intent must be a plain record");
  if (input.envelopeVersion !== EDITABLE_ARTIFACT_INTENT_VERSION) {
    throw new TypeError("editable artifact intent envelope version must be 1");
  }
  const protocolVersion = positiveU16(input.protocolVersion, "protocolVersion");
  const modelSchemaVersion = positiveU16(input.modelSchemaVersion, "modelSchemaVersion");
  const commandProtocolVersion = positiveU16(
    input.commandProtocolVersion,
    "commandProtocolVersion",
  );
  const artifactId = stableId(input.artifactId, "artifactId");
  const clientTransactionId = portableTransactionId(
    input.clientTransactionId,
    "clientTransactionId",
  );
  const replicaId = replicaIdentity(input.replicaId, "replicaId");
  const replicaCounter = positiveSafeInteger(input.replicaCounter, "replicaCounter");
  const previousLocalTransactionId =
    input.previousLocalTransactionId === null
      ? null
      : portableTransactionId(input.previousLocalTransactionId, "previousLocalTransactionId");
  const observedHeadSequence = nonnegativeSafeInteger(
    input.observedHeadSequence,
    "observedHeadSequence",
  );
  if (!Array.isArray(input.causalBase)) throw new TypeError("causalBase must be an array");
  if (input.causalBase.length > EDITABLE_ARTIFACT_INTENT_MAX_CAUSAL_ACTORS) {
    throw new RangeError("editable artifact causal base exceeds its actor limit");
  }
  const causalByReplica = new Map<string, number>();
  for (const entry of input.causalBase) {
    if (!isPlainRecord(entry)) throw new TypeError("causal entries must be plain records");
    const causalReplicaId = replicaIdentity(entry.replicaId, "causal replicaId");
    if (causalByReplica.has(causalReplicaId)) throw new TypeError("duplicate causal replicaId");
    causalByReplica.set(
      causalReplicaId,
      positiveSafeInteger(entry.counter, `causal counter for ${causalReplicaId}`),
    );
  }
  const causalBase = [...causalByReplica]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([causalReplicaId, counter]) => Object.freeze({ replicaId: causalReplicaId, counter }));
  if (!Array.isArray(input.selectiveUndoOperationIds)) {
    throw new TypeError("selectiveUndoOperationIds must be an array");
  }
  if (input.selectiveUndoOperationIds.length > EDITABLE_ARTIFACT_INTENT_MAX_UNDO_TARGETS) {
    throw new RangeError("editable artifact undo targets exceed their limit");
  }
  const undoSet = new Set<string>();
  for (const value of input.selectiveUndoOperationIds) {
    const operationId = stableId(value, "selective undo operation id");
    if (undoSet.has(operationId)) throw new TypeError("duplicate selective undo operation id");
    undoSet.add(operationId);
  }
  const selectiveUndoOperationIds = [...undoSet].sort(compareCodeUnits);
  if (!(input.commandBytes instanceof Uint8Array)) {
    throw new TypeError("commandBytes must be a Uint8Array");
  }
  if (input.commandBytes.byteLength < 1) throw new TypeError("commandBytes must not be empty");
  if (input.commandBytes.byteLength > EDITABLE_ARTIFACT_COMMAND_MAX_BYTES) {
    throw new RangeError("commandBytes exceeds its byte limit");
  }
  return Object.freeze({
    envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
    protocolVersion,
    modelSchemaVersion,
    commandProtocolVersion,
    artifactId,
    clientTransactionId,
    replicaId,
    replicaCounter,
    previousLocalTransactionId,
    observedHeadSequence,
    causalBase: Object.freeze(causalBase),
    selectiveUndoOperationIds: Object.freeze(selectiveUndoOperationIds),
    commandBytes: copyCommandBytes ? input.commandBytes.slice() : input.commandBytes,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value) || /^0+$/u.test(value)) {
    throw new TypeError(`${label} must be nonzero fixed-width lowercase hexadecimal text`);
  }
  return value;
}

function replicaIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !REPLICA_ID.test(value) || /^0+$/u.test(value)) {
    throw new TypeError(`${label} must be nonzero 64-bit lowercase hexadecimal text`);
  }
  return value;
}

function portableTransactionId(value: unknown, label: string): string {
  if (typeof value !== "string" || !CLIENT_TRANSACTION_ID.test(value)) {
    throw new TypeError(`${label} must contain 1-200 portable identifier characters`);
  }
  return value;
}

function positiveU16(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 0xffff) {
    throw new TypeError(`${label} must be a positive 16-bit integer`);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

class BinaryWriter {
  private buffer = new Uint8Array(1_024);
  private length = 0;

  constructor(private readonly maximum: number) {}

  u8(value: number): void {
    this.ensure(1);
    this.buffer[this.length++] = value;
  }

  u16(value: number): void {
    this.ensure(2);
    this.buffer[this.length++] = value & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
  }

  u32(value: number): void {
    this.ensure(4);
    for (let offset = 0; offset < 4; offset += 1) {
      this.buffer[this.length++] = Math.floor(value / 2 ** (offset * 8)) & 0xff;
    }
  }

  u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("u64 must be safe");
    this.ensure(8);
    let remaining = BigInt(value);
    for (let offset = 0; offset < 8; offset += 1) {
      this.buffer[this.length++] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
  }

  string(value: string): void {
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength > 0xffff) throw new RangeError("intent string exceeds 65535 bytes");
    this.u16(bytes.byteLength);
    this.bytes(bytes);
  }

  byteBlock(value: Uint8Array): void {
    this.u32(value.byteLength);
    this.bytes(value);
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private ensure(additional: number): void {
    const needed = this.length + additional;
    if (!Number.isSafeInteger(needed) || needed > this.maximum) {
      throw new RangeError("editable artifact intent exceeds its byte limit");
    }
    if (needed <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength;
    while (size < needed) size = Math.min(this.maximum, size * 2);
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  u8(): number {
    this.require(1);
    return this.input[this.offset++]!;
  }

  u16(): number {
    this.require(2);
    const value = this.input[this.offset]! | (this.input[this.offset + 1]! << 8);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value =
      this.input[this.offset]! +
      this.input[this.offset + 1]! * 2 ** 8 +
      this.input[this.offset + 2]! * 2 ** 16 +
      this.input[this.offset + 3]! * 2 ** 24;
    this.offset += 4;
    return value;
  }

  u64(): number {
    this.require(8);
    let value = 0n;
    for (let offset = 0; offset < 8; offset += 1) {
      value |= BigInt(this.input[this.offset + offset]!) << BigInt(offset * 8);
    }
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("u64 exceeds safe integer");
    return Number(value);
  }

  string(): string {
    return textDecoder.decode(this.bytes(this.u16()));
  }

  byteBlock(maximum: number): Uint8Array {
    const length = this.u32();
    if (length < 1) throw new TypeError("commandBytes must not be empty");
    if (length > maximum) throw new RangeError("commandBytes exceeds its byte limit");
    return this.bytes(length);
  }

  bytes(length: number): Uint8Array {
    this.require(length);
    const output = this.input.subarray(this.offset, this.offset + length);
    this.offset += length;
    return output;
  }

  done(): void {
    if (this.offset !== this.input.byteLength) {
      throw new TypeError("editable artifact intent contains trailing bytes");
    }
  }

  private require(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.input.byteLength
    ) {
      throw new TypeError("truncated editable artifact intent");
    }
  }
}
