import {
  ArtifactCommandBatchCodec,
  type ArtifactCommand,
  type ArtifactCommandBatch,
} from "../../src/kernel";

const COMMAND_MAGIC = new TextEncoder().encode("OGAKC001");
const COMMAND_SCHEMA_VERSION = 1;
const MAX_COMMAND_BYTES = 64 * 1024 * 1024;
const MAX_COMMANDS = 10_000;
const MAX_CELLS = 4_000_000;
const MAX_STRING_BYTES = 4 * 1024 * 1024;
const MAX_SHEET_NAME_BYTES = 1_024;
const textEncoder = new TextEncoder();

export type AuthorizedSpreadsheetKernelTransaction = {
  operation: ArtifactCommandBatch;
  operationEnvelope: Uint8Array;
  commandEnvelope: Uint8Array;
  requestHash: `sha256:${string}`;
};

export type SpreadsheetCellScalar = null | boolean | number | string | { error: string };
export type SpreadsheetCellInput =
  | SpreadsheetCellScalar
  | { formula: string; cached: SpreadsheetCellScalar };

/**
 * Decodes one public causal OGAR transaction and lowers its typed spreadsheet
 * payload to the private kernel ABI. It does not authorize or commit anything.
 * The returned guard must be checked atomically before authoritative apply.
 */
export interface PreparedSpreadsheetKernelTransaction {
  commandEnvelopeForOptimisticApply(): Uint8Array;
  authorizeAndApply<T>(
    commit: (transaction: AuthorizedSpreadsheetKernelTransaction) => T | Promise<T>,
  ): Promise<T>;
}

class PreparedSpreadsheetKernelTransactionImpl implements PreparedSpreadsheetKernelTransaction {
  readonly #operationEnvelope: Uint8Array;
  readonly #commandEnvelope: Uint8Array;

  constructor(operationEnvelope: Uint8Array, commandEnvelope: Uint8Array) {
    this.#operationEnvelope = operationEnvelope.slice();
    this.#commandEnvelope = commandEnvelope.slice();
  }

  /** Returns an isolated copy for speculative, non-authoritative local apply. */
  commandEnvelopeForOptimisticApply(): Uint8Array {
    return this.#commandEnvelope.slice();
  }

  /**
   * Supplies the exact canonical request, its SHA-256 idempotency hash, and the
   * bound lowered command to one trusted commit callback. Authorization,
   * causal/precondition validation, operation persistence, and native apply
   * belong in that callback's single database transaction.
   */
  async authorizeAndApply<T>(
    commit: (transaction: AuthorizedSpreadsheetKernelTransaction) => T | Promise<T>,
  ): Promise<T> {
    const operationEnvelope = this.#operationEnvelope.slice();
    const commandEnvelope = this.#commandEnvelope.slice();
    const requestHash = sha256Text(
      new Uint8Array(await crypto.subtle.digest("SHA-256", operationEnvelope)),
    );
    return commit({
      operation: ArtifactCommandBatchCodec.decode(operationEnvelope),
      operationEnvelope,
      commandEnvelope,
      requestHash,
    });
  }
}

export function prepareSpreadsheetKernelTransaction(
  operationEnvelope: Uint8Array,
): PreparedSpreadsheetKernelTransaction {
  const operation = ArtifactCommandBatchCodec.decode(operationEnvelope);
  const canonicalOperation = ArtifactCommandBatchCodec.encode(operation);
  if (!bytesEqual(operationEnvelope, canonicalOperation)) {
    throw new Error("Spreadsheet operation envelope must use its canonical encoding");
  }
  return new PreparedSpreadsheetKernelTransactionImpl(
    canonicalOperation,
    lowerSpreadsheetOperation(operation),
  );
}

export const lowerSpreadsheetOperationEnvelope = prepareSpreadsheetKernelTransaction;

/**
 * Lowers an already-decoded public operation while preserving every causal and
 * object precondition in a separate guard. The browser may apply optimistically;
 * the server must validate the guard before applying `commandEnvelope`.
 */
function lowerSpreadsheetOperation(batch: ArtifactCommandBatch): Uint8Array {
  if (batch.modality !== "spreadsheet") {
    throw new Error(`Spreadsheet kernel cannot lower ${batch.modality} operations`);
  }
  if (batch.commands.length > MAX_COMMANDS)
    throw new Error("Spreadsheet command count exceeds bound");

  const payload = new Writer(MAX_COMMAND_BYTES - 32);
  let cellCount = 0;
  batch.commands.forEach((command, commandIndex) => {
    switch (command.code) {
      case "sheet.create": {
        const object = requiredObject(command.payload, commandIndex);
        requireExactKeys(object, ["name"], commandIndex);
        payload.u8(0);
        payload.stableId(requiredTarget(command, commandIndex));
        payload.sheetName(requiredStringField(object, "name", commandIndex));
        break;
      }
      case "sheet.rename": {
        const object = requiredObject(command.payload, commandIndex);
        requireExactKeys(object, ["name"], commandIndex);
        payload.u8(1);
        payload.stableId(requiredTarget(command, commandIndex));
        payload.sheetName(requiredStringField(object, "name", commandIndex));
        break;
      }
      case "sheet.delete": {
        payload.u8(2);
        payload.stableId(requiredTarget(command, commandIndex));
        requireEmptyPayload(command.payload, commandIndex);
        break;
      }
      case "cells.set": {
        const object = requiredObject(command.payload, commandIndex);
        requireExactKeys(object, ["column", "row", "values"], commandIndex);
        const row = requiredCoordinate(object.row, "row", commandIndex);
        const column = requiredCoordinate(object.column, "column", commandIndex);
        const values = object.values;
        if (!Array.isArray(values) || values.length === 0) {
          throw commandError(commandIndex, "values must be a non-empty rectangular array");
        }
        const columns = Array.isArray(values[0]) ? values[0].length : 0;
        if (
          columns === 0 ||
          values.some((line) => !Array.isArray(line) || line.length !== columns)
        ) {
          throw commandError(commandIndex, "values must be a non-empty rectangular array");
        }
        const nextCells = values.length * columns;
        if (!Number.isSafeInteger(nextCells) || nextCells > MAX_CELLS - cellCount) {
          throw commandError(commandIndex, "cell count exceeds bound");
        }
        assertCoordinateExtent(row, values.length, "row", commandIndex);
        assertCoordinateExtent(column, columns, "column", commandIndex);
        cellCount += nextCells;
        payload.u8(3);
        payload.stableId(requiredTarget(command, commandIndex));
        payload.u32(row);
        payload.u32(column);
        payload.u32(values.length);
        payload.u32(columns);
        for (const line of values) {
          for (const cell of line as unknown[]) payload.cell(cell, commandIndex);
        }
        break;
      }
      case "range.clear": {
        const object = requiredObject(command.payload, commandIndex);
        requireExactKeys(object, ["end", "start"], commandIndex);
        const start = requiredPoint(object.start, "start", commandIndex);
        const end = requiredPoint(object.end, "end", commandIndex);
        if (start.row > end.row || start.column > end.column) {
          throw commandError(commandIndex, "range endpoints must be ordered");
        }
        payload.u8(4);
        payload.stableId(requiredTarget(command, commandIndex));
        payload.u32(start.row);
        payload.u32(start.column);
        payload.u32(end.row);
        payload.u32(end.column);
        break;
      }
      default:
        throw commandError(
          commandIndex,
          `unsupported spreadsheet command ${JSON.stringify(command.code)}`,
        );
    }
  });

  const payloadBytes = payload.finish();
  const output = new Writer(MAX_COMMAND_BYTES);
  output.bytes(COMMAND_MAGIC);
  output.u16(COMMAND_SCHEMA_VERSION);
  output.u16(0);
  output.u32(batch.commands.length);
  output.u64(BigInt(payloadBytes.byteLength));
  output.bytes(payloadBytes);
  output.u64(output.checksum());
  return output.finish();
}

function requiredTarget(command: ArtifactCommand, index: number): string {
  if (!command.targetId) throw commandError(index, "targetId is required");
  return command.targetId;
}

function requiredObject(value: unknown, index: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw commandError(index, "payload must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredStringField(value: unknown, field: string, index: number): string {
  const candidate = requiredObject(value, index)[field];
  if (typeof candidate !== "string") throw commandError(index, `${field} must be a string`);
  return candidate;
}

function requireExactKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
  index: number,
): void {
  const keys = Object.keys(object).sort();
  if (keys.length !== expected.length || keys.some((key, keyIndex) => key !== expected[keyIndex])) {
    throw commandError(index, `payload keys must be exactly ${expected.join(", ")}`);
  }
}

function requireEmptyPayload(value: unknown, index: number): void {
  if (value !== undefined) throw commandError(index, "payload must be omitted");
}

function requiredCoordinate(value: unknown, name: string, index: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw commandError(index, `${name} must be a uint32`);
  }
  return value as number;
}

function requiredPoint(
  value: unknown,
  name: string,
  index: number,
): { row: number; column: number } {
  const object = requiredObject(value, index);
  requireExactKeys(object, ["column", "row"], index);
  return {
    row: requiredCoordinate(object.row, `${name}.row`, index),
    column: requiredCoordinate(object.column, `${name}.column`, index),
  };
}

function assertCoordinateExtent(start: number, length: number, name: string, index: number): void {
  if (length - 1 > 0xffff_ffff - start) throw commandError(index, `${name} extent exceeds uint32`);
}

function commandError(index: number, message: string): Error {
  return new Error(`Spreadsheet command ${index}: ${message}`);
}

class Writer {
  private buffer: Uint8Array;
  private dataView: DataView;
  private length = 0;

  constructor(private readonly maximum: number) {
    this.buffer = new Uint8Array(Math.min(1_024, maximum));
    this.dataView = new DataView(this.buffer.buffer);
  }

  view(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  checksum(): bigint {
    return checksum(this.view());
  }

  bytes(value: Uint8Array): void {
    if (value.byteLength > this.maximum - this.length)
      throw new Error("Kernel command envelope exceeds bound");
    this.ensureCapacity(this.length + value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  u8(value: number): void {
    this.reserve(1);
    this.dataView.setUint8(this.length, value);
    this.length += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.dataView.setUint16(this.length, value, true);
    this.length += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.dataView.setUint32(this.length, value, true);
    this.length += 4;
  }

  u64(value: bigint): void {
    this.reserve(8);
    this.dataView.setBigUint64(this.length, value, true);
    this.length += 8;
  }

  f64(value: number): void {
    this.reserve(8);
    this.dataView.setFloat64(this.length, value, true);
    this.length += 8;
  }

  stableId(value: string): void {
    if (!/^[0-9a-f]{32}$/.test(value))
      throw new Error("Kernel StableId must be 32 lowercase hex characters");
    const id = BigInt(`0x${value}`);
    const counter = BigInt.asUintN(64, id);
    const namespace = id >> 64n;
    if (namespace === 0n || counter === 0n) {
      throw new Error("Kernel StableId requires a nonzero namespace and counter");
    }
    this.u64(counter);
    this.u64(namespace);
  }

  string(value: string): void {
    assertWellFormedString(value);
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength > MAX_STRING_BYTES) throw new Error("Kernel string exceeds bound");
    this.u32(bytes.byteLength);
    this.bytes(bytes);
  }

  sheetName(value: string): void {
    assertWellFormedString(value);
    const bytes = textEncoder.encode(value);
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_SHEET_NAME_BYTES ||
      value !== value.trim() ||
      value.length > 31 ||
      /[\\/?*[\]:]/.test(value) ||
      value.includes("\0")
    ) {
      throw new Error("Worksheet name does not match the public spreadsheet model");
    }
    this.u32(bytes.byteLength);
    this.bytes(bytes);
  }

  cell(value: unknown, commandIndex: number): void {
    if (isFormula(value)) {
      requireExactKeys(
        value as unknown as Record<string, unknown>,
        ["cached", "formula"],
        commandIndex,
      );
      if (!value.formula) throw commandError(commandIndex, "formula must not be empty");
      assertWellFormedString(value.formula);
      this.u8(1);
      this.string(value.formula);
      this.scalar(value.cached, commandIndex);
      return;
    }
    this.u8(0);
    this.scalar(value, commandIndex);
  }

  scalar(value: unknown, commandIndex: number): void {
    if (value === null) {
      this.u8(0);
    } else if (value === false) {
      this.u8(1);
    } else if (value === true) {
      this.u8(2);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw commandError(commandIndex, "cell numbers must be finite");
      this.u8(3);
      this.f64(Object.is(value, -0) ? 0 : value);
    } else if (typeof value === "string") {
      assertWellFormedString(value);
      this.u8(4);
      this.string(value);
    } else if (isErrorValue(value)) {
      requireExactKeys(value as unknown as Record<string, unknown>, ["error"], commandIndex);
      assertWellFormedString(value.error);
      this.u8(5);
      this.formulaError(value.error);
    } else {
      throw commandError(commandIndex, "cell value has an unsupported shape");
    }
  }

  formulaError(error: string): void {
    const tag = STANDARD_ERROR_TAGS[error];
    if (tag !== undefined) {
      this.u8(tag);
    } else {
      this.u8(9);
      this.string(error);
    }
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.byteLength) return;
    let capacity = Math.max(1, this.buffer.byteLength);
    while (capacity < required) capacity = Math.min(this.maximum, capacity * 2);
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.dataView = new DataView(next.buffer);
  }

  private reserve(additional: number): void {
    if (additional > this.maximum - this.length) {
      throw new Error("Kernel command envelope exceeds bound");
    }
    this.ensureCapacity(this.length + additional);
  }
}

const STANDARD_ERROR_TAGS: Readonly<Record<string, number>> = {
  "#NULL!": 0,
  "#DIV/0!": 1,
  "#VALUE!": 2,
  "#REF!": 3,
  "#NAME?": 4,
  "#NUM!": 5,
  "#N/A": 6,
  "#SPILL!": 7,
  "#CALC!": 8,
};

function isFormula(value: unknown): value is { formula: string; cached: SpreadsheetCellScalar } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).formula === "string" &&
    Object.hasOwn(value, "cached")
  );
}

function isErrorValue(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).error === "string"
  );
}

function assertWellFormedString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Artifact strings must not contain unpaired surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Artifact strings must not contain unpaired surrogates");
    }
  }
}

function checksum(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sha256Text(digest: Uint8Array): `sha256:${string}` {
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
