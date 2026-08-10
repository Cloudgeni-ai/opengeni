import { spreadsheetSheetId, type EditableArtifactStableId } from "./spreadsheet-artifact-commands";
import {
  canonicalSpreadsheetDateFromMilliseconds,
  canonicalSpreadsheetDateMilliseconds,
} from "./spreadsheet-artifact-date";

/** Canonical private kernel query/projection ABI shared by browser and native bindings. */
export const SPREADSHEET_ARTIFACT_QUERY_VERSION = 1 as const;
export const SPREADSHEET_ARTIFACT_QUERY_MAX_BYTES = 68;
export const SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES = 8 * 1024 * 1024;
export const SPREADSHEET_ARTIFACT_VIEWPORT_MAX_AREA = 1_048_576;
export const SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS = 262_144;
export const SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS = 10_000;
export const SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES = 4 * 1024 * 1024;
export const SPREADSHEET_ARTIFACT_VIEWPORT_MIN_RESPONSE_BYTES = 92;
export const SPREADSHEET_ARTIFACT_METADATA_MIN_RESPONSE_BYTES = 48;

const QUERY_MAGIC = new TextEncoder().encode("OGAKQ001");
const PROJECTION_MAGIC = new TextEncoder().encode("OGAKV001");
const QUERY_HEADER_BYTES = 28;
const PROJECTION_HEADER_BYTES = 36;
const CHECKSUM_BYTES = 8;
const VIEWPORT_QUERY_PAYLOAD_BYTES = 32;
const VIEWPORT_PROJECTION_PREFIX_BYTES = 48;
const METADATA_PROJECTION_PREFIX_BYTES = 4;
const GENERATIONS_FLAG = 1;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type SpreadsheetArtifactViewportQuery = Readonly<{
  sheetId: EditableArtifactStableId;
  startRow: number;
  startColumn: number;
  rowCount: number;
  columnCount: number;
  maxCells: number;
  /** Entire OGAKV001 envelope, not merely its payload. */
  maxBytes: number;
}>;

export type SpreadsheetArtifactMetadataQuery = Readonly<{
  maxSheets: number;
  /** Entire OGAKV001 envelope, not merely its payload. */
  maxBytes: number;
}>;

export type SpreadsheetArtifactKernelQuery =
  | Readonly<{ kind: "viewport"; query: SpreadsheetArtifactViewportQuery }>
  | Readonly<{
      kind: "workbook-metadata";
      query: SpreadsheetArtifactMetadataQuery;
    }>;

export type SpreadsheetArtifactFormulaError =
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

export type SpreadsheetArtifactProjectedCellValue =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "date"; value: string }>
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "error"; value: SpreadsheetArtifactFormulaError }>;

export type SpreadsheetArtifactProjectedCell = Readonly<{
  /** Absolute zero-based row, reconstructed from the relative wire coordinate. */
  row: number;
  /** Absolute zero-based column, reconstructed from the relative wire coordinate. */
  column: number;
  formula: string | null;
  value: SpreadsheetArtifactProjectedCellValue;
}>;

/** Complete and non-truncated. A limit breach is an error, never a partial response. */
export type SpreadsheetArtifactViewportProjection = Readonly<{
  revision: bigint;
  sheetId: EditableArtifactStableId;
  generationId: EditableArtifactStableId | null;
  startRow: number;
  startColumn: number;
  rowCount: number;
  columnCount: number;
  cells: readonly SpreadsheetArtifactProjectedCell[];
}>;

export type SpreadsheetArtifactUsedBounds = Readonly<{
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}>;

export type SpreadsheetArtifactSheetMetadata = Readonly<{
  sheetId: EditableArtifactStableId;
  generationId: EditableArtifactStableId | null;
  name: string;
  usedBounds: SpreadsheetArtifactUsedBounds | null;
}>;

/**
 * Version 1 deliberately models no row/column dimensions, hidden state, or
 * merges. It also carries no style projection. These are false capability
 * facts, not omitted authoritative data.
 */
export type SpreadsheetArtifactModeledFeatures = Readonly<{
  dimensions: false;
  hidden: false;
  merges: false;
}>;

/** Complete ordered workbook catalog; never a truncated prefix. */
export type SpreadsheetArtifactMetadataProjection = Readonly<{
  revision: bigint;
  modeledFeatures: SpreadsheetArtifactModeledFeatures;
  sheets: readonly SpreadsheetArtifactSheetMetadata[];
}>;

export type SpreadsheetArtifactKernelProjection =
  | Readonly<{
      kind: "viewport";
      projection: SpreadsheetArtifactViewportProjection;
    }>
  | Readonly<{
      kind: "workbook-metadata";
      projection: SpreadsheetArtifactMetadataProjection;
    }>;

export function encodeSpreadsheetViewportKernelQuery(
  input: SpreadsheetArtifactViewportQuery,
): Uint8Array {
  const query = normalizeViewportQuery(input);
  const payload = new FixedWriter(VIEWPORT_QUERY_PAYLOAD_BYTES);
  payload.stableId(query.sheetId);
  payload.u32(query.startRow);
  payload.u32(query.startColumn);
  payload.u32(query.rowCount);
  payload.u32(query.columnCount);
  return encodeQueryFrame(0, query.maxCells, query.maxBytes, payload.finish());
}

export function encodeSpreadsheetMetadataKernelQuery(
  input: SpreadsheetArtifactMetadataQuery,
): Uint8Array {
  const query = normalizeMetadataQuery(input);
  return encodeQueryFrame(1, query.maxSheets, query.maxBytes, new Uint8Array());
}

export function encodeSpreadsheetArtifactKernelQuery(
  input: SpreadsheetArtifactKernelQuery,
): Uint8Array {
  const envelope = exactRecord(input, "spreadsheet kernel query");
  exactKeys(envelope, ["kind", "query"], "spreadsheet kernel query");
  if (envelope.kind === "viewport") {
    return encodeSpreadsheetViewportKernelQuery(envelope.query as SpreadsheetArtifactViewportQuery);
  }
  if (envelope.kind === "workbook-metadata") {
    return encodeSpreadsheetMetadataKernelQuery(envelope.query as SpreadsheetArtifactMetadataQuery);
  }
  throw queryError("unknown spreadsheet kernel query kind");
}

export function decodeSpreadsheetArtifactKernelQuery(
  bytes: Uint8Array,
): SpreadsheetArtifactKernelQuery {
  const frame = decodeQueryFrame(bytes);
  if (frame.kind === 0) {
    if (frame.payload.byteLength < VIEWPORT_QUERY_PAYLOAD_BYTES) {
      throw queryError("spreadsheet viewport query is truncated");
    }
    if (frame.payload.byteLength > VIEWPORT_QUERY_PAYLOAD_BYTES) {
      throw queryError("spreadsheet viewport query contains trailing bytes");
    }
    const reader = new Reader(frame.payload);
    const query = normalizeViewportQuery({
      sheetId: reader.stableId("viewport sheet id"),
      startRow: reader.u32(),
      startColumn: reader.u32(),
      rowCount: reader.u32(),
      columnCount: reader.u32(),
      maxCells: frame.maxItems,
      maxBytes: frame.maxBytes,
    });
    reader.done("spreadsheet viewport query contains trailing bytes");
    return Object.freeze({ kind: "viewport", query });
  }
  if (frame.payload.byteLength !== 0) {
    throw queryError("spreadsheet metadata query contains trailing bytes");
  }
  return Object.freeze({
    kind: "workbook-metadata",
    query: normalizeMetadataQuery({
      maxSheets: frame.maxItems,
      maxBytes: frame.maxBytes,
    }),
  });
}

export function assertCanonicalSpreadsheetArtifactKernelQueryBytes(bytes: Uint8Array): Uint8Array {
  const canonical = encodeSpreadsheetArtifactKernelQuery(
    decodeSpreadsheetArtifactKernelQuery(bytes),
  );
  if (!equalBytes(bytes, canonical)) throw queryError("spreadsheet kernel query is not canonical");
  return bytes;
}

export function encodeSpreadsheetViewportKernelProjection(
  input: SpreadsheetArtifactViewportProjection,
  maximumBytes = SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
): Uint8Array {
  const projection = normalizeViewportProjection(input);
  const maximum = effectiveProjectionMaximum(
    maximumBytes,
    SPREADSHEET_ARTIFACT_VIEWPORT_MIN_RESPONSE_BYTES,
  );
  const payload = new DynamicWriter(maximum - PROJECTION_HEADER_BYTES - CHECKSUM_BYTES);
  payload.stableId(projection.sheetId);
  payload.optionalStableId(projection.generationId);
  payload.u32(projection.startRow);
  payload.u32(projection.startColumn);
  payload.u32(projection.rowCount);
  payload.u32(projection.columnCount);
  for (const cell of projection.cells) {
    payload.u32(cell.row - projection.startRow);
    payload.u32(cell.column - projection.startColumn);
    payload.cell(cell);
  }
  return encodeProjectionFrame(
    0,
    projection.revision,
    projection.generationId === null ? 0 : GENERATIONS_FLAG,
    projection.cells.length,
    payload.finish(),
    maximum,
  );
}

export function encodeSpreadsheetMetadataKernelProjection(
  input: SpreadsheetArtifactMetadataProjection,
  maximumBytes = SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
): Uint8Array {
  const projection = normalizeMetadataProjection(input);
  const maximum = effectiveProjectionMaximum(
    maximumBytes,
    SPREADSHEET_ARTIFACT_METADATA_MIN_RESPONSE_BYTES,
  );
  const payload = new DynamicWriter(maximum - PROJECTION_HEADER_BYTES - CHECKSUM_BYTES);
  payload.u32(0);
  for (const sheet of projection.sheets) {
    payload.stableId(sheet.sheetId);
    payload.optionalStableId(sheet.generationId);
    payload.string(sheet.name);
    if (sheet.usedBounds === null) {
      payload.u8(0);
    } else {
      payload.u8(1);
      payload.u32(sheet.usedBounds.startRow);
      payload.u32(sheet.usedBounds.startColumn);
      payload.u32(sheet.usedBounds.endRow);
      payload.u32(sheet.usedBounds.endColumn);
    }
  }
  const generations = projection.sheets.length > 0 && projection.sheets[0]!.generationId !== null;
  return encodeProjectionFrame(
    1,
    projection.revision,
    generations ? GENERATIONS_FLAG : 0,
    projection.sheets.length,
    payload.finish(),
    maximum,
  );
}

export function encodeSpreadsheetArtifactKernelProjection(
  input: SpreadsheetArtifactKernelProjection,
  maximumBytes = SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
): Uint8Array {
  const envelope = exactRecord(input, "spreadsheet kernel projection");
  exactKeys(envelope, ["kind", "projection"], "spreadsheet kernel projection");
  if (envelope.kind === "viewport") {
    return encodeSpreadsheetViewportKernelProjection(
      envelope.projection as SpreadsheetArtifactViewportProjection,
      maximumBytes,
    );
  }
  if (envelope.kind === "workbook-metadata") {
    return encodeSpreadsheetMetadataKernelProjection(
      envelope.projection as SpreadsheetArtifactMetadataProjection,
      maximumBytes,
    );
  }
  throw projectionError("unknown spreadsheet kernel projection kind");
}

export function decodeSpreadsheetArtifactKernelProjection(
  bytes: Uint8Array,
): SpreadsheetArtifactKernelProjection {
  const frame = decodeProjectionFrame(bytes);
  if (frame.kind === 0) {
    return Object.freeze({
      kind: "viewport",
      projection: decodeViewportPayload(frame),
    });
  }
  return Object.freeze({
    kind: "workbook-metadata",
    projection: decodeMetadataPayload(frame),
  });
}

export function decodeSpreadsheetViewportKernelProjection(
  bytes: Uint8Array,
  expected?: SpreadsheetArtifactViewportQuery,
): SpreadsheetArtifactViewportProjection {
  const decoded = decodeSpreadsheetArtifactKernelProjection(bytes);
  if (decoded.kind !== "viewport") throw projectionError("expected a viewport projection");
  if (expected !== undefined) {
    const query = normalizeViewportQuery(expected);
    enforceProjectionEnvelopeLimit(bytes, query.maxBytes);
    if (
      decoded.projection.cells.length >
      Math.min(query.maxCells, SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS)
    ) {
      throw projectionError("viewport projection exceeds its requested cell limit");
    }
    if (
      decoded.projection.sheetId !== query.sheetId ||
      decoded.projection.startRow !== query.startRow ||
      decoded.projection.startColumn !== query.startColumn ||
      decoded.projection.rowCount !== query.rowCount ||
      decoded.projection.columnCount !== query.columnCount
    ) {
      throw projectionError("viewport projection does not match its query");
    }
  }
  return decoded.projection;
}

export function decodeSpreadsheetMetadataKernelProjection(
  bytes: Uint8Array,
  expected?: SpreadsheetArtifactMetadataQuery,
): SpreadsheetArtifactMetadataProjection {
  const decoded = decodeSpreadsheetArtifactKernelProjection(bytes);
  if (decoded.kind !== "workbook-metadata") {
    throw projectionError("expected a workbook metadata projection");
  }
  if (expected !== undefined) {
    const query = normalizeMetadataQuery(expected);
    enforceProjectionEnvelopeLimit(bytes, query.maxBytes);
    if (
      decoded.projection.sheets.length >
      Math.min(query.maxSheets, SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS)
    ) {
      throw projectionError("metadata projection exceeds its requested sheet limit");
    }
  }
  return decoded.projection;
}

export function assertCanonicalSpreadsheetArtifactKernelProjectionBytes(
  bytes: Uint8Array,
): Uint8Array {
  const canonical = encodeSpreadsheetArtifactKernelProjection(
    decodeSpreadsheetArtifactKernelProjection(bytes),
  );
  if (!equalBytes(bytes, canonical)) {
    throw projectionError("spreadsheet kernel projection is not canonical");
  }
  return bytes;
}

type ProjectionFrame = Readonly<{
  kind: 0 | 1;
  flags: number;
  revision: bigint;
  itemCount: number;
  payload: Uint8Array;
}>;

function encodeQueryFrame(
  kind: 0 | 1,
  maxItems: number,
  maxBytes: number,
  payload: Uint8Array,
): Uint8Array {
  const output = new FixedWriter(QUERY_HEADER_BYTES + payload.byteLength + CHECKSUM_BYTES);
  output.bytes(QUERY_MAGIC);
  output.u16(SPREADSHEET_ARTIFACT_QUERY_VERSION);
  output.u16(0);
  output.u8(kind);
  output.bytes(new Uint8Array(3));
  output.u32(maxItems);
  output.u32(maxBytes);
  output.u32(payload.byteLength);
  output.bytes(payload);
  output.u64(fnv1a64(output.view()));
  const bytes = output.finish();
  if (bytes.byteLength > SPREADSHEET_ARTIFACT_QUERY_MAX_BYTES) {
    throw queryError("spreadsheet kernel query exceeds its byte limit");
  }
  return bytes;
}

function decodeQueryFrame(bytes: Uint8Array): Readonly<{
  kind: 0 | 1;
  maxItems: number;
  maxBytes: number;
  payload: Uint8Array;
}> {
  requireBytes(bytes, "spreadsheet kernel query");
  if (bytes.byteLength > SPREADSHEET_ARTIFACT_QUERY_MAX_BYTES) {
    throw queryError("spreadsheet kernel query exceeds its byte limit");
  }
  if (bytes.byteLength < QUERY_HEADER_BYTES + CHECKSUM_BYTES) {
    throw queryError("spreadsheet kernel query is truncated");
  }
  const reader = new Reader(bytes);
  if (!equalBytes(reader.bytes(8), QUERY_MAGIC))
    throw queryError("spreadsheet query magic is invalid");
  const version = reader.u16();
  if (version !== SPREADSHEET_ARTIFACT_QUERY_VERSION) {
    throw queryError(`unsupported spreadsheet query version: ${version}`);
  }
  if (reader.u16() !== 0) throw queryError("spreadsheet query reserved flags must be zero");
  const kindTag = reader.u8();
  if (kindTag > 1) throw queryError("spreadsheet query kind is invalid");
  if (reader.u8() !== 0 || reader.u8() !== 0 || reader.u8() !== 0) {
    throw queryError("spreadsheet query reserved bytes must be zero");
  }
  const maxItems = reader.u32();
  const maxBytes = reader.u32();
  const payloadLength = reader.u32();
  const expected = QUERY_HEADER_BYTES + payloadLength + CHECKSUM_BYTES;
  if (bytes.byteLength < expected) throw queryError("spreadsheet kernel query is truncated");
  if (bytes.byteLength > expected)
    throw queryError("spreadsheet kernel query contains trailing bytes");
  const payload = reader.bytes(payloadLength);
  const checksum = reader.u64();
  reader.done("spreadsheet kernel query contains trailing bytes");
  if (checksum !== fnv1a64(bytes.subarray(0, -CHECKSUM_BYTES))) {
    throw queryError("spreadsheet kernel query checksum does not match");
  }
  return Object.freeze({ kind: kindTag as 0 | 1, maxItems, maxBytes, payload });
}

function encodeProjectionFrame(
  kind: 0 | 1,
  revision: bigint,
  flags: number,
  itemCount: number,
  payload: Uint8Array,
  maximum: number,
): Uint8Array {
  const output = new FixedWriter(PROJECTION_HEADER_BYTES + payload.byteLength + CHECKSUM_BYTES);
  output.bytes(PROJECTION_MAGIC);
  output.u16(SPREADSHEET_ARTIFACT_QUERY_VERSION);
  output.u16(flags);
  output.u8(kind);
  output.bytes(new Uint8Array(3));
  output.u64(revision);
  output.u32(itemCount);
  output.u64(BigInt(payload.byteLength));
  output.bytes(payload);
  output.u64(fnv1a64(output.view()));
  const bytes = output.finish();
  if (bytes.byteLength > maximum || bytes.byteLength > SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES) {
    throw projectionError("spreadsheet kernel projection exceeds its byte limit");
  }
  return bytes;
}

function decodeProjectionFrame(bytes: Uint8Array): ProjectionFrame {
  requireBytes(bytes, "spreadsheet kernel projection");
  if (bytes.byteLength > SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES) {
    throw projectionError("spreadsheet kernel projection exceeds its byte limit");
  }
  if (bytes.byteLength < PROJECTION_HEADER_BYTES + CHECKSUM_BYTES) {
    throw projectionError("spreadsheet kernel projection is truncated");
  }
  const reader = new Reader(bytes);
  if (!equalBytes(reader.bytes(8), PROJECTION_MAGIC)) {
    throw projectionError("spreadsheet projection magic is invalid");
  }
  const version = reader.u16();
  if (version !== SPREADSHEET_ARTIFACT_QUERY_VERSION) {
    throw projectionError(`unsupported spreadsheet projection version: ${version}`);
  }
  const flags = reader.u16();
  if ((flags & ~GENERATIONS_FLAG) !== 0) {
    throw projectionError("spreadsheet projection flags are noncanonical");
  }
  const kindTag = reader.u8();
  if (kindTag > 1) throw projectionError("spreadsheet projection kind is invalid");
  if (reader.u8() !== 0 || reader.u8() !== 0 || reader.u8() !== 0) {
    throw projectionError("spreadsheet projection reserved bytes must be zero");
  }
  const revision = reader.u64();
  const itemCount = reader.u32();
  const payloadLengthBig = reader.u64();
  if (payloadLengthBig > BigInt(SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES)) {
    throw projectionError("spreadsheet projection payload exceeds its byte limit");
  }
  const payloadLength = Number(payloadLengthBig);
  const expected = PROJECTION_HEADER_BYTES + payloadLength + CHECKSUM_BYTES;
  if (bytes.byteLength < expected)
    throw projectionError("spreadsheet kernel projection is truncated");
  if (bytes.byteLength > expected) {
    throw projectionError("spreadsheet kernel projection contains trailing bytes");
  }
  const payload = reader.bytes(payloadLength);
  const checksum = reader.u64();
  reader.done("spreadsheet kernel projection contains trailing bytes");
  if (checksum !== fnv1a64(bytes.subarray(0, -CHECKSUM_BYTES))) {
    throw projectionError("spreadsheet kernel projection checksum does not match");
  }
  return Object.freeze({
    kind: kindTag as 0 | 1,
    flags,
    revision,
    itemCount,
    payload,
  });
}

function decodeViewportPayload(frame: ProjectionFrame): SpreadsheetArtifactViewportProjection {
  if (frame.itemCount > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS) {
    throw projectionError("viewport projection exceeds its hard cell limit");
  }
  if (frame.payload.byteLength < VIEWPORT_PROJECTION_PREFIX_BYTES + frame.itemCount * 10) {
    throw projectionError("viewport projection payload is truncated");
  }
  const reader = new Reader(frame.payload);
  const sheetId = reader.stableId("viewport sheet id");
  const generationId = reader.optionalStableId((frame.flags & GENERATIONS_FLAG) !== 0);
  const startRow = reader.u32();
  const startColumn = reader.u32();
  const rowCount = reader.u32();
  const columnCount = reader.u32();
  validateViewportGeometry(startRow, startColumn, rowCount, columnCount);
  const cells: SpreadsheetArtifactProjectedCell[] = [];
  let previousOrdinal = -1;
  for (let index = 0; index < frame.itemCount; index += 1) {
    const relativeRow = reader.u32();
    const relativeColumn = reader.u32();
    if (relativeRow >= rowCount || relativeColumn >= columnCount) {
      throw projectionError("viewport cell lies outside its response extent");
    }
    const ordinal = relativeRow * columnCount + relativeColumn;
    if (!Number.isSafeInteger(ordinal) || ordinal <= previousOrdinal) {
      throw projectionError("viewport cells are not unique strict row-major entries");
    }
    previousOrdinal = ordinal;
    const formula = reader.formula();
    const value = reader.cellValue();
    if (formula === null && value.kind === "empty") {
      throw projectionError("sparse viewport contains an empty cell");
    }
    cells.push(
      Object.freeze({
        row: startRow + relativeRow,
        column: startColumn + relativeColumn,
        formula,
        value,
      }),
    );
  }
  reader.done("viewport projection payload contains trailing bytes");
  return Object.freeze({
    revision: frame.revision,
    sheetId,
    generationId,
    startRow,
    startColumn,
    rowCount,
    columnCount,
    cells: Object.freeze(cells),
  });
}

function decodeMetadataPayload(frame: ProjectionFrame): SpreadsheetArtifactMetadataProjection {
  if (frame.itemCount > SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS) {
    throw projectionError("metadata projection exceeds its hard sheet limit");
  }
  if (frame.payload.byteLength < METADATA_PROJECTION_PREFIX_BYTES + frame.itemCount * 37) {
    throw projectionError("metadata projection payload is truncated");
  }
  const reader = new Reader(frame.payload);
  if (reader.u32() !== 0) {
    throw projectionError("metadata projection contains unknown modeled feature bits");
  }
  const hasGenerations = (frame.flags & GENERATIONS_FLAG) !== 0;
  if (frame.itemCount === 0 && hasGenerations) {
    throw projectionError("empty metadata projection must not set the generations flag");
  }
  const sheets: SpreadsheetArtifactSheetMetadata[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let index = 0; index < frame.itemCount; index += 1) {
    const sheetId = reader.stableId("metadata sheet id");
    if (ids.has(sheetId)) throw projectionError("metadata projection contains duplicate sheet ids");
    ids.add(sheetId);
    const generationId = reader.optionalStableId(hasGenerations);
    const name = validateSheetName(reader.string(), "metadata sheet name");
    const foldedName = name.toLowerCase();
    if (names.has(foldedName)) {
      throw projectionError("metadata projection contains duplicate case-insensitive sheet names");
    }
    names.add(foldedName);
    const boundsTag = reader.u8();
    if (boundsTag > 1) throw projectionError("metadata used-bounds tag is invalid");
    let usedBounds: SpreadsheetArtifactUsedBounds | null = null;
    if (boundsTag === 1) {
      const startRow = reader.u32();
      const startColumn = reader.u32();
      const endRow = reader.u32();
      const endColumn = reader.u32();
      if (startRow > endRow || startColumn > endColumn) {
        throw projectionError("metadata used bounds are not ordered");
      }
      usedBounds = Object.freeze({ startRow, startColumn, endRow, endColumn });
    }
    sheets.push(Object.freeze({ sheetId, generationId, name, usedBounds }));
  }
  reader.done("metadata projection payload contains trailing bytes");
  return Object.freeze({
    revision: frame.revision,
    modeledFeatures: MODELED_FEATURES_NONE,
    sheets: Object.freeze(sheets),
  });
}

function normalizeViewportQuery(input: unknown): SpreadsheetArtifactViewportQuery {
  const query = exactRecord(input, "spreadsheet viewport query");
  exactKeys(
    query,
    ["columnCount", "maxBytes", "maxCells", "rowCount", "sheetId", "startColumn", "startRow"],
    "spreadsheet viewport query",
  );
  const sheetId = spreadsheetSheetId(requireString(query.sheetId, "viewport sheetId"));
  const startRow = uint32(query.startRow, "viewport startRow");
  const startColumn = uint32(query.startColumn, "viewport startColumn");
  const rowCount = positiveUint32(query.rowCount, "viewport rowCount");
  const columnCount = positiveUint32(query.columnCount, "viewport columnCount");
  validateViewportGeometry(startRow, startColumn, rowCount, columnCount);
  const maxCells = positiveUint32(query.maxCells, "viewport maxCells");
  const maxBytes = positiveUint32(query.maxBytes, "viewport maxBytes");
  if (maxBytes < SPREADSHEET_ARTIFACT_VIEWPORT_MIN_RESPONSE_BYTES) {
    throw queryError("viewport maxBytes cannot fit an empty response");
  }
  return Object.freeze({
    sheetId,
    startRow,
    startColumn,
    rowCount,
    columnCount,
    maxCells,
    maxBytes,
  });
}

function normalizeMetadataQuery(input: unknown): SpreadsheetArtifactMetadataQuery {
  const query = exactRecord(input, "spreadsheet metadata query");
  exactKeys(query, ["maxBytes", "maxSheets"], "spreadsheet metadata query");
  const maxSheets = positiveUint32(query.maxSheets, "metadata maxSheets");
  const maxBytes = positiveUint32(query.maxBytes, "metadata maxBytes");
  if (maxBytes < SPREADSHEET_ARTIFACT_METADATA_MIN_RESPONSE_BYTES) {
    throw queryError("metadata maxBytes cannot fit an empty response");
  }
  return Object.freeze({ maxSheets, maxBytes });
}

function normalizeViewportProjection(input: unknown): SpreadsheetArtifactViewportProjection {
  const projection = exactRecord(input, "spreadsheet viewport projection");
  exactKeys(
    projection,
    [
      "cells",
      "columnCount",
      "generationId",
      "revision",
      "rowCount",
      "sheetId",
      "startColumn",
      "startRow",
    ],
    "spreadsheet viewport projection",
  );
  const revision = uint64(projection.revision, "viewport revision");
  const sheetId = spreadsheetSheetId(requireString(projection.sheetId, "viewport sheetId"));
  const generationId = nullableGenerationId(projection.generationId, "viewport generationId");
  const startRow = uint32(projection.startRow, "viewport startRow");
  const startColumn = uint32(projection.startColumn, "viewport startColumn");
  const rowCount = positiveUint32(projection.rowCount, "viewport rowCount");
  const columnCount = positiveUint32(projection.columnCount, "viewport columnCount");
  validateViewportGeometry(startRow, startColumn, rowCount, columnCount);
  if (!Array.isArray(projection.cells)) throw projectionError("viewport cells must be an array");
  if (projection.cells.length > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS) {
    throw projectionError("viewport projection exceeds its hard cell limit");
  }
  const cells: SpreadsheetArtifactProjectedCell[] = [];
  let previousOrdinal = -1;
  for (let index = 0; index < projection.cells.length; index += 1) {
    const cell = normalizeProjectedCell(ownArrayElement(projection.cells, index, "viewport cells"));
    if (
      cell.row < startRow ||
      cell.row >= startRow + rowCount ||
      cell.column < startColumn ||
      cell.column >= startColumn + columnCount
    ) {
      throw projectionError("viewport cell lies outside its response extent");
    }
    const ordinal = (cell.row - startRow) * columnCount + (cell.column - startColumn);
    if (!Number.isSafeInteger(ordinal) || ordinal <= previousOrdinal) {
      throw projectionError("viewport cells are not unique strict row-major entries");
    }
    previousOrdinal = ordinal;
    if (cell.formula === null && cell.value.kind === "empty") {
      throw projectionError("sparse viewport contains an empty cell");
    }
    cells.push(cell);
  }
  return Object.freeze({
    revision,
    sheetId,
    generationId,
    startRow,
    startColumn,
    rowCount,
    columnCount,
    cells: Object.freeze(cells),
  });
}

function normalizeMetadataProjection(input: unknown): SpreadsheetArtifactMetadataProjection {
  const projection = exactRecord(input, "spreadsheet metadata projection");
  exactKeys(
    projection,
    ["modeledFeatures", "revision", "sheets"],
    "spreadsheet metadata projection",
  );
  const revision = uint64(projection.revision, "metadata revision");
  const features = exactRecord(projection.modeledFeatures, "metadata modeledFeatures");
  exactKeys(features, ["dimensions", "hidden", "merges"], "metadata modeledFeatures");
  if (features.dimensions !== false || features.hidden !== false || features.merges !== false) {
    throw projectionError("version 1 metadata modeled features must all be false");
  }
  if (!Array.isArray(projection.sheets)) throw projectionError("metadata sheets must be an array");
  if (projection.sheets.length > SPREADSHEET_ARTIFACT_METADATA_MAX_SHEETS) {
    throw projectionError("metadata projection exceeds its hard sheet limit");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const sheets: SpreadsheetArtifactSheetMetadata[] = [];
  let generationPresence: boolean | null = null;
  for (let index = 0; index < projection.sheets.length; index += 1) {
    const value = exactRecord(
      ownArrayElement(projection.sheets, index, "metadata sheets"),
      "metadata sheet",
    );
    exactKeys(value, ["generationId", "name", "sheetId", "usedBounds"], "metadata sheet");
    const sheetId = spreadsheetSheetId(requireString(value.sheetId, "metadata sheetId"));
    if (ids.has(sheetId)) throw projectionError("metadata projection contains duplicate sheet ids");
    ids.add(sheetId);
    const generationId = nullableGenerationId(value.generationId, "metadata generationId");
    const present = generationId !== null;
    if (generationPresence !== null && generationPresence !== present) {
      throw projectionError("metadata generations must be uniformly present or absent");
    }
    generationPresence = present;
    const name = validateSheetName(
      requireString(value.name, "metadata sheet name"),
      "metadata sheet name",
    );
    const foldedName = name.toLowerCase();
    if (names.has(foldedName)) {
      throw projectionError("metadata projection contains duplicate case-insensitive sheet names");
    }
    names.add(foldedName);
    const usedBounds = value.usedBounds === null ? null : normalizeUsedBounds(value.usedBounds);
    sheets.push(Object.freeze({ sheetId, generationId, name, usedBounds }));
  }
  return Object.freeze({
    revision,
    modeledFeatures: MODELED_FEATURES_NONE,
    sheets: Object.freeze(sheets),
  });
}

function normalizeProjectedCell(input: unknown): SpreadsheetArtifactProjectedCell {
  const cell = exactRecord(input, "projected cell");
  exactKeys(cell, ["column", "formula", "row", "value"], "projected cell");
  const row = uint32(cell.row, "projected cell row");
  const column = uint32(cell.column, "projected cell column");
  let formula: string | null;
  if (cell.formula === null) {
    formula = null;
  } else {
    formula = requireString(cell.formula, "projected cell formula");
    if (formula.length === 0) throw projectionError("projected cell formula must not be empty");
    boundedUtf8(
      formula,
      SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES,
      "projected cell formula",
    );
  }
  return Object.freeze({
    row,
    column,
    formula,
    value: normalizeProjectedValue(cell.value),
  });
}

function normalizeProjectedValue(input: unknown): SpreadsheetArtifactProjectedCellValue {
  const value = exactRecord(input, "projected cell value");
  if (value.kind === "empty") {
    exactKeys(value, ["kind"], "empty projected cell value");
    return EMPTY_VALUE;
  }
  if (value.kind === "boolean") {
    exactKeys(value, ["kind", "value"], "boolean projected cell value");
    if (typeof value.value !== "boolean") throw projectionError("boolean cell value is invalid");
    return Object.freeze({ kind: "boolean", value: value.value });
  }
  if (value.kind === "number") {
    exactKeys(value, ["kind", "value"], "number projected cell value");
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
      throw projectionError("number cell value must be finite");
    }
    return Object.freeze({
      kind: "number",
      value: value.value === 0 ? 0 : value.value,
    });
  }
  if (value.kind === "date") {
    exactKeys(value, ["kind", "value"], "date projected cell value");
    return Object.freeze({
      kind: "date",
      value: canonicalDateString(value.value),
    });
  }
  if (value.kind === "text") {
    exactKeys(value, ["kind", "value"], "text projected cell value");
    const text = requireString(value.value, "text cell value");
    boundedUtf8(text, SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES, "text cell value");
    return Object.freeze({ kind: "text", value: text });
  }
  if (value.kind === "error") {
    exactKeys(value, ["kind", "value"], "error projected cell value");
    return Object.freeze({
      kind: "error",
      value: normalizeFormulaError(value.value),
    });
  }
  throw projectionError("projected cell value kind is invalid");
}

function canonicalDateString(input: unknown): string {
  canonicalSpreadsheetDateMilliseconds(input);
  return input as string;
}

function normalizeFormulaError(input: unknown): SpreadsheetArtifactFormulaError {
  if (typeof input === "string" && FORMULA_ERROR_TAGS.has(input)) {
    return input as Exclude<SpreadsheetArtifactFormulaError, { custom: string }>;
  }
  const error = exactRecord(input, "custom formula error");
  exactKeys(error, ["custom"], "custom formula error");
  const custom = requireString(error.custom, "custom formula error");
  boundedUtf8(custom, SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES, "custom formula error");
  return Object.freeze({ custom });
}

function normalizeUsedBounds(input: unknown): SpreadsheetArtifactUsedBounds {
  const bounds = exactRecord(input, "metadata used bounds");
  exactKeys(bounds, ["endColumn", "endRow", "startColumn", "startRow"], "metadata used bounds");
  const startRow = uint32(bounds.startRow, "used bounds startRow");
  const startColumn = uint32(bounds.startColumn, "used bounds startColumn");
  const endRow = uint32(bounds.endRow, "used bounds endRow");
  const endColumn = uint32(bounds.endColumn, "used bounds endColumn");
  if (startRow > endRow || startColumn > endColumn) {
    throw projectionError("metadata used bounds are not ordered");
  }
  return Object.freeze({ startRow, startColumn, endRow, endColumn });
}

function validateViewportGeometry(
  startRow: number,
  startColumn: number,
  rowCount: number,
  columnCount: number,
): void {
  if (rowCount < 1 || columnCount < 1) {
    throw queryError("viewport extents must be nonzero");
  }
  if (rowCount - 1 > UINT32_MAX - startRow || columnCount - 1 > UINT32_MAX - startColumn) {
    throw queryError("viewport extent exceeds uint32 coordinates");
  }
  const area = rowCount * columnCount;
  if (!Number.isSafeInteger(area) || area > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_AREA) {
    throw queryError("viewport area exceeds its hard limit");
  }
}

function validateSheetName(value: string, label: string): string {
  boundedUtf8(value, SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES, label);
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 31 ||
    /[\\/?*[\]:\0]/u.test(value)
  ) {
    throw projectionError(`${label} does not match the public spreadsheet model`);
  }
  return value;
}

function nullableGenerationId(value: unknown, label: string): EditableArtifactStableId | null {
  return value === null ? null : spreadsheetSheetId(requireString(value, label));
}

function enforceProjectionEnvelopeLimit(bytes: Uint8Array, requested: number): void {
  if (bytes.byteLength > Math.min(requested, SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES)) {
    throw projectionError("spreadsheet projection exceeds its requested byte limit");
  }
}

function effectiveProjectionMaximum(value: number, minimum: number): number {
  const maximum = positiveUint32(value, "projection maximumBytes");
  const effective = Math.min(maximum, SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES);
  if (effective < minimum) throw projectionError("projection maximum cannot fit an empty response");
  return effective;
}

function requireBytes(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new TypeError(`${label} must be a uint32`);
  }
  return value as number;
}

function positiveUint32(value: unknown, label: string): number {
  const number = uint32(value, label);
  if (number === 0) throw new TypeError(`${label} must be nonzero`);
  return number;
}

function uint64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new TypeError(`${label} must be a uint64 bigint`);
  }
  return value;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
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
  if (keys.some((key) => typeof key !== "string"))
    throw new TypeError(`${label} has symbol fields`);
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedUtf8(value: string, maximum: number, label: string): Uint8Array {
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
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength > maximum) throw new RangeError(`${label} exceeds its byte limit`);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash;
}

function queryError(message: string): TypeError {
  return new TypeError(message);
}

function projectionError(message: string): TypeError {
  return new TypeError(message);
}

const MODELED_FEATURES_NONE: SpreadsheetArtifactModeledFeatures = Object.freeze({
  dimensions: false,
  hidden: false,
  merges: false,
});

const EMPTY_VALUE: SpreadsheetArtifactProjectedCellValue = Object.freeze({
  kind: "empty",
});

const FORMULA_ERRORS = [
  "null",
  "divide_by_zero",
  "value",
  "reference",
  "name",
  "number",
  "not_available",
  "spill",
  "calculation",
] as const;

const FORMULA_ERROR_TAGS = new Set<string>(FORMULA_ERRORS);

class FixedWriter {
  private readonly buffer: Uint8Array;
  private readonly viewBuffer: DataView;
  private offset = 0;

  constructor(length: number) {
    this.buffer = new Uint8Array(length);
    this.viewBuffer = new DataView(this.buffer.buffer);
  }

  view(): Uint8Array {
    return this.buffer.subarray(0, this.offset);
  }

  finish(): Uint8Array {
    if (this.offset !== this.buffer.byteLength)
      throw new TypeError("fixed binary writer is incomplete");
    return this.buffer;
  }

  u8(value: number): void {
    this.reserve(1);
    this.viewBuffer.setUint8(this.offset, value);
    this.offset += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.viewBuffer.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.viewBuffer.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  u64(value: bigint): void {
    this.reserve(8);
    this.viewBuffer.setBigUint64(this.offset, value, true);
    this.offset += 8;
  }

  stableId(value: EditableArtifactStableId): void {
    const id = spreadsheetSheetId(value);
    this.u64(BigInt(`0x${id.slice(16)}`));
    this.u64(BigInt(`0x${id.slice(0, 16)}`));
  }

  bytes(value: Uint8Array): void {
    this.reserve(value.byteLength);
    this.buffer.set(value, this.offset);
    this.offset += value.byteLength;
  }

  private reserve(length: number): void {
    if (this.offset + length > this.buffer.byteLength)
      throw new RangeError("fixed binary writer overflow");
  }
}

class DynamicWriter {
  private buffer: Uint8Array;
  private viewBuffer: DataView;
  private offset = 0;

  constructor(private readonly maximum: number) {
    this.buffer = new Uint8Array(Math.min(1_024, maximum));
    this.viewBuffer = new DataView(this.buffer.buffer);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }

  u8(value: number): void {
    this.reserve(1);
    this.viewBuffer.setUint8(this.offset, value);
    this.offset += 1;
  }

  u32(value: number): void {
    this.reserve(4);
    this.viewBuffer.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  u64(value: bigint): void {
    this.reserve(8);
    this.viewBuffer.setBigUint64(this.offset, value, true);
    this.offset += 8;
  }

  f64(value: number): void {
    this.reserve(8);
    this.viewBuffer.setFloat64(this.offset, value === 0 ? 0 : value, true);
    this.offset += 8;
  }

  stableId(value: EditableArtifactStableId): void {
    const id = spreadsheetSheetId(value);
    this.u64(BigInt(`0x${id.slice(16)}`));
    this.u64(BigInt(`0x${id.slice(0, 16)}`));
  }

  optionalStableId(value: EditableArtifactStableId | null): void {
    if (value === null) this.bytes(new Uint8Array(16));
    else this.stableId(value);
  }

  string(value: string): void {
    const bytes = boundedUtf8(
      value,
      SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES,
      "projection string",
    );
    this.u32(bytes.byteLength);
    this.bytes(bytes);
  }

  cell(cell: SpreadsheetArtifactProjectedCell): void {
    if (cell.formula === null) {
      this.u8(0);
    } else {
      this.u8(1);
      this.string(cell.formula);
    }
    const value = cell.value;
    switch (value.kind) {
      case "empty":
        this.u8(0);
        break;
      case "boolean":
        this.u8(value.value ? 2 : 1);
        break;
      case "number":
        this.u8(3);
        this.f64(value.value);
        break;
      case "date":
        this.u8(6);
        this.i64(BigInt(Date.parse(value.value)));
        break;
      case "text":
        this.u8(4);
        this.string(value.value);
        break;
      case "error":
        this.u8(5);
        this.formulaError(value.value);
        break;
    }
  }

  private formulaError(error: SpreadsheetArtifactFormulaError): void {
    if (typeof error === "string") {
      this.u8(FORMULA_ERRORS.indexOf(error as (typeof FORMULA_ERRORS)[number]));
    } else {
      this.u8(9);
      this.string(error.custom);
    }
  }

  private bytes(value: Uint8Array): void {
    this.reserve(value.byteLength);
    this.buffer.set(value, this.offset);
    this.offset += value.byteLength;
  }

  private i64(value: bigint): void {
    this.reserve(8);
    this.viewBuffer.setBigInt64(this.offset, value, true);
    this.offset += 8;
  }

  private reserve(additional: number): void {
    const required = this.offset + additional;
    if (!Number.isSafeInteger(required) || required > this.maximum) {
      throw projectionError("spreadsheet projection exceeds its byte limit");
    }
    if (required <= this.buffer.byteLength) return;
    let size = Math.max(1, this.buffer.byteLength);
    while (size < required) size = Math.min(this.maximum, size * 2);
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.offset));
    this.buffer = next;
    this.viewBuffer = new DataView(next.buffer);
  }
}

class Reader {
  private readonly viewBuffer: DataView;
  private offset = 0;

  constructor(private readonly input: Uint8Array) {
    this.viewBuffer = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  u8(): number {
    this.reserve(1);
    return this.input[this.offset++]!;
  }

  u16(): number {
    this.reserve(2);
    const value = this.viewBuffer.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.reserve(4);
    const value = this.viewBuffer.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    this.reserve(8);
    const value = this.viewBuffer.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  f64(): number {
    this.reserve(8);
    const value = this.viewBuffer.getFloat64(this.offset, true);
    this.offset += 8;
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw projectionError("spreadsheet projection number is noncanonical");
    }
    return value;
  }

  stableId(label: string): EditableArtifactStableId {
    const counter = this.u64().toString(16).padStart(16, "0");
    const namespace = this.u64().toString(16).padStart(16, "0");
    try {
      return spreadsheetSheetId(`${namespace}${counter}`);
    } catch {
      throw projectionError(`${label} is reserved or noncanonical`);
    }
  }

  optionalStableId(present: boolean): EditableArtifactStableId | null {
    if (present) return this.stableId("projection generation id");
    const bytes = this.bytes(16);
    if (bytes.some((byte) => byte !== 0)) {
      throw projectionError("projection has a generation id without its flag");
    }
    return null;
  }

  string(): string {
    const length = this.u32();
    if (length > SPREADSHEET_ARTIFACT_PROJECTION_MAX_STRING_BYTES) {
      throw projectionError("projection string exceeds its byte limit");
    }
    try {
      return textDecoder.decode(this.bytes(length));
    } catch {
      throw projectionError("projection string is not canonical UTF-8");
    }
  }

  formula(): string | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw projectionError("projection formula tag is invalid");
    const formula = this.string();
    if (formula.length === 0) throw projectionError("projection formula must not be empty");
    return formula;
  }

  cellValue(): SpreadsheetArtifactProjectedCellValue {
    switch (this.u8()) {
      case 0:
        return EMPTY_VALUE;
      case 1:
        return Object.freeze({ kind: "boolean", value: false });
      case 2:
        return Object.freeze({ kind: "boolean", value: true });
      case 3:
        return Object.freeze({ kind: "number", value: this.f64() });
      case 4:
        return Object.freeze({ kind: "text", value: this.string() });
      case 5:
        return Object.freeze({ kind: "error", value: this.formulaError() });
      case 6:
        return Object.freeze({
          kind: "date",
          value: canonicalSpreadsheetDateFromMilliseconds(this.i64()),
        });
      default:
        throw projectionError("projection cell value tag is invalid");
    }
  }

  done(message: string): void {
    if (this.offset !== this.input.byteLength) throw new TypeError(message);
  }

  private i64(): bigint {
    const bytes = this.bytes(8);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, true);
  }

  bytes(length: number): Uint8Array {
    this.reserve(length);
    const bytes = this.input.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  private formulaError(): SpreadsheetArtifactFormulaError {
    const tag = this.u8();
    if (tag <= 8) return FORMULA_ERRORS[tag]!;
    if (tag === 9) return Object.freeze({ custom: this.string() });
    throw projectionError("projection formula error tag is invalid");
  }

  private reserve(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.input.byteLength
    ) {
      throw projectionError("spreadsheet projection payload is truncated");
    }
  }
}
