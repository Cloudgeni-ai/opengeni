/**
 * Strict, allocation-bounded inspection of canonical OGACO001 transactions.
 *
 * The Rust kernel remains the authority for applying operations. This decoder
 * validates the complete envelope and every typed operation so metadata after
 * the operation stream cannot be located by trusting attacker-controlled
 * lengths. It intentionally does not construct an editable artifact model.
 */

import { COMMITTED_TRANSACTION_PROTOCOL_VERSION } from "./editable-artifact-versions";

export { COMMITTED_TRANSACTION_PROTOCOL_VERSION } from "./editable-artifact-versions";
export const MAX_COMMITTED_TRANSACTION_BYTES = 8 * 1024 * 1024;
export const MAX_COMMITTED_TRANSACTION_OPERATIONS = 4_096;
export const MAX_COMMITTED_TRANSACTION_CAUSAL_REPLICAS = 100_000;
export const MAX_COMMITTED_TRANSACTION_CELLS = 1_000_000;

const MAGIC = new Uint8Array([0x4f, 0x47, 0x41, 0x43, 0x4f, 0x30, 0x30, 0x31]); // OGACO001
const HEADER_BYTES = 24;
const CHECKSUM_BYTES = 8;
const HASH_BYTES = 32;
const STABLE_ID_BYTES = 16;
const MAX_OPERATION_STRING_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_U64_HIGH = 0x1f_ffff;
const U32_SIZE = 0x1_0000_0000;
const U32_MAX = 0xffff_ffff;
const FNV_OFFSET_LOW = 0x8422_2325;
const FNV_OFFSET_HIGH = 0xcbf2_9ce4;
const FNV_PRIME_LOW = 0x01b3;

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

export type CommittedTransactionCausalEntry = Readonly<{
  replicaId: string;
  counter: number;
}>;

export type CommittedTransactionSummary = Readonly<{
  operationProtocolVersion: typeof COMMITTED_TRANSACTION_PROTOCOL_VERSION;
  transactionId: string;
  dot: CommittedTransactionCausalEntry;
  resolvedCausalBase: readonly CommittedTransactionCausalEntry[];
  operationIds: readonly string[];
  priorStateHash: string;
  resultingCausalFrontier: readonly CommittedTransactionCausalEntry[];
  stateHash: string;
}>;

/**
 * Decodes only the metadata of one exact canonical OGACO001 byte envelope.
 *
 * This function is synchronous and never mutates or retains `bytes`. The
 * caller remains the owner of the exact canonical envelope.
 */
export function decodeCommittedTransactionSummary(bytes: Uint8Array): CommittedTransactionSummary {
  assertInput(bytes);
  if (bytes.byteLength > MAX_COMMITTED_TRANSACTION_BYTES) {
    throw new RangeError("OGACO001 envelope exceeds its byte limit");
  }
  if (bytes.byteLength < HEADER_BYTES + CHECKSUM_BYTES) {
    throw new TypeError("truncated OGACO001 envelope");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new TypeError("invalid OGACO001 magic");
  }

  const version = view.getUint16(8, true);
  if (version !== COMMITTED_TRANSACTION_PROTOCOL_VERSION) {
    throw new TypeError(`unsupported OGACO001 version: ${version}`);
  }
  if (view.getUint16(10, true) !== 0) {
    throw new TypeError("reserved OGACO001 header bits are set");
  }

  const operationCount = view.getUint32(12, true);
  if (operationCount === 0 || operationCount > MAX_COMMITTED_TRANSACTION_OPERATIONS) {
    throw new RangeError("OGACO001 operation count is outside its canonical bounds");
  }

  const payloadLength = safeU64At(view, 16, "OGACO001 payload length", false);
  const payloadEnd = checkedAdd(HEADER_BYTES, payloadLength, "OGACO001 payload length");
  const expectedLength = checkedAdd(payloadEnd, CHECKSUM_BYTES, "OGACO001 envelope length");
  if (bytes.byteLength !== expectedLength) {
    throw new TypeError(
      bytes.byteLength < expectedLength
        ? "truncated OGACO001 payload"
        : "trailing bytes after OGACO001 envelope",
    );
  }

  const [checksumLow, checksumHigh] = fnv1a64(bytes, payloadEnd);
  if (
    view.getUint32(payloadEnd, true) !== checksumLow ||
    view.getUint32(payloadEnd + 4, true) !== checksumHigh
  ) {
    throw new TypeError("OGACO001 checksum mismatch");
  }

  const reader = new Reader(bytes, HEADER_BYTES, payloadEnd);
  const transactionId = reader.stableId("transaction id");
  const dot = Object.freeze({
    replicaId: reader.replicaId("transaction dot replica"),
    counter: reader.safeU64("transaction dot counter", true),
  });
  const resolvedCausalBase = reader.frontier("resolved causal base");
  const priorStateHash = reader.stateHash("prior state hash");

  const operationIds: string[] = [];
  const seenOperationIds = new Set<string>();
  let totalCells = 0;
  for (let index = 0; index < operationCount; index += 1) {
    const operationId = reader.stableId(`operation ${index} id`);
    if (seenOperationIds.has(operationId)) {
      throw new TypeError("OGACO001 operation ids must be unique");
    }
    seenOperationIds.add(operationId);
    operationIds.push(operationId);
    totalCells = reader.skipCommand(totalCells);
  }

  const resultingCausalFrontier = reader.frontier("resulting causal frontier");
  const stateHash = reader.stateHash("resulting state hash");
  reader.done();

  return Object.freeze({
    operationProtocolVersion: COMMITTED_TRANSACTION_PROTOCOL_VERSION,
    transactionId,
    dot,
    resolvedCausalBase,
    operationIds: Object.freeze(operationIds),
    priorStateHash,
    resultingCausalFrontier,
    stateHash,
  });
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #end: number;
  #offset: number;

  constructor(bytes: Uint8Array, offset: number, end: number) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#offset = offset;
    this.#end = end;
  }

  take(length: number, label: string): Uint8Array {
    const offset = this.reserve(length, label);
    return this.#bytes.subarray(offset, offset + length);
  }

  reserve(length: number, label: string): number {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`${label} has an invalid byte length`);
    }
    const offset = this.#offset;
    const end = checkedAdd(offset, length, `${label} byte range`);
    if (end > this.#end) throw new TypeError(`truncated ${label}`);
    this.#offset = end;
    return offset;
  }

  u8(label: string): number {
    return this.#bytes[this.reserve(1, label)]!;
  }

  u32(label: string): number {
    const offset = this.reserve(4, label);
    return this.#view.getUint32(offset, true);
  }

  safeU64(label: string, positive: boolean): number {
    const offset = this.reserve(8, label);
    const value = safeU64At(this.#view, offset, label, positive);
    return value;
  }

  replicaId(label: string): string {
    const offset = this.reserve(8, label);
    const low = this.#view.getUint32(offset, true);
    const high = this.#view.getUint32(offset + 4, true);
    if (low === 0 && high === 0) throw new TypeError(`${label} must be nonzero`);
    return hexU64(high, low);
  }

  stableId(label: string): string {
    const offset = this.reserve(STABLE_ID_BYTES, label);
    const counterLow = this.#view.getUint32(offset, true);
    const counterHigh = this.#view.getUint32(offset + 4, true);
    const namespaceLow = this.#view.getUint32(offset + 8, true);
    const namespaceHigh = this.#view.getUint32(offset + 12, true);
    if (counterLow === 0 && counterHigh === 0 && namespaceLow === 0 && namespaceHigh === 0) {
      throw new TypeError(`${label} reserves the all-zero value`);
    }
    return `${hexU64(namespaceHigh, namespaceLow)}${hexU64(counterHigh, counterLow)}`;
  }

  sheetObjectId(label: string): string {
    const offset = this.#offset;
    const id = this.stableId(label);
    const counterIsZero =
      this.#view.getUint32(offset, true) === 0 && this.#view.getUint32(offset + 4, true) === 0;
    const namespaceIsZero =
      this.#view.getUint32(offset + 8, true) === 0 && this.#view.getUint32(offset + 12, true) === 0;
    if (counterIsZero || namespaceIsZero) {
      throw new TypeError(`${label} requires nonzero namespace and counter`);
    }
    return id;
  }

  stateHash(label: string): string {
    return `sha256:${hexBytes(this.take(HASH_BYTES, label))}`;
  }

  frontier(label: string): readonly CommittedTransactionCausalEntry[] {
    const count = this.u32(`${label} count`);
    if (count > MAX_COMMITTED_TRANSACTION_CAUSAL_REPLICAS) {
      throw new RangeError(`${label} exceeds its replica limit`);
    }
    const entries: CommittedTransactionCausalEntry[] = [];
    let previousLow = 0;
    let previousHigh = 0;
    let hasPrevious = false;
    for (let index = 0; index < count; index += 1) {
      const replicaOffset = this.#offset;
      const replicaId = this.replicaId(`${label} replica ${index}`);
      const replicaLow = this.#view.getUint32(replicaOffset, true);
      const replicaHigh = this.#view.getUint32(replicaOffset + 4, true);
      if (
        hasPrevious &&
        (replicaHigh < previousHigh || (replicaHigh === previousHigh && replicaLow <= previousLow))
      ) {
        throw new TypeError(`${label} replicas must be unique and strictly ordered`);
      }
      const counter = this.safeU64(`${label} counter ${index}`, true);
      entries.push(Object.freeze({ replicaId, counter }));
      previousLow = replicaLow;
      previousHigh = replicaHigh;
      hasPrevious = true;
    }
    return Object.freeze(entries);
  }

  skipCommand(totalCells: number): number {
    const tag = this.u8("collaboration command tag");
    switch (tag) {
      case 0: {
        this.sheetObjectId("created sheet id");
        this.skipString("created sheet name");
        const after = this.u8("created sheet predecessor flag");
        if (after === 1) this.skipGeneration("created sheet predecessor");
        else if (after !== 0) throw new TypeError("invalid created sheet predecessor flag");
        return totalCells;
      }
      case 1:
        this.skipGeneration("renamed sheet generation");
        this.skipString("renamed sheet name");
        return totalCells;
      case 2:
        this.skipGeneration("deleted sheet generation");
        return totalCells;
      case 3:
        return this.skipSetCells(totalCells);
      case 4: {
        this.skipGeneration("cleared sheet generation");
        const startRow = this.u32("clear range start row");
        const startColumn = this.u32("clear range start column");
        const endRow = this.u32("clear range end row");
        const endColumn = this.u32("clear range end column");
        if (startRow > endRow || startColumn > endColumn) {
          throw new TypeError("OGACO001 clear range is not normalized");
        }
        return totalCells;
      }
      case 5:
        this.stableId("selective undo target");
        return totalCells;
      default:
        throw new TypeError(`invalid OGACO001 collaboration command tag: ${tag}`);
    }
  }

  skipSetCells(totalCells: number): number {
    this.skipGeneration("cell block sheet generation");
    const anchorRow = this.u32("cell block anchor row");
    const anchorColumn = this.u32("cell block anchor column");
    const rows = this.u32("cell block rows");
    const columns = this.u32("cell block columns");
    if (rows === 0 || columns === 0) {
      throw new TypeError("OGACO001 cell block dimensions must be nonzero");
    }
    if (anchorRow > U32_MAX - (rows - 1) || anchorColumn > U32_MAX - (columns - 1)) {
      throw new RangeError("OGACO001 cell block coordinates overflow u32");
    }
    if (rows > Math.floor(MAX_COMMITTED_TRANSACTION_CELLS / columns)) {
      throw new RangeError("OGACO001 cell block exceeds its cell limit");
    }
    const cellCount = rows * columns;
    const nextTotal = totalCells + cellCount;
    if (nextTotal > MAX_COMMITTED_TRANSACTION_CELLS) {
      throw new RangeError("OGACO001 transaction exceeds its cell limit");
    }
    for (let index = 0; index < cellCount; index += 1) this.skipCell();
    return nextTotal;
  }

  skipCell(): void {
    const formulaTag = this.u8("cell formula tag");
    if (formulaTag === 1) {
      if (this.skipString("cell formula") === 0) {
        throw new TypeError("OGACO001 formula must not be empty");
      }
    } else if (formulaTag !== 0) {
      throw new TypeError(`invalid OGACO001 cell formula tag: ${formulaTag}`);
    }

    const valueTag = this.u8("cell value tag");
    switch (valueTag) {
      case 0:
      case 1:
      case 2:
        return;
      case 3:
        this.skipNumber();
        return;
      case 4:
        this.skipString("cell text");
        return;
      case 5:
        this.skipFormulaError();
        return;
      default:
        throw new TypeError(`invalid OGACO001 cell value tag: ${valueTag}`);
    }
  }

  skipNumber(): void {
    const offset = this.reserve(8, "cell number");
    const low = this.#view.getUint32(offset, true);
    const high = this.#view.getUint32(offset + 4, true);
    if (low === 0 && high === 0x8000_0000) {
      throw new TypeError("OGACO001 cell number uses negative zero");
    }
    if ((high & 0x7ff0_0000) === 0x7ff0_0000) {
      throw new TypeError("OGACO001 cell numbers must be finite");
    }
  }

  skipFormulaError(): void {
    const tag = this.u8("formula error tag");
    if (tag <= 8) return;
    if (tag === 9) {
      this.skipString("custom formula error");
      return;
    }
    throw new TypeError(`invalid OGACO001 formula error tag: ${tag}`);
  }

  skipGeneration(label: string): void {
    this.sheetObjectId(`${label} sheet id`);
    this.stableId(`${label} creation operation id`);
  }

  skipString(label: string): number {
    const length = this.u32(`${label} length`);
    if (length > MAX_OPERATION_STRING_BYTES) {
      throw new RangeError(`${label} exceeds its byte limit`);
    }
    const value = this.take(length, label);
    assertUtf8(value, label);
    return length;
  }

  done(): void {
    if (this.#offset !== this.#end) throw new TypeError("trailing bytes in OGACO001 payload");
  }
}

function assertInput(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("OGACO001 bytes must be a Uint8Array");
  }
  if (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer) {
    throw new TypeError("OGACO001 bytes must not use shared mutable memory");
  }
}

function safeU64At(view: DataView, offset: number, label: string, positive: boolean): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  if (high > MAX_SAFE_U64_HIGH)
    throw new RangeError(`${label} exceeds JavaScript safe integer range`);
  const value = high * U32_SIZE + low;
  if (positive && value === 0) throw new TypeError(`${label} must be nonzero`);
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds safe integer range`);
  return result;
}

/** Allocation-free UTF-8 scalar validation equivalent to Rust `str::from_utf8`. */
function assertUtf8(bytes: Uint8Array, label: string): void {
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    const second = bytes[index + 1];
    if (first >= 0xc2 && first <= 0xdf && continuation(second)) {
      index += 2;
      continue;
    }
    const third = bytes[index + 2];
    if (
      ((first === 0xe0 && between(second, 0xa0, 0xbf)) ||
        (first >= 0xe1 && first <= 0xec && continuation(second)) ||
        (first === 0xed && between(second, 0x80, 0x9f)) ||
        (first >= 0xee && first <= 0xef && continuation(second))) &&
      continuation(third)
    ) {
      index += 3;
      continue;
    }
    const fourth = bytes[index + 3];
    if (
      ((first === 0xf0 && between(second, 0x90, 0xbf)) ||
        (first >= 0xf1 && first <= 0xf3 && continuation(second)) ||
        (first === 0xf4 && between(second, 0x80, 0x8f))) &&
      continuation(third) &&
      continuation(fourth)
    ) {
      index += 4;
      continue;
    }
    throw new TypeError(`${label} is not canonical UTF-8`);
  }
}

function continuation(value: number | undefined): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function between(value: number | undefined, minimum: number, maximum: number): boolean {
  return value !== undefined && value >= minimum && value <= maximum;
}

function hexU64(high: number, low: number): string {
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

function hexBytes(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += HEX[byte];
  return result;
}

/** FNV-1a-64 using exact 32-bit limbs; avoids a BigInt allocation per byte. */
function fnv1a64(bytes: Uint8Array, end: number): readonly [low: number, high: number] {
  let low = FNV_OFFSET_LOW;
  let high = FNV_OFFSET_HIGH;
  for (let index = 0; index < end; index += 1) {
    low = (low ^ bytes[index]!) >>> 0;
    const lowProduct = low * FNV_PRIME_LOW;
    const carry = Math.floor(lowProduct / U32_SIZE);
    high = (high * FNV_PRIME_LOW + carry + low * 0x100) >>> 0;
    low = lowProduct >>> 0;
  }
  return [low, high];
}
