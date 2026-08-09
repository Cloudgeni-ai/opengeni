import {
  canonicalSpreadsheetDateFromMilliseconds,
  canonicalSpreadsheetDateMilliseconds,
} from "./spreadsheet-artifact-date";

/**
 * Canonical, identity-free spreadsheet mutation commands nested inside
 * `OGATX001`. Artifact, actor, transaction, delivery, and causal identity must
 * never be added here: the outer authored-intent envelope is their sole wire
 * authority.
 */

export const SPREADSHEET_ARTIFACT_COMMAND_VERSION = 1 as const;
export const SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES = 4 * 1024 * 1024;
export const SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS = 4_096;
export const SPREADSHEET_ARTIFACT_COMMAND_MAX_CELLS = 1_000_000;
export const SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES = 1 * 1024 * 1024;
export const SPREADSHEET_ARTIFACT_SHEET_NAME_MAX_UTF16_UNITS = 31;

const MAGIC = new TextEncoder().encode("OGASC001");
const HEADER_BYTES = 8 + 2 + 2 + 4 + 8;
const CHECKSUM_BYTES = 8;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const LOWER_HEX_ID = /^[0-9a-f]{32}$/u;
const UINT64_HEX_ZERO = "0".repeat(16);
const UINT32_MAX = 0xffff_ffff;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

declare const stableIdBrand: unique symbol;

/** Fixed-width lowercase hexadecimal 128-bit id. Runtime helpers enforce use. */
export type EditableArtifactStableId = string & {
  readonly [stableIdBrand]: "EditableArtifactStableId";
};

/**
 * A concrete sheet generation. The object id follows the offline allocator
 * invariant (both 64-bit halves nonzero); a derived operation id reserves only
 * the all-zero 128-bit value.
 */
export type SpreadsheetSheetGeneration = Readonly<{
  kind: "generation";
  sheetId: EditableArtifactStableId;
  creationOperationId: EditableArtifactStableId;
}>;

/**
 * Reference to a sheet created by an earlier command in this same batch.
 * This avoids recursively embedding the creation operation id, which is
 * derived from the hash of the complete outer intent.
 */
export type SpreadsheetPriorCreatePrecondition = Readonly<{
  kind: "created-in-batch";
  sheetId: EditableArtifactStableId;
  createCommandIndex: number;
}>;

export type SpreadsheetSheetPrecondition =
  | SpreadsheetSheetGeneration
  | SpreadsheetPriorCreatePrecondition;

export type SpreadsheetCellPoint = Readonly<{ row: number; column: number }>;
export type SpreadsheetCellRange = Readonly<{
  start: SpreadsheetCellPoint;
  end: SpreadsheetCellPoint;
}>;

export type SpreadsheetFormulaError = Readonly<{ error: string }>;
export type SpreadsheetDateValue = Readonly<{ date: string }>;
export type SpreadsheetCellScalar =
  | null
  | boolean
  | number
  | string
  | SpreadsheetDateValue
  | SpreadsheetFormulaError;
export type SpreadsheetFormulaCell = Readonly<{
  formula: string;
  cached: SpreadsheetCellScalar;
}>;
export type SpreadsheetCellInput = SpreadsheetCellScalar | SpreadsheetFormulaCell;

export type SpreadsheetCreateSheetCommand = Readonly<{
  kind: "sheet.create";
  sheetId: EditableArtifactStableId;
  name: string;
  after: SpreadsheetSheetPrecondition | null;
}>;

export type SpreadsheetRenameSheetCommand = Readonly<{
  kind: "sheet.rename";
  sheet: SpreadsheetSheetPrecondition;
  name: string;
}>;

export type SpreadsheetDeleteSheetCommand = Readonly<{
  kind: "sheet.delete";
  sheet: SpreadsheetSheetPrecondition;
}>;

/** Row-major rectangular write; `cells.length === rows * columns`. */
export type SpreadsheetSetCellsCommand = Readonly<{
  kind: "cells.set";
  sheet: SpreadsheetSheetPrecondition;
  anchor: SpreadsheetCellPoint;
  rows: number;
  columns: number;
  cells: readonly SpreadsheetCellInput[];
}>;

export type SpreadsheetClearRangeCommand = Readonly<{
  kind: "range.clear";
  sheet: SpreadsheetSheetPrecondition;
  range: SpreadsheetCellRange;
}>;

export type SpreadsheetArtifactCommand =
  | SpreadsheetCreateSheetCommand
  | SpreadsheetRenameSheetCommand
  | SpreadsheetDeleteSheetCommand
  | SpreadsheetSetCellsCommand
  | SpreadsheetClearRangeCommand;

export type SpreadsheetArtifactCommandBatch = Readonly<{
  version: typeof SPREADSHEET_ARTIFACT_COMMAND_VERSION;
  commands: readonly SpreadsheetArtifactCommand[];
}>;

/** Validates a generic nonzero 128-bit id and returns its nominal type. */
export function editableArtifactStableId(value: string): EditableArtifactStableId {
  return genericStableId(value, "stable id");
}

/** Validates a sheet object id with nonzero allocator namespace and counter. */
export function spreadsheetSheetId(value: string): EditableArtifactStableId {
  return sheetObjectId(value, "sheet id");
}

export function encodeSpreadsheetArtifactCommandBatch(
  input: SpreadsheetArtifactCommandBatch,
): Uint8Array {
  const batch = batchRecord(input);
  const payload = new BinaryWriter(
    SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES - HEADER_BYTES - CHECKSUM_BYTES,
  );
  const context = new CommandContext();
  for (let index = 0; index < batch.commands.length; index += 1) {
    const command = ownArrayElement(batch.commands, index, "commands");
    encodeCommand(payload, command, index, context);
  }

  const payloadBytes = payload.finish();
  const output = new BinaryWriter(SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES);
  output.bytes(MAGIC);
  output.u16(SPREADSHEET_ARTIFACT_COMMAND_VERSION);
  output.u16(0);
  output.u32(batch.commands.length);
  output.u64(BigInt(payloadBytes.byteLength));
  output.bytes(payloadBytes);
  output.u64(fnv1a64(output.view()));
  return output.finish();
}

export function decodeSpreadsheetArtifactCommandBatch(
  bytes: Uint8Array,
): SpreadsheetArtifactCommandBatch {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("spreadsheet command bytes must be a Uint8Array");
  }
  if (bytes.byteLength > SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES) {
    throw new RangeError("spreadsheet command envelope exceeds its byte limit");
  }
  if (bytes.byteLength < HEADER_BYTES + CHECKSUM_BYTES) {
    throw new TypeError("truncated spreadsheet command envelope");
  }
  const header = new BinaryReader(bytes);
  if (!equalBytes(header.bytes(MAGIC.byteLength), MAGIC)) {
    throw new TypeError("invalid spreadsheet command magic");
  }
  const version = header.u16();
  if (version !== SPREADSHEET_ARTIFACT_COMMAND_VERSION) {
    throw new TypeError(`unsupported spreadsheet command version: ${version}`);
  }
  if (header.u16() !== 0) {
    throw new TypeError("spreadsheet command reserved flags must be zero");
  }
  const commandCount = header.u32();
  if (commandCount < 1 || commandCount > SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS) {
    throw new RangeError("spreadsheet command count is outside its limit");
  }
  const payloadLength = safeLength(header.u64(), "spreadsheet command payload");
  const expectedLength = HEADER_BYTES + payloadLength + CHECKSUM_BYTES;
  if (bytes.byteLength < expectedLength) {
    throw new TypeError("truncated spreadsheet command envelope");
  }
  if (bytes.byteLength > expectedLength) {
    throw new TypeError("spreadsheet command envelope contains trailing bytes");
  }
  const advertisedChecksum = readU64At(bytes, expectedLength - CHECKSUM_BYTES);
  const actualChecksum = fnv1a64(bytes.subarray(0, expectedLength - CHECKSUM_BYTES));
  if (advertisedChecksum !== actualChecksum) {
    throw new TypeError("spreadsheet command checksum does not match");
  }

  const payload = new BinaryReader(bytes.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength));
  const context = new CommandContext();
  const commands: SpreadsheetArtifactCommand[] = [];
  for (let index = 0; index < commandCount; index += 1) {
    commands.push(decodeCommand(payload, index, context));
  }
  payload.done("spreadsheet command payload contains trailing bytes");
  return Object.freeze({
    version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
    commands: Object.freeze(commands),
  });
}

/** Decodes, re-encodes, and proves byte-for-byte canonicality. */
export function assertCanonicalSpreadsheetArtifactCommandBytes(bytes: Uint8Array): Uint8Array {
  const canonical = encodeSpreadsheetArtifactCommandBatch(
    decodeSpreadsheetArtifactCommandBatch(bytes),
  );
  if (!equalBytes(bytes, canonical)) {
    throw new TypeError("spreadsheet command envelope is not canonical");
  }
  return bytes;
}

class CommandContext {
  readonly createdByIndex = new Map<number, string>();
  readonly createdSheetIds = new Set<string>();
  totalCells = 0;

  registerCreate(index: number, sheetId: string): void {
    if (this.createdSheetIds.has(sheetId)) {
      throw commandError(index, "sheet id is created more than once in the batch");
    }
    this.createdByIndex.set(index, sheetId);
    this.createdSheetIds.add(sheetId);
  }

  addCells(index: number, rows: number, columns: number): number {
    const count = rows * columns;
    if (!Number.isSafeInteger(count) || count < 1) {
      throw commandError(index, "cell block dimensions are invalid");
    }
    const next = this.totalCells + count;
    if (!Number.isSafeInteger(next) || next > SPREADSHEET_ARTIFACT_COMMAND_MAX_CELLS) {
      throw commandError(index, "cell count exceeds its transaction limit");
    }
    this.totalCells = next;
    return count;
  }
}

function encodeCommand(
  writer: BinaryWriter,
  value: unknown,
  index: number,
  context: CommandContext,
): void {
  const command = plainRecord(value, `spreadsheet command ${index}`);
  switch (command.kind) {
    case "sheet.create": {
      exactKeys(command, ["after", "kind", "name", "sheetId"], `spreadsheet command ${index}`);
      const sheetId = sheetObjectId(command.sheetId, `spreadsheet command ${index} sheetId`);
      const name = sheetName(command.name, index);
      writer.u8(0);
      writer.stableId(sheetId);
      writer.string(name, SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES);
      if (command.after === null) {
        writer.u8(0);
      } else {
        writer.u8(1);
        encodeSheetPrecondition(writer, command.after, index, context);
      }
      context.registerCreate(index, sheetId);
      break;
    }
    case "sheet.rename": {
      exactKeys(command, ["kind", "name", "sheet"], `spreadsheet command ${index}`);
      writer.u8(1);
      encodeSheetPrecondition(writer, command.sheet, index, context);
      writer.string(sheetName(command.name, index), SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES);
      break;
    }
    case "sheet.delete": {
      exactKeys(command, ["kind", "sheet"], `spreadsheet command ${index}`);
      writer.u8(2);
      encodeSheetPrecondition(writer, command.sheet, index, context);
      break;
    }
    case "cells.set": {
      exactKeys(
        command,
        ["anchor", "cells", "columns", "kind", "rows", "sheet"],
        `spreadsheet command ${index}`,
      );
      const anchor = point(command.anchor, `spreadsheet command ${index} anchor`);
      const rows = positiveU32(command.rows, `spreadsheet command ${index} rows`);
      const columns = positiveU32(command.columns, `spreadsheet command ${index} columns`);
      assertExtent(anchor.row, rows, "row", index);
      assertExtent(anchor.column, columns, "column", index);
      const count = context.addCells(index, rows, columns);
      if (!Array.isArray(command.cells) || command.cells.length !== count) {
        throw commandError(index, `cells must contain exactly ${count} row-major values`);
      }
      writer.u8(3);
      encodeSheetPrecondition(writer, command.sheet, index, context);
      writer.u32(anchor.row);
      writer.u32(anchor.column);
      writer.u32(rows);
      writer.u32(columns);
      for (let cellIndex = 0; cellIndex < count; cellIndex += 1) {
        writer.cell(
          ownArrayElement(command.cells, cellIndex, `spreadsheet command ${index} cells`),
        );
      }
      break;
    }
    case "range.clear": {
      exactKeys(command, ["kind", "range", "sheet"], `spreadsheet command ${index}`);
      const range = cellRange(command.range, index);
      writer.u8(4);
      encodeSheetPrecondition(writer, command.sheet, index, context);
      writer.u32(range.start.row);
      writer.u32(range.start.column);
      writer.u32(range.end.row);
      writer.u32(range.end.column);
      break;
    }
    default:
      throw commandError(index, "unknown command kind");
  }
}

function decodeCommand(
  reader: BinaryReader,
  index: number,
  context: CommandContext,
): SpreadsheetArtifactCommand {
  switch (reader.u8()) {
    case 0: {
      const sheetId = reader.sheetObjectId();
      const name = decodedSheetName(
        reader.string(SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES),
        index,
      );
      const afterFlag = reader.u8();
      if (afterFlag > 1) throw commandError(index, "after presence flag is invalid");
      const after = afterFlag === 1 ? decodeSheetPrecondition(reader, index, context) : null;
      context.registerCreate(index, sheetId);
      return Object.freeze({ kind: "sheet.create", sheetId, name, after });
    }
    case 1:
      return Object.freeze({
        kind: "sheet.rename",
        sheet: decodeSheetPrecondition(reader, index, context),
        name: decodedSheetName(reader.string(SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES), index),
      });
    case 2:
      return Object.freeze({
        kind: "sheet.delete",
        sheet: decodeSheetPrecondition(reader, index, context),
      });
    case 3: {
      const sheet = decodeSheetPrecondition(reader, index, context);
      const anchor = frozenPoint(reader.u32(), reader.u32());
      const rows = reader.u32();
      const columns = reader.u32();
      if (rows === 0 || columns === 0) {
        throw commandError(index, "cell block dimensions must be nonzero");
      }
      assertExtent(anchor.row, rows, "row", index);
      assertExtent(anchor.column, columns, "column", index);
      const count = context.addCells(index, rows, columns);
      const cells: SpreadsheetCellInput[] = [];
      for (let cellIndex = 0; cellIndex < count; cellIndex += 1) cells.push(reader.cell());
      return Object.freeze({
        kind: "cells.set",
        sheet,
        anchor,
        rows,
        columns,
        cells: Object.freeze(cells),
      });
    }
    case 4: {
      const sheet = decodeSheetPrecondition(reader, index, context);
      const start = frozenPoint(reader.u32(), reader.u32());
      const end = frozenPoint(reader.u32(), reader.u32());
      if (start.row > end.row || start.column > end.column) {
        throw commandError(index, "clear range endpoints are not ordered");
      }
      return Object.freeze({
        kind: "range.clear",
        sheet,
        range: Object.freeze({ start, end }),
      });
    }
    default:
      throw commandError(index, "unknown binary command tag");
  }
}

function encodeSheetPrecondition(
  writer: BinaryWriter,
  value: unknown,
  commandIndex: number,
  context: CommandContext,
): void {
  const input = plainRecord(value, `spreadsheet command ${commandIndex} sheet precondition`);
  if (input.kind === "generation") {
    exactKeys(
      input,
      ["creationOperationId", "kind", "sheetId"],
      `spreadsheet command ${commandIndex} sheet generation`,
    );
    writer.u8(0);
    writer.stableId(sheetObjectId(input.sheetId, "sheet generation sheetId"));
    writer.stableId(genericStableId(input.creationOperationId, "sheet creation operation id"));
    return;
  }
  if (input.kind === "created-in-batch") {
    exactKeys(
      input,
      ["createCommandIndex", "kind", "sheetId"],
      `spreadsheet command ${commandIndex} prior-create precondition`,
    );
    const sheetId = sheetObjectId(input.sheetId, "prior-create sheetId");
    const createCommandIndex = nonnegativeU32(
      input.createCommandIndex,
      "prior-create command index",
    );
    assertPriorCreate(context, commandIndex, createCommandIndex, sheetId);
    writer.u8(1);
    writer.stableId(sheetId);
    writer.u32(createCommandIndex);
    return;
  }
  throw commandError(commandIndex, "unknown sheet precondition kind");
}

function decodeSheetPrecondition(
  reader: BinaryReader,
  commandIndex: number,
  context: CommandContext,
): SpreadsheetSheetPrecondition {
  switch (reader.u8()) {
    case 0:
      return Object.freeze({
        kind: "generation",
        sheetId: reader.sheetObjectId(),
        creationOperationId: reader.genericStableId(),
      });
    case 1: {
      const sheetId = reader.sheetObjectId();
      const createCommandIndex = reader.u32();
      assertPriorCreate(context, commandIndex, createCommandIndex, sheetId);
      return Object.freeze({
        kind: "created-in-batch",
        sheetId,
        createCommandIndex,
      });
    }
    default:
      throw commandError(commandIndex, "unknown sheet precondition tag");
  }
}

function assertPriorCreate(
  context: CommandContext,
  commandIndex: number,
  createCommandIndex: number,
  sheetId: string,
): void {
  if (createCommandIndex >= commandIndex) {
    throw commandError(commandIndex, "prior-create reference must point to an earlier command");
  }
  if (context.createdByIndex.get(createCommandIndex) !== sheetId) {
    throw commandError(
      commandIndex,
      "prior-create reference must match the referenced create command and sheet id",
    );
  }
}

function batchRecord(input: unknown): SpreadsheetArtifactCommandBatch {
  const batch = plainRecord(input, "spreadsheet command batch");
  exactKeys(batch, ["commands", "version"], "spreadsheet command batch");
  if (batch.version !== SPREADSHEET_ARTIFACT_COMMAND_VERSION) {
    throw new TypeError("spreadsheet command batch version must be 1");
  }
  if (!Array.isArray(batch.commands)) throw new TypeError("commands must be an array");
  if (
    batch.commands.length < 1 ||
    batch.commands.length > SPREADSHEET_ARTIFACT_COMMAND_MAX_COMMANDS
  ) {
    throw new RangeError("spreadsheet command count is outside its limit");
  }
  return input as SpreadsheetArtifactCommandBatch;
}

function cellRange(value: unknown, index: number): SpreadsheetCellRange {
  const range = plainRecord(value, `spreadsheet command ${index} range`);
  exactKeys(range, ["end", "start"], `spreadsheet command ${index} range`);
  const start = point(range.start, `spreadsheet command ${index} range start`);
  const end = point(range.end, `spreadsheet command ${index} range end`);
  if (start.row > end.row || start.column > end.column) {
    throw commandError(index, "clear range endpoints are not ordered");
  }
  return { start, end };
}

function point(value: unknown, label: string): SpreadsheetCellPoint {
  const input = plainRecord(value, label);
  exactKeys(input, ["column", "row"], label);
  return {
    row: nonnegativeU32(input.row, `${label} row`),
    column: nonnegativeU32(input.column, `${label} column`),
  };
}

function frozenPoint(row: number, column: number): SpreadsheetCellPoint {
  return Object.freeze({ row, column });
}

function sheetName(value: unknown, index: number): string {
  if (typeof value !== "string") throw commandError(index, "sheet name must be a string");
  return decodedSheetName(value, index);
}

function decodedSheetName(value: string, index: number): string {
  const bytes = strictUtf8(value, "sheet name");
  const forbidden = /[\\/?*[\]:\0]/u.test(value);
  if (
    bytes.byteLength === 0 ||
    value.trim() !== value ||
    value.length > SPREADSHEET_ARTIFACT_SHEET_NAME_MAX_UTF16_UNITS ||
    forbidden
  ) {
    throw commandError(index, "sheet name does not match the public spreadsheet model");
  }
  return value;
}

function genericStableId(value: unknown, label: string): EditableArtifactStableId {
  if (typeof value !== "string" || !LOWER_HEX_ID.test(value) || /^0+$/u.test(value)) {
    throw new TypeError(`${label} must be nonzero fixed-width lowercase hexadecimal text`);
  }
  return value as EditableArtifactStableId;
}

function sheetObjectId(value: unknown, label: string): EditableArtifactStableId {
  const id = genericStableId(value, label);
  if (id.slice(0, 16) === UINT64_HEX_ZERO || id.slice(16) === UINT64_HEX_ZERO) {
    throw new TypeError(`${label} must have a nonzero namespace and counter`);
  }
  return id;
}

function positiveU32(value: unknown, label: string): number {
  const output = nonnegativeU32(value, label);
  if (output === 0) throw new TypeError(`${label} must be positive`);
  return output;
}

function nonnegativeU32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new TypeError(`${label} must be a uint32`);
  }
  return value as number;
}

function assertExtent(start: number, length: number, axis: string, index: number): void {
  if (length - 1 > UINT32_MAX - start) {
    throw commandError(index, `${axis} extent exceeds uint32 coordinates`);
  }
}

function safeLength(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} length is unsafe`);
  const length = Number(value);
  if (length > SPREADSHEET_ARTIFACT_COMMAND_MAX_BYTES - HEADER_BYTES - CHECKSUM_BYTES) {
    throw new RangeError(`${label} exceeds its byte limit`);
  }
  return length;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} contains unsupported symbol fields`);
  }
  const actual = (keys as string[]).sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
  }
}

function ownArrayElement(value: readonly unknown[], index: number, label: string): unknown {
  if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be dense`);
  return value[index];
}

function commandError(index: number, message: string): TypeError {
  return new TypeError(`spreadsheet command ${index}: ${message}`);
}

function strictUtf8(value: string, label: string): Uint8Array {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired surrogate`);
    }
  }
  return textEncoder.encode(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function readU64At(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index]!) << BigInt(index * 8);
  }
  return value;
}

const STANDARD_ERROR_TAGS = Object.freeze({
  "#NULL!": 0,
  "#DIV/0!": 1,
  "#VALUE!": 2,
  "#REF!": 3,
  "#NAME?": 4,
  "#NUM!": 5,
  "#N/A": 6,
  "#SPILL!": 7,
  "#CALC!": 8,
} satisfies Record<string, number>);

const STANDARD_ERRORS = Object.freeze([
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#SPILL!",
  "#CALC!",
] as const);

class BinaryWriter {
  private buffer: Uint8Array;
  private viewBuffer: DataView;
  private length = 0;

  constructor(private readonly maximum: number) {
    this.buffer = new Uint8Array(Math.min(1_024, maximum));
    this.viewBuffer = new DataView(this.buffer.buffer);
  }

  view(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  u8(value: number): void {
    this.reserve(1);
    this.viewBuffer.setUint8(this.length, value);
    this.length += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.viewBuffer.setUint16(this.length, value, true);
    this.length += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.viewBuffer.setUint32(this.length, value, true);
    this.length += 4;
  }

  u64(value: bigint): void {
    this.reserve(8);
    this.viewBuffer.setBigUint64(this.length, value, true);
    this.length += 8;
  }

  i64(value: bigint): void {
    this.reserve(8);
    this.viewBuffer.setBigInt64(this.length, value, true);
    this.length += 8;
  }

  f64(value: number): void {
    this.reserve(8);
    this.viewBuffer.setFloat64(this.length, value === 0 ? 0 : value, true);
    this.length += 8;
  }

  stableId(value: EditableArtifactStableId): void {
    // Text is namespace || counter; canonical model bytes are counter LE then
    // namespace LE, matching Rust `StableId::to_le_bytes`.
    this.u64(BigInt(`0x${value.slice(16)}`));
    this.u64(BigInt(`0x${value.slice(0, 16)}`));
  }

  string(value: string, maximum: number): void {
    const bytes = strictUtf8(value, "spreadsheet string");
    if (bytes.byteLength > maximum)
      throw new RangeError("spreadsheet string exceeds its byte limit");
    this.u32(bytes.byteLength);
    this.bytes(bytes);
  }

  cell(value: unknown): void {
    if (isFormulaCell(value)) {
      const cell = plainRecord(value, "formula cell");
      exactKeys(cell, ["cached", "formula"], "formula cell");
      if (typeof cell.formula !== "string" || cell.formula.length === 0) {
        throw new TypeError("formula source must be a nonempty string");
      }
      this.u8(1);
      this.string(cell.formula, SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES);
      this.scalar(cell.cached);
      return;
    }
    this.u8(0);
    this.scalar(value);
  }

  private scalar(value: unknown): void {
    if (value === null) {
      this.u8(0);
    } else if (value === false) {
      this.u8(1);
    } else if (value === true) {
      this.u8(2);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("spreadsheet numbers must be finite");
      this.u8(3);
      this.f64(value);
    } else if (typeof value === "string") {
      this.u8(4);
      this.string(value, SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES);
    } else if (isDateValue(value)) {
      const date = plainRecord(value, "date cell");
      exactKeys(date, ["date"], "date cell");
      this.u8(6);
      this.i64(BigInt(canonicalDateMilliseconds(date.date)));
    } else if (isFormulaError(value)) {
      const error = plainRecord(value, "formula error");
      exactKeys(error, ["error"], "formula error");
      this.u8(5);
      const tag = STANDARD_ERROR_TAGS[error.error as keyof typeof STANDARD_ERROR_TAGS];
      if (tag !== undefined) {
        this.u8(tag);
      } else {
        this.u8(9);
        this.string(error.error as string, SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES);
      }
    } else {
      throw new TypeError("spreadsheet cell has an unsupported value shape");
    }
  }

  bytes(value: Uint8Array): void {
    this.reserve(value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  private reserve(additional: number): void {
    const needed = this.length + additional;
    if (!Number.isSafeInteger(needed) || needed > this.maximum) {
      throw new RangeError("spreadsheet command envelope exceeds its byte limit");
    }
    if (needed <= this.buffer.byteLength) return;
    let size = Math.max(1, this.buffer.byteLength);
    while (size < needed) size = Math.min(this.maximum, size * 2);
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.viewBuffer = new DataView(next.buffer);
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u16(): number {
    const bytes = this.bytes(2);
    return bytes[0]! | (bytes[1]! << 8);
  }

  u32(): number {
    const bytes = this.bytes(4);
    return bytes[0]! + bytes[1]! * 2 ** 8 + bytes[2]! * 2 ** 16 + bytes[3]! * 2 ** 24;
  }

  u64(): bigint {
    const bytes = this.bytes(8);
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(bytes[index]!) << BigInt(index * 8);
    }
    return value;
  }

  i64(): bigint {
    const bytes = this.bytes(8);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, true);
  }

  f64(): number {
    const bytes = this.bytes(8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(
      0,
      true,
    );
    if (!Number.isFinite(value)) throw new TypeError("spreadsheet numbers must be finite");
    if (Object.is(value, -0)) {
      throw new TypeError("spreadsheet numbers must encode zero with a positive sign");
    }
    return value;
  }

  sheetObjectId(): EditableArtifactStableId {
    return sheetObjectId(this.stableIdText(), "sheet id");
  }

  genericStableId(): EditableArtifactStableId {
    return genericStableId(this.stableIdText(), "stable id");
  }

  string(maximum: number): string {
    const length = this.u32();
    if (length > maximum) throw new RangeError("spreadsheet string exceeds its byte limit");
    return textDecoder.decode(this.bytes(length));
  }

  cell(): SpreadsheetCellInput {
    const formulaTag = this.u8();
    if (formulaTag > 1) throw new TypeError("spreadsheet formula presence tag is invalid");
    const formula =
      formulaTag === 1
        ? this.nonemptyFormula(this.string(SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES))
        : null;
    const cached = this.scalar();
    return formula === null ? cached : Object.freeze({ formula, cached });
  }

  done(message: string): void {
    if (this.offset !== this.input.byteLength) throw new TypeError(message);
  }

  bytes(length: number): Uint8Array {
    const end = this.offset + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > this.input.byteLength) {
      throw new TypeError("truncated spreadsheet command envelope");
    }
    const result = this.input.subarray(this.offset, end);
    this.offset = end;
    return result;
  }

  private stableIdText(): string {
    const counter = this.u64().toString(16).padStart(16, "0");
    const namespace = this.u64().toString(16).padStart(16, "0");
    return `${namespace}${counter}`;
  }

  private nonemptyFormula(value: string): string {
    if (value.length === 0) throw new TypeError("formula source must not be empty");
    return value;
  }

  private scalar(): SpreadsheetCellScalar {
    switch (this.u8()) {
      case 0:
        return null;
      case 1:
        return false;
      case 2:
        return true;
      case 3:
        return this.f64();
      case 4:
        return this.string(SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES);
      case 5: {
        const tag = this.u8();
        if (tag <= 8) return Object.freeze({ error: STANDARD_ERRORS[tag]! });
        if (tag === 9) {
          return Object.freeze({
            error: this.string(SPREADSHEET_ARTIFACT_COMMAND_MAX_STRING_BYTES),
          });
        }
        throw new TypeError("spreadsheet formula error tag is invalid");
      }
      case 6:
        return Object.freeze({
          date: canonicalSpreadsheetDateFromMilliseconds(this.i64()),
        });
      default:
        throw new TypeError("spreadsheet scalar tag is invalid");
    }
  }
}

function isFormulaCell(value: unknown): value is SpreadsheetFormulaCell {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "formula")
  );
}

function isFormulaError(value: unknown): value is SpreadsheetFormulaError {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).error === "string"
  );
}

function isDateValue(value: unknown): value is SpreadsheetDateValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "date")
  );
}

function canonicalDateMilliseconds(value: unknown): number {
  return canonicalSpreadsheetDateMilliseconds(value);
}
