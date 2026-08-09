const FRAME_MAGIC = new Uint8Array([0x4f, 0x47, 0x41, 0x57, 0x52, 0x50, 0x43, 0x31]); // OGAWRPC1
const FRAME_HEADER_BYTES = 36;
const FRAME_VERSION = 1;
const DEFAULT_MAX_METADATA_BYTES = 1024 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SEGMENT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 4_096;

export const enum ArtifactWorkerRpcKind {
  Initialize = 1,
  Reset = 2,
  LoadSnapshot = 3,
  ApplyRecovered = 4,
  ReconcileCommitted = 5,
  ReplacePending = 6,
  AuthorPending = 7,
  Cancel = 8,
  Dispose = 9,
  QuerySpreadsheet = 10,
  Response = 128,
  Error = 129,
}

export type ArtifactWorkerRpcMessage = {
  frame: ArrayBuffer;
  segments: ArrayBuffer[];
};

export type ArtifactWorkerRpcLimits = {
  maxMetadataBytes: number;
  maxSegmentBytes: number;
  maxTotalSegmentBytes: number;
  maxSegments: number;
};

export type DecodedArtifactWorkerRpcFrame = {
  kind: ArtifactWorkerRpcKind;
  generation: number;
  requestId: number;
  flags: number;
  metadata: Uint8Array;
  segments: Uint8Array[];
};

export const DEFAULT_ARTIFACT_WORKER_RPC_LIMITS: Readonly<ArtifactWorkerRpcLimits> = Object.freeze({
  maxMetadataBytes: DEFAULT_MAX_METADATA_BYTES,
  maxSegmentBytes: DEFAULT_MAX_SEGMENT_BYTES,
  maxTotalSegmentBytes: DEFAULT_MAX_TOTAL_SEGMENT_BYTES,
  maxSegments: DEFAULT_MAX_SEGMENTS,
});

export class ArtifactWorkerProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactWorkerProtocolError";
    this.code = code;
  }
}

export function encodeArtifactWorkerRpcMessage(input: {
  kind: ArtifactWorkerRpcKind;
  generation: number;
  requestId: number;
  flags?: number;
  metadata?: Uint8Array;
  /** Every buffer must already be exclusively owned by this message. */
  segments?: ArrayBuffer[];
  limits?: Readonly<ArtifactWorkerRpcLimits>;
}): ArtifactWorkerRpcMessage {
  const limits = validateLimits(input.limits ?? DEFAULT_ARTIFACT_WORKER_RPC_LIMITS);
  const generation = unsignedInt(input.generation, "generation");
  const requestId = unsignedInt(input.requestId, "requestId");
  if (generation === 0 || requestId === 0) {
    throw protocolError("invalid_number", "generation and requestId must be nonzero");
  }
  const flags = unsignedInt(input.flags ?? 0, "flags");
  const kind = unsignedShort(input.kind, "kind");
  if (!isKnownKind(kind)) throw protocolError("unknown_kind", `unknown RPC kind ${kind}`);
  const metadata = input.metadata ?? new Uint8Array();
  if (!(metadata instanceof Uint8Array))
    throw protocolError("invalid_frame", "metadata must be bytes");
  if (metadata.byteLength > limits.maxMetadataBytes) {
    throw protocolError("metadata_too_large", "RPC metadata exceeds its configured byte limit");
  }
  const segments = input.segments ?? [];
  if (
    !Array.isArray(segments) ||
    segments.length > limits.maxSegments ||
    segments.length > 0xffff
  ) {
    throw protocolError("segments_too_large", "RPC segment count exceeds its configured limit");
  }
  let totalSegmentBytes = 0;
  const uniqueSegments = new Set<ArrayBuffer>();
  for (const segment of segments) {
    if (!(segment instanceof ArrayBuffer)) {
      throw protocolError("invalid_segment", "RPC segments must be transferable ArrayBuffers");
    }
    if (segment.byteLength > limits.maxSegmentBytes) {
      throw protocolError("segment_too_large", "RPC segment exceeds its configured byte limit");
    }
    if (uniqueSegments.has(segment)) {
      throw protocolError("invalid_segment", "RPC segments must not alias one transferable buffer");
    }
    uniqueSegments.add(segment);
    totalSegmentBytes = checkedAdd(totalSegmentBytes, segment.byteLength, "RPC segment bytes");
    if (totalSegmentBytes > limits.maxTotalSegmentBytes) {
      throw protocolError("segments_too_large", "RPC segments exceed their aggregate byte limit");
    }
  }

  const segmentTableBytes = checkedMultiply(segments.length, 4, "RPC segment table");
  const frameBytes = checkedAdd(
    checkedAdd(FRAME_HEADER_BYTES, metadata.byteLength, "RPC frame"),
    segmentTableBytes,
    "RPC frame",
  );
  const frame = new Uint8Array(frameBytes);
  const view = new DataView(frame.buffer);
  frame.set(FRAME_MAGIC, 0);
  view.setUint16(8, FRAME_VERSION, true);
  view.setUint16(10, kind, true);
  view.setUint32(12, generation, true);
  view.setUint32(16, requestId, true);
  view.setUint32(20, flags, true);
  view.setUint32(24, metadata.byteLength, true);
  view.setUint16(28, segments.length, true);
  view.setUint16(30, 0, true);
  view.setUint32(32, 0, true);
  frame.set(metadata, FRAME_HEADER_BYTES);
  let offset = FRAME_HEADER_BYTES + metadata.byteLength;
  for (const segment of segments) {
    view.setUint32(offset, segment.byteLength, true);
    offset += 4;
  }
  view.setUint32(32, checksum32(frame), true);
  return { frame: frame.buffer, segments };
}

export function decodeArtifactWorkerRpcMessage(
  input: unknown,
  limitsInput: Readonly<ArtifactWorkerRpcLimits> = DEFAULT_ARTIFACT_WORKER_RPC_LIMITS,
): DecodedArtifactWorkerRpcFrame {
  const limits = validateLimits(limitsInput);
  if (!isPlainRecord(input)) throw protocolError("invalid_frame", "RPC message must be a record");
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("frame") || !keys.includes("segments")) {
    throw protocolError("invalid_frame", "RPC message contains unknown or missing fields");
  }
  const frameBuffer = dataProperty(input, "frame");
  const rawSegments = dataProperty(input, "segments");
  if (!(frameBuffer instanceof ArrayBuffer)) {
    throw protocolError("invalid_frame", "RPC frame must be a transferable ArrayBuffer");
  }
  if (!Array.isArray(rawSegments))
    throw protocolError("invalid_frame", "RPC segments must be an array");
  if (frameBuffer.byteLength < FRAME_HEADER_BYTES)
    throw protocolError("truncated", "RPC frame is truncated");
  if (
    frameBuffer.byteLength >
    FRAME_HEADER_BYTES + limits.maxMetadataBytes + limits.maxSegments * 4
  ) {
    throw protocolError("metadata_too_large", "RPC frame exceeds its configured byte limit");
  }
  const frame = new Uint8Array(frameBuffer);
  for (let index = 0; index < FRAME_MAGIC.length; index += 1) {
    if (frame[index] !== FRAME_MAGIC[index])
      throw protocolError("bad_magic", "invalid RPC frame magic");
  }
  const view = new DataView(frameBuffer);
  const version = view.getUint16(8, true);
  if (version !== FRAME_VERSION) {
    throw protocolError("unsupported_version", `unsupported RPC frame version ${version}`);
  }
  const kind = view.getUint16(10, true);
  if (!isKnownKind(kind)) throw protocolError("unknown_kind", `unknown RPC kind ${kind}`);
  const generation = view.getUint32(12, true);
  const requestId = view.getUint32(16, true);
  if (generation === 0 || requestId === 0) {
    throw protocolError("noncanonical", "generation and requestId must be nonzero");
  }
  const flags = view.getUint32(20, true);
  const metadataBytes = view.getUint32(24, true);
  const segmentCount = view.getUint16(28, true);
  if (view.getUint16(30, true) !== 0) {
    throw protocolError("noncanonical", "reserved RPC frame bits are set");
  }
  if (metadataBytes > limits.maxMetadataBytes) {
    throw protocolError("metadata_too_large", "RPC metadata exceeds its configured byte limit");
  }
  if (segmentCount > limits.maxSegments || rawSegments.length !== segmentCount) {
    throw protocolError("invalid_segment", "RPC segment count does not match its frame");
  }
  const expectedFrameBytes = checkedAdd(
    checkedAdd(FRAME_HEADER_BYTES, metadataBytes, "RPC frame"),
    checkedMultiply(segmentCount, 4, "RPC segment table"),
    "RPC frame",
  );
  if (frame.byteLength !== expectedFrameBytes) {
    throw protocolError("trailing_bytes", "RPC frame has a truncated or trailing payload");
  }
  const expectedChecksum = view.getUint32(32, true);
  view.setUint32(32, 0, true);
  const actualChecksum = checksum32(frame);
  view.setUint32(32, expectedChecksum, true);
  if (expectedChecksum !== actualChecksum) {
    throw protocolError("checksum_mismatch", "RPC frame checksum does not match");
  }
  const segments: Uint8Array[] = [];
  const uniqueBuffers = new Set<ArrayBuffer>([frameBuffer]);
  let totalSegmentBytes = 0;
  let tableOffset = FRAME_HEADER_BYTES + metadataBytes;
  for (let index = 0; index < segmentCount; index += 1) {
    const expectedBytes = view.getUint32(tableOffset, true);
    tableOffset += 4;
    const segment = rawSegments[index];
    if (!(segment instanceof ArrayBuffer) || segment.byteLength !== expectedBytes) {
      throw protocolError(
        "invalid_segment",
        `RPC segment ${index} does not match its declared length`,
      );
    }
    if (uniqueBuffers.has(segment)) {
      throw protocolError("invalid_segment", "RPC frame and segments must use distinct buffers");
    }
    uniqueBuffers.add(segment);
    if (segment.byteLength > limits.maxSegmentBytes) {
      throw protocolError("segment_too_large", `RPC segment ${index} exceeds its configured limit`);
    }
    totalSegmentBytes = checkedAdd(totalSegmentBytes, segment.byteLength, "RPC segment bytes");
    if (totalSegmentBytes > limits.maxTotalSegmentBytes) {
      throw protocolError("segments_too_large", "RPC segments exceed their aggregate byte limit");
    }
    segments.push(new Uint8Array(segment));
  }
  return {
    kind: kind as ArtifactWorkerRpcKind,
    generation,
    requestId,
    flags,
    metadata: frame.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + metadataBytes),
    segments,
  };
}

export function transferListForArtifactWorkerRpcMessage(
  message: ArtifactWorkerRpcMessage,
): Transferable[] {
  return [message.frame, ...message.segments];
}

/** Creates a private transferable copy; transferring never detaches caller-owned bytes. */
export function ownedTransferBuffer(bytes: Uint8Array): ArrayBuffer {
  if (!(bytes instanceof Uint8Array))
    throw protocolError("invalid_segment", "expected byte segment");
  return bytes.slice().buffer;
}

export class ArtifactWorkerBinaryWriter {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly maximumBytes = DEFAULT_MAX_METADATA_BYTES) {
    positiveSafeInteger(maximumBytes, "maximumBytes");
  }

  u8(value: number): this {
    unsignedByte(value, "u8");
    return this.append(new Uint8Array([value]));
  }

  u16(value: number): this {
    unsignedShort(value, "u16");
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return this.append(bytes);
  }

  u32(value: number): this {
    unsignedInt(value, "u32");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return this.append(bytes);
  }

  safeUint(value: number): this {
    nonNegativeSafeInteger(value, "safeUint");
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return this.append(bytes);
  }

  f64(value: number): this {
    if (!Number.isFinite(value)) throw protocolError("invalid_number", "f64 must be finite");
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return this.append(bytes);
  }

  string(value: string, maximumBytes = 256 * 1024): this {
    if (typeof value !== "string") throw protocolError("invalid_string", "expected a string");
    if (!isWellFormedUnicode(value)) {
      throw protocolError("invalid_string", "string contains an unpaired UTF-16 surrogate");
    }
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > maximumBytes)
      throw protocolError("string_too_large", "string exceeds its byte limit");
    this.u32(bytes.byteLength);
    return this.append(bytes);
  }

  optionalString(value: string | null, maximumBytes = 256 * 1024): this {
    this.u8(value === null ? 0 : 1);
    if (value !== null) this.string(value, maximumBytes);
    return this;
  }

  frontier(
    value: readonly Readonly<{ replicaId: string; counter: number }>[],
    maximumActors = 1_024,
  ): this {
    const entries = validateFrontier(value, maximumActors);
    this.u32(entries.length);
    for (const [actor, counter] of entries) {
      this.string(actor, 256);
      this.safeUint(counter);
    }
    return this;
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  private append(bytes: Uint8Array): this {
    this.size = checkedAdd(this.size, bytes.byteLength, "binary metadata");
    if (this.size > this.maximumBytes) {
      throw protocolError("metadata_too_large", "binary metadata exceeds its configured limit");
    }
    this.chunks.push(bytes);
    return this;
  }
}

export class ArtifactWorkerBinaryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array))
      throw protocolError("invalid_frame", "metadata must be bytes");
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  safeUint(): number {
    this.require(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw protocolError("invalid_number", "RPC unsigned integer exceeds JavaScript safe range");
    }
    return Number(value);
  }

  f64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    if (!Number.isFinite(value)) throw protocolError("invalid_number", "non-finite RPC number");
    return value;
  }

  string(maximumBytes = 256 * 1024): string {
    const length = this.u32();
    if (length > maximumBytes)
      throw protocolError("string_too_large", "RPC string exceeds its byte limit");
    this.require(length);
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw protocolError("invalid_utf8", "RPC string is not valid UTF-8", error);
    }
  }

  optionalString(maximumBytes = 256 * 1024): string | null {
    const present = this.u8();
    if (present === 0) return null;
    if (present !== 1) throw protocolError("noncanonical", "invalid optional-string tag");
    return this.string(maximumBytes);
  }

  frontier(maximumActors = 1_024): readonly Readonly<{ replicaId: string; counter: number }>[] {
    const count = this.u32();
    if (count > maximumActors)
      throw protocolError("frontier_too_large", "causal frontier exceeds its actor limit");
    const entries: Array<Readonly<{ replicaId: string; counter: number }>> = [];
    let previous = "";
    for (let index = 0; index < count; index += 1) {
      const actor = this.string(256);
      if (!actor || (index > 0 && compareCodeUnits(previous, actor) >= 0)) {
        throw protocolError(
          "noncanonical",
          "causal frontier actors must be unique and code-unit sorted",
        );
      }
      const counter = this.safeUint();
      entries.push(Object.freeze({ replicaId: actor, counter }));
      previous = actor;
    }
    return Object.freeze(entries);
  }

  done(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw protocolError("trailing_bytes", "RPC metadata contains trailing bytes");
    }
  }

  remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  private require(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw protocolError("truncated", "RPC metadata is truncated");
    }
  }
}

function validateFrontier(
  value: readonly Readonly<{ replicaId: string; counter: number }>[],
  maximumActors: number,
): Array<readonly [string, number]> {
  if (!Array.isArray(value))
    throw protocolError("invalid_frontier", "causal frontier must be an array");
  const entries: Array<readonly [string, number]> = [];
  for (const entry of value) {
    if (!isPlainRecord(entry))
      throw protocolError("invalid_frontier", "causal frontier entry is invalid");
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("replicaId") || !keys.includes("counter")) {
      throw protocolError("invalid_frontier", "causal frontier entry has unknown fields");
    }
    const actor = dataProperty(entry, "replicaId");
    const counter = dataProperty(entry, "counter");
    if (typeof actor !== "string" || typeof counter !== "number") {
      throw protocolError("invalid_frontier", "causal frontier entry has invalid fields");
    }
    entries.push([actor, counter]);
  }
  if (entries.length > maximumActors) {
    throw protocolError("frontier_too_large", "causal frontier exceeds its actor limit");
  }
  for (const [actor, counter] of entries) {
    if (!actor || new TextEncoder().encode(actor).byteLength > 256) {
      throw protocolError("invalid_frontier", "causal frontier actor is invalid");
    }
    nonNegativeSafeInteger(counter, `causal frontier counter for ${actor}`);
  }
  const sorted = entries.slice().sort(([left], [right]) => compareCodeUnits(left, right));
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]![0] !== sorted[index]![0]) {
      throw protocolError("noncanonical", "causal frontier must already be code-unit sorted");
    }
    if (index > 0 && entries[index - 1]![0] === entries[index]![0]) {
      throw protocolError("noncanonical", "causal frontier contains a duplicate replica");
    }
  }
  return entries;
}

function validateLimits(input: Readonly<ArtifactWorkerRpcLimits>): ArtifactWorkerRpcLimits {
  const limits = {
    maxMetadataBytes: positiveSafeInteger(input.maxMetadataBytes, "maxMetadataBytes"),
    maxSegmentBytes: positiveSafeInteger(input.maxSegmentBytes, "maxSegmentBytes"),
    maxTotalSegmentBytes: positiveSafeInteger(input.maxTotalSegmentBytes, "maxTotalSegmentBytes"),
    maxSegments: positiveSafeInteger(input.maxSegments, "maxSegments"),
  };
  if (limits.maxSegments > 0xffff) {
    throw protocolError("invalid_limit", "maxSegments exceeds the frame encoding limit");
  }
  return limits;
}

function isKnownKind(kind: number): boolean {
  return (
    (kind >= ArtifactWorkerRpcKind.Initialize && kind <= ArtifactWorkerRpcKind.QuerySpreadsheet) ||
    kind === ArtifactWorkerRpcKind.Response ||
    kind === ArtifactWorkerRpcKind.Error
  );
}

function checksum32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw protocolError("invalid_frame", `RPC ${key} must be a data property`);
  }
  return descriptor.value;
}

function unsignedByte(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw protocolError("invalid_number", `${label} must be an unsigned byte`);
  }
  return value;
}

function unsignedShort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw protocolError("invalid_number", `${label} must be an unsigned 16-bit integer`);
  }
  return value;
}

function unsignedInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw protocolError("invalid_number", `${label} must be an unsigned 32-bit integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw protocolError("invalid_limit", `${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError("invalid_number", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw protocolError("size_overflow", `${label} overflow`);
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw protocolError("size_overflow", `${label} overflow`);
  return result;
}

function protocolError(
  code: string,
  message: string,
  cause?: unknown,
): ArtifactWorkerProtocolError {
  return new ArtifactWorkerProtocolError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
