#!/usr/bin/env node

import { createHash } from "node:crypto";
import { once } from "node:events";

import {
  SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
  SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS,
  decodeSpreadsheetMetadataKernelProjection,
  decodeSpreadsheetViewportKernelProjection,
  encodeSpreadsheetMetadataKernelQuery,
  encodeSpreadsheetViewportKernelQuery,
  type SpreadsheetArtifactProjectedCellValue,
  type SpreadsheetArtifactFormulaError,
} from "@opengeni/contracts/editable-artifacts";

import { NativeSpreadsheetSession } from "./native";
import { SpreadsheetXlsxCodec } from "./spreadsheet-xlsx-codec";
import { Workbook, type SerializedWorkbook } from "./spreadsheet";
import { loadConfiguredArtifactKernelRuntime } from "./runtime-development";
import type { ArtifactKernelRuntime } from "./runtime";

const IDENTITY_ARGUMENT = "--opengeni-materializer-identity-v1";
const MATERIALIZE_ARGUMENT = "--opengeni-materialize-v1";
const VERIFY_ARGUMENT = "--opengeni-verify-materialization-v1";
const INPUT_MAGIC = bytes("OGAMI001");
const VERIFY_INPUT_MAGIC = bytes("OGAVI001");
const OUTPUT_MAGIC = bytes("OGAMO001");
const VERIFY_OUTPUT_MAGIC = bytes("OGAVO001");
const ERROR_MAGIC = bytes("OGAME001");
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_PROJECTED_RECTANGLE_CELLS = 1_000_000;
const VIEWPORT_EDGE = 128;
const XLSX_CODEC_ID = "opengeni.xlsx";
const EMPTY_FONT_REGISTRY_HASH = sha256(bytes("opengeni:no-font-registry:v1"));
const POLICY_HASH = sha256(bytes("opengeni:materializer:xlsx-native-projection:v1"));

export type EditableArtifactNativeMaterializerCapabilities = Readonly<{
  protocol: "OGAMC001";
  runtimeKind: "native";
  runtimeTarget: string;
  kernelVersion: string;
  codecVersions: Readonly<Record<typeof XLSX_CODEC_ID, string>>;
  fontRegistryHash: string;
  policyHash: string;
  maxOutputBytes: number;
  supportedModelSchemaVersions: readonly [1];
  supportedOperationProtocolVersions: readonly [1];
  supportedSnapshotProtocolVersions: readonly [1];
}>;

type MaterializationManifest = Readonly<{
  protocol: "OGAMJ001";
  artifactId: string;
  jobId: string;
  versionId: string;
  modality: "spreadsheet" | "document" | "presentation";
  inputSnapshotId: string;
  targetHeadSequence: number;
  stateHash: string;
  sourceByteSize: number;
  sourceContentHash: string;
  modelSchemaVersion: number;
  operationProtocolVersion: number;
  snapshotProtocolVersion: number;
  format: "xlsx" | "pptx" | "docx" | "pdf" | "png" | "webp";
  codecId: string;
  normalizedOptions: Readonly<Record<string, never>>;
  optionsHash: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
}>;

type SemanticCell = Readonly<{
  row: number;
  column: number;
  formula: string | null;
  value: SpreadsheetArtifactProjectedCellValue;
}>;

type SemanticWorkbook = Readonly<{
  version: 1;
  sheets: readonly Readonly<{ name: string; cells: readonly SemanticCell[] }>[];
}>;

type ProjectedWorkbook = Readonly<{
  workbook: Workbook;
  semanticHash: string;
}>;

export async function runArtifactMaterializerCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (args.length !== 1) throw new Error("unsupported materializer command");
  const command = args[0];
  if (command === IDENTITY_ARGUMENT) {
    const capabilities = await loadCapabilities(environment);
    process.stdout.write(JSON.stringify(capabilities));
    return;
  }
  if (command === MATERIALIZE_ARGUMENT) {
    try {
      await materialize(environment);
    } catch (error) {
      if (!(error instanceof MaterializerCliError)) throw error;
      await writeTypedError(error.code);
    }
    return;
  }
  if (command === VERIFY_ARGUMENT) {
    try {
      await verifyMaterialization(environment);
    } catch (error) {
      if (!(error instanceof MaterializerCliError)) throw error;
      await writeTypedError(error.code);
    }
    return;
  }
  throw new Error("unsupported materializer command");
}

async function loadCapabilities(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<EditableArtifactNativeMaterializerCapabilities> {
  const loaded = await loadRuntime(environment);
  return editableArtifactMaterializerCapabilitiesForRuntime(
    loaded.runtime,
    loaded.location.artifactTool.packageVersion,
  );
}

async function materialize(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const reader = new InputReader(process.stdin);
  assertBytes(await reader.readExactly(INPUT_MAGIC.byteLength), INPUT_MAGIC, "input protocol");
  const header = await reader.readExactly(12);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const metadataLength = headerView.getUint32(0, true);
  const sourceLength = safeU64(headerView, 4, "source length");
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES) throw invalidSource();
  if (sourceLength <= 0 || sourceLength > MAX_SOURCE_BYTES) throw unsupported();
  const manifest = decodeManifest(await reader.readExactly(metadataLength));
  if (sourceLength !== manifest.sourceByteSize) throw invalidSource();
  const source = await reader.readExactly(sourceLength);
  await reader.assertEof();
  if (sha256(source) !== manifest.sourceContentHash) throw invalidSource();

  const loaded = await loadRuntime(environment);
  const capabilities = editableArtifactMaterializerCapabilitiesForRuntime(
    loaded.runtime,
    loaded.location.artifactTool.packageVersion,
  );
  assertManifestCompatibility(manifest, capabilities);
  if (manifest.modality !== "spreadsheet" || manifest.format !== "xlsx") throw unsupported();

  const projected = projectSpreadsheet(loaded.runtime, source, manifest);
  const outputBlob = await SpreadsheetXlsxCodec.exportXlsx(projected.workbook, {
    unsupportedContent: "error",
    fileName: "workbook.xlsx",
  });
  const output = new Uint8Array(await outputBlob.arrayBuffer());
  if (output.byteLength <= 0 || output.byteLength > MAX_OUTPUT_BYTES) throw unsupported();
  // Export/import equivalence is checked here for early failure and again by a
  // distinct verifier process after immutable object publication.
  const imported = await SpreadsheetXlsxCodec.importXlsx(output, { unsupportedContent: "error" });
  if (semanticHashForWorkbook(imported) !== projected.semanticHash) throw unsupported();

  const metadata = canonicalBytes({
    byteSize: output.byteLength,
    codecId: manifest.codecId,
    codecVersion: manifest.codecVersion,
    contentHash: sha256(output),
    fontRegistryHash: manifest.fontRegistryHash,
    format: manifest.format,
    headSequence: manifest.targetHeadSequence,
    kernelVersion: manifest.kernelVersion,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    policyHash: manifest.policyHash,
    protocol: "OGAMR001",
    semanticHash: projected.semanticHash,
    stateHash: manifest.stateHash,
  });
  await writeFrame(OUTPUT_MAGIC, metadata, output);
}

async function verifyMaterialization(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const reader = new InputReader(process.stdin);
  assertBytes(
    await reader.readExactly(VERIFY_INPUT_MAGIC.byteLength),
    VERIFY_INPUT_MAGIC,
    "verification protocol",
  );
  const header = await reader.readExactly(12);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const metadataLength = view.getUint32(0, true);
  const outputLength = safeU64(view, 4, "verification output length");
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES) throw invalidSource();
  if (outputLength <= 0 || outputLength > MAX_OUTPUT_BYTES) throw unsupported();
  const metadata = decodeVerificationManifest(await reader.readExactly(metadataLength));
  const output = await reader.readExactly(outputLength);
  await reader.assertEof();
  const loaded = await loadCapabilities(environment);
  if (
    metadata.format !== "xlsx" ||
    metadata.codecId !== XLSX_CODEC_ID ||
    loaded.codecVersions[XLSX_CODEC_ID] !== metadata.codecVersion
  ) {
    throw unsupported();
  }
  let semanticHash: string;
  try {
    const imported = await SpreadsheetXlsxCodec.importXlsx(output, { unsupportedContent: "error" });
    semanticHash = semanticHashForWorkbook(imported);
  } catch {
    throw invalidOutput();
  }
  if (semanticHash !== metadata.expectedSemanticHash) throw invalidOutput();
  await writeFrame(
    VERIFY_OUTPUT_MAGIC,
    canonicalBytes({ protocol: "OGAVR001", semanticHash }),
    new Uint8Array(0),
  );
}

function projectSpreadsheet(
  runtime: ArtifactKernelRuntime,
  source: Uint8Array,
  manifest: MaterializationManifest,
): ProjectedWorkbook {
  let session: NativeSpreadsheetSession;
  try {
    session = NativeSpreadsheetSession.open(runtime, source);
  } catch {
    throw invalidSource();
  }
  try {
    if (
      session.stateHash() !== manifest.stateHash ||
      session.revision() !== BigInt(manifest.targetHeadSequence)
    ) {
      throw invalidSource();
    }
    const metadataLimit = Math.min(
      session.capabilities.maxQueryResponseBytes,
      SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
    );
    const metadata = decodeSpreadsheetMetadataKernelProjection(
      session.query(
        encodeSpreadsheetMetadataKernelQuery({
          maxSheets: Math.max(1, session.capabilities.maxMetadataSheets),
          maxBytes: metadataLimit,
        }),
      ),
      {
        maxSheets: Math.max(1, session.capabilities.maxMetadataSheets),
        maxBytes: metadataLimit,
      },
    );
    if (
      metadata.modeledFeatures.dimensions !== false ||
      metadata.modeledFeatures.hidden !== false ||
      metadata.modeledFeatures.merges !== false
    ) {
      throw unsupported();
    }
    let projectedRectangleCells = 0;
    const semanticSheets: Array<{ name: string; cells: SemanticCell[] }> = [];
    for (const sheet of metadata.sheets) {
      const cells: SemanticCell[] = [];
      if (sheet.usedBounds) {
        const rows = sheet.usedBounds.endRow - sheet.usedBounds.startRow + 1;
        const columns = sheet.usedBounds.endColumn - sheet.usedBounds.startColumn + 1;
        const area = rows * columns;
        if (!Number.isSafeInteger(area) || area <= 0) throw invalidSource();
        projectedRectangleCells += area;
        if (projectedRectangleCells > MAX_PROJECTED_RECTANGLE_CELLS) throw unsupported();
        for (
          let row = sheet.usedBounds.startRow;
          row <= sheet.usedBounds.endRow;
          row += VIEWPORT_EDGE
        ) {
          const rowCount = Math.min(VIEWPORT_EDGE, sheet.usedBounds.endRow - row + 1);
          for (
            let column = sheet.usedBounds.startColumn;
            column <= sheet.usedBounds.endColumn;
            column += VIEWPORT_EDGE
          ) {
            const columnCount = Math.min(VIEWPORT_EDGE, sheet.usedBounds.endColumn - column + 1);
            const maxCells = rowCount * columnCount;
            if (maxCells > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS) throw unsupported();
            const query = {
              sheetId: sheet.sheetId,
              startRow: row,
              startColumn: column,
              rowCount,
              columnCount,
              maxCells,
              maxBytes: metadataLimit,
            } as const;
            const viewport = decodeSpreadsheetViewportKernelProjection(
              session.query(encodeSpreadsheetViewportKernelQuery(query)),
              query,
            );
            for (const cell of viewport.cells) {
              assertRepresentableValue(cell.value);
              cells.push({
                row: cell.row,
                column: cell.column,
                formula: cell.formula,
                value: cell.value,
              });
            }
          }
        }
      }
      cells.sort((left, right) => left.row - right.row || left.column - right.column);
      semanticSheets.push({ name: sheet.name, cells });
    }
    const semantic: SemanticWorkbook = Object.freeze({ version: 1, sheets: semanticSheets });
    const workbook = Workbook.fromJSON(toSerializedWorkbook(semantic));
    const semanticHash = sha256(canonicalBytes(semantic));
    // Recalculation through the host projection must agree with every native
    // formula result before the Office codec is allowed to run.
    if (semanticHashForWorkbook(workbook) !== semanticHash) throw unsupported();
    return Object.freeze({ workbook, semanticHash });
  } finally {
    session.dispose();
  }
}

function toSerializedWorkbook(semantic: SemanticWorkbook): SerializedWorkbook {
  return {
    version: 1,
    worksheets: semantic.sheets.map((sheet, index) => ({
      id: `ws/native-${index + 1}`,
      name: sheet.name,
      showGridLines: true,
      freezePanes: { rows: 0, columns: 0 },
      cells: sheet.cells.map((cell) => ({
        row: cell.row,
        col: cell.column,
        value: cell.formula ? null : hostValue(cell.value),
        formula: cell.formula,
        format: {},
      })),
      merges: [],
      columnWidths: [],
      rowHeights: [],
      tables: [],
      charts: [],
      sparklines: [],
      dataValidations: [],
      conditionalFormattings: [],
      images: [],
    })),
    comments: [],
  } as SerializedWorkbook;
}

function semanticHashForWorkbook(workbook: Workbook): string {
  const sheets = workbook.worksheets.items.map((sheet) => {
    const cells: SemanticCell[] = [];
    for (const { row, col, data } of sheet.cellEntries()) {
      const value = data.formula ? workbook.valueAt(sheet, { row, col }) : data.value;
      cells.push({
        row,
        column: col,
        formula: data.formula,
        value: semanticValue(value, data.formula !== null),
      });
    }
    cells.sort((left, right) => left.row - right.row || left.column - right.column);
    return { name: sheet.name, cells };
  });
  return sha256(canonicalBytes({ version: 1, sheets } satisfies SemanticWorkbook));
}

function semanticValue(value: unknown, formula: boolean): SpreadsheetArtifactProjectedCellValue {
  if (value === null || value === undefined) return { kind: "empty" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
  if (value instanceof Date) {
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isSafeInteger(milliseconds)) throw unsupported();
    return { kind: "date", value: new Date(milliseconds).toISOString() };
  }
  if (typeof value === "string") {
    if (formula) {
      const error = FORMULA_ERROR_TO_NATIVE[value];
      if (error) return { kind: "error", value: error };
      if (value === "#CYCLE!") return { kind: "error", value: { custom: value } };
    }
    return { kind: "text", value };
  }
  throw unsupported();
}

function hostValue(
  value: SpreadsheetArtifactProjectedCellValue,
): string | number | boolean | Date | null {
  switch (value.kind) {
    case "empty":
      return null;
    case "boolean":
    case "number":
    case "text":
      return value.value;
    case "date":
      return new Date(value.value);
    case "error": {
      if (typeof value.value === "object") return value.value.custom;
      const projected = NATIVE_ERROR_TO_FORMULA[value.value];
      if (!projected) throw unsupported();
      return projected;
    }
  }
}

function assertRepresentableValue(value: SpreadsheetArtifactProjectedCellValue): void {
  hostValue(value);
}

const NATIVE_ERROR_TO_FORMULA: Readonly<Record<string, string>> = Object.freeze({
  divide_by_zero: "#DIV/0!",
  value: "#VALUE!",
  reference: "#REF!",
  name: "#NAME?",
  number: "#NUM!",
  not_available: "#N/A",
});
const FORMULA_ERROR_TO_NATIVE: Readonly<Record<string, SpreadsheetArtifactFormulaError>> =
  Object.freeze({
    "#DIV/0!": "divide_by_zero",
    "#VALUE!": "value",
    "#REF!": "reference",
    "#NAME?": "name",
    "#NUM!": "number",
    "#N/A": "not_available",
  });

/**
 * Exact producer profile derived from the same verified native runtime used by
 * the materializer child. The API uses this rather than accepting job identity
 * facts from clients.
 */
export function editableArtifactMaterializerCapabilitiesForRuntime(
  runtime: ArtifactKernelRuntime,
  packageVersion: string,
): EditableArtifactNativeMaterializerCapabilities {
  return Object.freeze({
    protocol: "OGAMC001",
    runtimeKind: "native",
    runtimeTarget: runtime.target,
    kernelVersion: runtime.buildIdentity,
    codecVersions: Object.freeze({ [XLSX_CODEC_ID]: codecVersion(packageVersion) }),
    fontRegistryHash: EMPTY_FONT_REGISTRY_HASH,
    policyHash: POLICY_HASH,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    supportedModelSchemaVersions: Object.freeze([1] as const),
    supportedOperationProtocolVersions: Object.freeze([1] as const),
    supportedSnapshotProtocolVersions: Object.freeze([1] as const),
  });
}

function assertManifestCompatibility(
  manifest: MaterializationManifest,
  capabilities: EditableArtifactNativeMaterializerCapabilities,
): void {
  if (
    manifest.modelSchemaVersion !== 1 ||
    manifest.operationProtocolVersion !== 1 ||
    manifest.snapshotProtocolVersion !== 1 ||
    manifest.kernelVersion !== capabilities.kernelVersion ||
    manifest.codecVersion !==
      (capabilities.codecVersions as Readonly<Record<string, string>>)[manifest.codecId] ||
    manifest.fontRegistryHash !== capabilities.fontRegistryHash ||
    manifest.policyHash !== capabilities.policyHash ||
    Object.keys(manifest.normalizedOptions).length !== 0
  ) {
    throw incompatible();
  }
}

function decodeManifest(value: Uint8Array): MaterializationManifest {
  const record = strictCanonicalRecord(value, [
    "artifactId",
    "codecId",
    "codecVersion",
    "fontRegistryHash",
    "format",
    "inputSnapshotId",
    "jobId",
    "kernelVersion",
    "modality",
    "modelSchemaVersion",
    "normalizedOptions",
    "operationProtocolVersion",
    "optionsHash",
    "policyHash",
    "protocol",
    "snapshotProtocolVersion",
    "sourceByteSize",
    "sourceContentHash",
    "stateHash",
    "targetHeadSequence",
    "versionId",
  ]);
  if (
    record.protocol !== "OGAMJ001" ||
    !positiveInteger(record.sourceByteSize) ||
    !positiveInteger(record.targetHeadSequence) ||
    !isHash(record.sourceContentHash) ||
    !isHash(record.stateHash) ||
    !isHash(record.optionsHash) ||
    !isHash(record.fontRegistryHash) ||
    !isHash(record.policyHash) ||
    !plainRecord(record.normalizedOptions)
  ) {
    throw invalidSource();
  }
  return record as MaterializationManifest;
}

function decodeVerificationManifest(value: Uint8Array): Readonly<{
  protocol: "OGAVJ001";
  format: string;
  codecId: string;
  codecVersion: string;
  expectedSemanticHash: string;
}> {
  const record = strictCanonicalRecord(value, [
    "codecId",
    "codecVersion",
    "expectedSemanticHash",
    "format",
    "protocol",
  ]);
  if (record.protocol !== "OGAVJ001" || !isHash(record.expectedSemanticHash)) {
    throw invalidSource();
  }
  return record as never;
}

function strictCanonicalRecord(
  value: Uint8Array,
  keys: readonly string[],
): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  const parsed = JSON.parse(text) as unknown;
  if (!plainRecord(parsed) || JSON.stringify(parsed) !== text) throw invalidSource();
  if (Object.keys(parsed).sort().join("\0") !== [...keys].sort().join("\0")) throw invalidSource();
  return parsed;
}

async function writeTypedError(code: string): Promise<void> {
  await writeFrame(ERROR_MAGIC, canonicalBytes({ code, protocol: "OGAMERR1" }), new Uint8Array(0));
}

async function writeFrame(
  magic: Uint8Array,
  metadata: Uint8Array,
  payload: Uint8Array,
): Promise<void> {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, metadata.byteLength, true);
  view.setBigUint64(4, BigInt(payload.byteLength), true);
  await writeStdout(magic);
  await writeStdout(header);
  await writeStdout(metadata);
  for (let offset = 0; offset < payload.byteLength; offset += 1024 * 1024) {
    await writeStdout(payload.subarray(offset, Math.min(payload.byteLength, offset + 1024 * 1024)));
  }
}

async function writeStdout(value: Uint8Array): Promise<void> {
  if (!process.stdout.write(value)) await once(process.stdout, "drain");
}

class InputReader {
  readonly #iterator: AsyncIterator<Buffer | string>;
  #buffer = new Uint8Array(0);
  #done = false;

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SOURCE_BYTES)
      throw invalidSource();
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.#buffer.byteLength === 0) await this.#fill();
      if (this.#buffer.byteLength === 0) throw invalidSource();
      const count = Math.min(length - offset, this.#buffer.byteLength);
      result.set(this.#buffer.subarray(0, count), offset);
      this.#buffer = this.#buffer.subarray(count);
      offset += count;
    }
    return result;
  }

  async assertEof(): Promise<void> {
    if (this.#buffer.byteLength > 0) throw invalidSource();
    if (!this.#done) await this.#fill();
    if (!this.#done || this.#buffer.byteLength > 0) throw invalidSource();
  }

  async #fill(): Promise<void> {
    const next = await this.#iterator.next();
    if (next.done) {
      this.#done = true;
      return;
    }
    if (typeof next.value === "string") throw invalidSource();
    this.#buffer = new Uint8Array(
      next.value.buffer,
      next.value.byteOffset,
      next.value.byteLength,
    ).slice();
  }
}

function codecVersion(packageVersion: string): string {
  return `xlsx-v1@${packageVersion}`;
}

function canonicalBytes(value: unknown): Uint8Array {
  return bytes(JSON.stringify(value));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeU64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer`);
  return Number(value);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (
    actual.byteLength !== expected.byteLength ||
    !actual.every((byte, index) => byte === expected[index])
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

class MaterializerCliError extends Error {
  readonly code:
    | "unsupported_semantics"
    | "source_identity_mismatch"
    | "kernel_incompatible"
    | "output_verification_failed";

  constructor(code: MaterializerCliError["code"]) {
    super(code);
    this.name = "MaterializerCliError";
    this.code = code;
  }
}

function unsupported(): MaterializerCliError {
  return new MaterializerCliError("unsupported_semantics");
}
function invalidSource(): MaterializerCliError {
  return new MaterializerCliError("source_identity_mismatch");
}
function incompatible(): MaterializerCliError {
  return new MaterializerCliError("kernel_incompatible");
}
function invalidOutput(): MaterializerCliError {
  return new MaterializerCliError("output_verification_failed");
}

async function loadRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Awaited<ReturnType<typeof loadConfiguredArtifactKernelRuntime>>> {
  try {
    return await loadConfiguredArtifactKernelRuntime(environment);
  } catch {
    throw incompatible();
  }
}
