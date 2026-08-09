const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const STABLE_ID = /^[0-9a-f]{32}$/u;

export const EDITABLE_ARTIFACT_BINARY_HEADER_BYTES = 24;
export const EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES = 8;

export function strictUtf8(value: string, label: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired surrogate`);
    }
  }
  return TEXT_ENCODER.encode(value);
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    throw new TypeError(`${label} is not valid UTF-8`);
  }
}

export function canonicalStableId(value: string, label: string): string {
  if (!STABLE_ID.test(value)) {
    throw new TypeError(`${label} must be a lowercase 128-bit hexadecimal id`);
  }
  return value;
}

export function allocatedStableId(value: string, label: string): string {
  canonicalStableId(value, label);
  if (value.slice(0, 16) === "0000000000000000" || value.slice(16) === "0000000000000000") {
    throw new TypeError(`${label} must have nonzero namespace and counter`);
  }
  return value;
}

export function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

export function boundedU32(value: number, label: string, maximum = 0xffff_ffff): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} is outside its unsigned 32-bit bound`);
  }
  return value;
}

export function canonicalNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError(`${label} must be finite and must not be negative zero`);
  }
  return value;
}

export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export class ArtifactBinaryWriter {
  readonly #maximum: number;
  #bytes: Uint8Array;
  #view: DataView;
  #length = 0;

  constructor(maximum: number) {
    this.#maximum = nonnegativeSafeInteger(maximum, "binary writer maximum");
    this.#bytes = new Uint8Array(Math.min(Math.max(maximum, 32), 1024));
    this.#view = new DataView(this.#bytes.buffer);
  }

  get length(): number {
    return this.#length;
  }

  view(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }

  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }

  #reserve(additional: number): void {
    const next = this.#length + additional;
    if (!Number.isSafeInteger(next) || next > this.#maximum) {
      throw new RangeError("editable artifact binary payload exceeds its byte limit");
    }
    if (next <= this.#bytes.byteLength) return;
    let capacity = this.#bytes.byteLength;
    while (capacity < next) capacity = Math.min(this.#maximum, Math.max(next, capacity * 2));
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }

  bytes(value: Uint8Array): void {
    this.#reserve(value.byteLength);
    this.#bytes.set(value, this.#length);
    this.#length += value.byteLength;
  }

  u8(value: number): void {
    boundedU32(value, "u8", 0xff);
    this.#reserve(1);
    this.#view.setUint8(this.#length, value);
    this.#length += 1;
  }

  bool(value: boolean): void {
    if (typeof value !== "boolean") throw new TypeError("boolean value is invalid");
    this.u8(value ? 1 : 0);
  }

  u16(value: number): void {
    boundedU32(value, "u16", 0xffff);
    this.#reserve(2);
    this.#view.setUint16(this.#length, value, true);
    this.#length += 2;
  }

  u32(value: number): void {
    boundedU32(value, "u32");
    this.#reserve(4);
    this.#view.setUint32(this.#length, value, true);
    this.#length += 4;
  }

  i32(value: number): void {
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new RangeError("i32 value is outside its bound");
    }
    this.#reserve(4);
    this.#view.setInt32(this.#length, value, true);
    this.#length += 4;
  }

  u64(value: bigint | number): void {
    const encoded =
      typeof value === "number" ? BigInt(nonnegativeSafeInteger(value, "u64")) : value;
    if (encoded < 0n || encoded > 0xffff_ffff_ffff_ffffn)
      throw new RangeError("u64 value is outside its bound");
    this.#reserve(8);
    this.#view.setBigUint64(this.#length, encoded, true);
    this.#length += 8;
  }

  i64(value: bigint | number): void {
    const encoded =
      typeof value === "number"
        ? BigInt(
            Number.isSafeInteger(value)
              ? value
              : (() => {
                  throw new TypeError("i64 number must be safe");
                })(),
          )
        : value;
    if (encoded < -0x8000_0000_0000_0000n || encoded > 0x7fff_ffff_ffff_ffffn) {
      throw new RangeError("i64 value is outside its bound");
    }
    this.#reserve(8);
    this.#view.setBigInt64(this.#length, encoded, true);
    this.#length += 8;
  }

  f64(value: number, label = "number"): void {
    canonicalNumber(value, label);
    this.#reserve(8);
    this.#view.setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  count(value: number, maximum: number, label: string): void {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new RangeError(`${label} exceeds its collection bound`);
    }
    this.u32(value);
  }

  string(value: string, maximum: number, label: string): void {
    const bytes = strictUtf8(value, label);
    if (bytes.byteLength > maximum) throw new RangeError(`${label} exceeds its byte limit`);
    this.u32(bytes.byteLength);
    this.bytes(bytes);
  }

  stableId(value: string, label: string, requireAllocated = false): void {
    (requireAllocated ? allocatedStableId : canonicalStableId)(value, label);
    this.u64(BigInt(`0x${value.slice(16)}`));
    this.u64(BigInt(`0x${value.slice(0, 16)}`));
  }
}

export class ArtifactBinaryReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("binary input must be a Uint8Array");
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  done(message = "editable artifact binary payload contains trailing bytes"): void {
    if (this.remaining !== 0) throw new TypeError(message);
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new TypeError("truncated editable artifact binary payload");
    }
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  bool(label = "boolean"): boolean {
    const value = this.u8();
    if (value > 1) throw new TypeError(`invalid ${label}`);
    return value === 1;
  }

  u16(): number {
    const offset = this.#offset;
    this.bytes(2);
    return this.#view.getUint16(offset, true);
  }

  u32(): number {
    const offset = this.#offset;
    this.bytes(4);
    return this.#view.getUint32(offset, true);
  }

  i32(): number {
    const offset = this.#offset;
    this.bytes(4);
    return this.#view.getInt32(offset, true);
  }

  u64BigInt(): bigint {
    const offset = this.#offset;
    this.bytes(8);
    return this.#view.getBigUint64(offset, true);
  }

  u64Safe(label: string): number {
    const value = this.u64BigInt();
    if (value > SAFE_INTEGER) throw new RangeError(`${label} exceeds the JavaScript-safe bound`);
    return Number(value);
  }

  i64BigInt(): bigint {
    const offset = this.#offset;
    this.bytes(8);
    return this.#view.getBigInt64(offset, true);
  }

  i64Safe(label: string): number {
    const value = this.i64BigInt();
    if (value < -SAFE_INTEGER || value > SAFE_INTEGER)
      throw new RangeError(`${label} exceeds the JavaScript-safe bound`);
    return Number(value);
  }

  f64(label: string): number {
    const offset = this.#offset;
    this.bytes(8);
    return canonicalNumber(this.#view.getFloat64(offset, true), label);
  }

  count(maximum: number, label: string, minimumBytes = 0): number {
    const value = this.u32();
    if (value > maximum) throw new RangeError(`${label} exceeds its collection bound`);
    if (minimumBytes > 0 && value > Math.floor(this.remaining / minimumBytes)) {
      throw new TypeError("truncated editable artifact binary payload");
    }
    return value;
  }

  string(maximum: number, label: string): string {
    const length = this.count(maximum, label, 1);
    return decodeUtf8(this.bytes(length), label);
  }

  stableId(label: string, requireAllocated = false): string {
    const counter = this.u64BigInt().toString(16).padStart(16, "0");
    const namespace = this.u64BigInt().toString(16).padStart(16, "0");
    const value = `${namespace}${counter}`;
    return (requireAllocated ? allocatedStableId : canonicalStableId)(value, label);
  }
}

export function encodeCountedEnvelope(
  magic: string,
  version: number,
  count: number,
  payload: Uint8Array,
  maximum: number,
): Uint8Array {
  if (strictUtf8(magic, "envelope magic").byteLength !== 8)
    throw new TypeError("envelope magic must be eight bytes");
  const output = new ArtifactBinaryWriter(maximum);
  output.bytes(strictUtf8(magic, "envelope magic"));
  output.u16(version);
  output.u16(0);
  output.u32(count);
  output.u64(BigInt(payload.byteLength));
  output.bytes(payload);
  output.u64(fnv1a64(output.view()));
  return output.finish();
}

export function decodeCountedEnvelope(
  bytes: Uint8Array,
  magic: string,
  version: number,
  maximum: number,
  maxCount: number,
): { count: number; payload: Uint8Array } {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("envelope bytes must be a Uint8Array");
  if (bytes.byteLength > maximum)
    throw new RangeError("editable artifact envelope exceeds its byte limit");
  if (
    bytes.byteLength <
    EDITABLE_ARTIFACT_BINARY_HEADER_BYTES + EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES
  ) {
    throw new TypeError("truncated editable artifact envelope");
  }
  const reader = new ArtifactBinaryReader(bytes);
  if (!equalBytes(reader.bytes(8), strictUtf8(magic, "envelope magic")))
    throw new TypeError("invalid editable artifact envelope magic");
  const actualVersion = reader.u16();
  if (actualVersion !== version)
    throw new TypeError(`unsupported editable artifact envelope version: ${actualVersion}`);
  if (reader.u16() !== 0)
    throw new TypeError("reserved editable artifact envelope flags must be zero");
  const count = reader.u32();
  if (count > maxCount) throw new RangeError("editable artifact envelope count exceeds its limit");
  const payloadLength = reader.u64Safe("editable artifact payload length");
  const expected =
    EDITABLE_ARTIFACT_BINARY_HEADER_BYTES + payloadLength + EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES;
  if (bytes.byteLength < expected) throw new TypeError("truncated editable artifact envelope");
  if (bytes.byteLength > expected)
    throw new TypeError("editable artifact envelope contains trailing bytes");
  const payload = reader.bytes(payloadLength);
  const checksum = reader.u64BigInt();
  reader.done();
  if (checksum !== fnv1a64(bytes.subarray(0, -EDITABLE_ARTIFACT_BINARY_CHECKSUM_BYTES))) {
    throw new TypeError("editable artifact envelope checksum does not match");
  }
  return { count, payload };
}
