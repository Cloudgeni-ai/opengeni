import {
  SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
  SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS,
  decodeSpreadsheetMetadataKernelProjection,
  decodeSpreadsheetViewportKernelProjection,
  editableArtifactStableId,
  encodeSpreadsheetMetadataKernelQuery,
  encodeSpreadsheetViewportKernelQuery,
  spreadsheetSheetId,
  type SpreadsheetArtifactCommand,
  type SpreadsheetArtifactProjectedCellValue,
  type SpreadsheetArtifactSheetMetadata,
  type SpreadsheetCellInput,
  type SpreadsheetSheetGeneration,
} from "@opengeni/contracts/editable-artifacts";
import { NativeSpreadsheetSession } from "./native";
import type {
  CompositeMutationPreparer,
  CompositeArtifactState,
  CompositePropertyRead,
  CompositeReconciliation,
  PreparedCompositeMutation,
} from "./production-composite";
import type { ArtifactKernelRuntime } from "./runtime";
import {
  Workbook as ReferenceWorkbook,
  type SerializedWorkbook,
  type Workbook,
} from "./spreadsheet";
import type { FormulaResult } from "./spreadsheet-types";

type SerializedWorksheet = SerializedWorkbook["worksheets"][number];
type SerializedCell = SerializedWorksheet["cells"][number];

type SpreadsheetNativeData = {
  readonly sheetIds: Map<string, ReturnType<typeof spreadsheetSheetId>>;
  readonly generations: Map<string, SpreadsheetSheetGeneration>;
  readonly author: SpreadsheetProjectionAuthor;
  metadata: ReadonlyMap<string, SpreadsheetArtifactSheetMetadata> | null;
};

type RangeLike = Readonly<{
  worksheet: Readonly<{ id: string }>;
  address: Readonly<{ row: number; col: number; rowCount: number; colCount: number }>;
}>;

const textEncoder = new TextEncoder();

export function reconcileSpreadsheetProjection(
  workbook: Workbook,
  runtime: ArtifactKernelRuntime,
  namespace: bigint,
): CompositeReconciliation {
  const snapshot = workbook.toJSON();
  const session = NativeSpreadsheetSession.create(runtime, namespace);
  const sheetIds = new Map<string, ReturnType<typeof spreadsheetSheetId>>();
  const generations = new Map<string, SpreadsheetSheetGeneration>();
  const author = new SpreadsheetProjectionAuthor(session, namespace);

  try {
    let previous: SpreadsheetSheetGeneration | null = null;
    let offset = 0;
    const maximumCommands = Math.max(1, Math.min(session.capabilities.maxCommands, 1_024));
    while (offset < snapshot.worksheets.length) {
      const chunk = snapshot.worksheets.slice(offset, offset + maximumCommands);
      const commands: SpreadsheetArtifactCommand[] = [];
      for (let relativeIndex = 0; relativeIndex < chunk.length; relativeIndex += 1) {
        const worksheet = chunk[relativeIndex]!;
        const sheetId = nativeSheetId(namespace, worksheet.id);
        sheetIds.set(worksheet.id, sheetId);
        const after =
          relativeIndex === 0
            ? previous
            : {
                kind: "created-in-batch" as const,
                sheetId: sheetIds.get(chunk[relativeIndex - 1]!.id)!,
                createCommandIndex: relativeIndex - 1,
              };
        commands.push({ kind: "sheet.create", sheetId, name: worksheet.name, after });
      }
      author.author(commands);
      const metadata = querySpreadsheetMetadata(session, sheetIds.size);
      const metadataById = new Map(metadata.map((sheet) => [sheet.sheetId, sheet]));
      for (let index = 0; index < chunk.length; index += 1) {
        const worksheet = chunk[index]!;
        const sheetId = sheetIds.get(worksheet.id)!;
        const operationId = metadataById.get(sheetId)?.generationId;
        if (!operationId) throw new Error("Native kernel omitted a sheet generation id");
        const generation: SpreadsheetSheetGeneration = Object.freeze({
          kind: "generation",
          sheetId,
          creationOperationId: editableArtifactStableId(operationId),
        });
        generations.set(worksheet.id, generation);
        previous = generation;
      }
      offset += chunk.length;
    }

    const batch = new SpreadsheetCommandBatcher(author, session);
    for (const worksheet of snapshot.worksheets) {
      const generation = generations.get(worksheet.id);
      if (!generation) throw new Error(`Missing native generation for worksheet ${worksheet.id}`);
      for (const command of cellCommands(worksheet, generation)) batch.add(command);
    }
    batch.finish();
    return {
      session,
      data: {
        sheetIds,
        generations,
        author,
        metadata: null,
      } satisfies SpreadsheetNativeData,
    };
  } catch (cause) {
    session.dispose();
    throw cause;
  }
}

/**
 * Converts the public hot spreadsheet mutations directly into the existing
 * OGASC/OGATX protocol. The retained native session stays authoritative; rare
 * non-cell features continue through the complete reconciliation path.
 */
export const prepareSpreadsheetMutation: CompositeMutationPreparer<Workbook> = (
  mutation,
  state,
): PreparedCompositeMutation | null => {
  const data = spreadsheetData(state);
  const root = state.rawRoot();
  if (mutation.owner === root.worksheets && mutation.member === "add") {
    const previousHostId = root.worksheets.items.at(-1)?.id;
    const after = previousHostId ? (data.generations.get(previousHostId) ?? null) : null;
    return {
      commit(result) {
        if (!isWorksheet(result)) throw new Error("Worksheet add did not return a worksheet");
        const sheetId = nativeSheetId(state.namespace, result.id);
        data.author.author([{ kind: "sheet.create", sheetId, name: result.name, after }]);
        const operationId = querySpreadsheetMetadata(
          state.native as NativeSpreadsheetSession,
          data.sheetIds.size + 1,
        ).find((sheet) => sheet.sheetId === sheetId)?.generationId;
        if (!operationId) throw new Error("Native kernel omitted a sheet generation id");
        data.sheetIds.set(result.id, sheetId);
        data.generations.set(
          result.id,
          Object.freeze({
            kind: "generation",
            sheetId,
            creationOperationId: editableArtifactStableId(operationId),
          }),
        );
        data.metadata = null;
        return true;
      },
    };
  }

  if (isWorksheet(mutation.owner) && mutation.member === "name") {
    const generation = requiredGeneration(data, mutation.owner.id);
    const name = normalizedSheetName(mutation.arguments?.[0]);
    return commitSpreadsheetCommands(data, [{ kind: "sheet.rename", sheet: generation, name }]);
  }

  if (!isRange(mutation.owner)) return null;
  const range = mutation.owner;
  const generation = requiredGeneration(data, range.worksheet.id);
  if (mutation.member === "values" || mutation.member === "formulas") {
    return commitSpreadsheetCommands(data, [
      rectangularWriteCommand(generation, range.address, mutation.arguments?.[0], mutation.member),
    ]);
  }
  if (mutation.member === "writeValues") {
    const matrix = rectangularMatrix(mutation.arguments?.[0], "spreadsheet values");
    if (matrix.rows === 0 || matrix.columns === 0) return { commit: () => false };
    return commitSpreadsheetCommands(data, [
      rectangularWriteCommand(
        generation,
        { ...range.address, rowCount: matrix.rows, colCount: matrix.columns },
        matrix.values,
        "values",
      ),
    ]);
  }
  if (mutation.member === "clear") {
    const options = mutation.arguments?.[0] as { applyTo?: unknown } | undefined;
    if (options?.applyTo === "formats") {
      // The canonical Rust spreadsheet model intentionally has no formatting
      // state. Preserve the facade revision without fabricating a kernel edit.
      return { commit: () => true };
    }
    return commitSpreadsheetCommands(data, [
      {
        kind: "range.clear",
        sheet: generation,
        range: {
          start: { row: range.address.row, column: range.address.col },
          end: {
            row: range.address.row + range.address.rowCount - 1,
            column: range.address.col + range.address.colCount - 1,
          },
        },
      },
    ]);
  }
  return null;
};

function commitSpreadsheetCommands(
  data: SpreadsheetNativeData,
  commands: readonly SpreadsheetArtifactCommand[],
): PreparedCompositeMutation {
  return {
    commit() {
      data.author.author(commands);
      data.metadata = null;
      return true;
    },
  };
}

function requiredGeneration(
  data: SpreadsheetNativeData,
  hostSheetId: string,
): SpreadsheetSheetGeneration {
  const generation = data.generations.get(hostSheetId);
  if (!generation) throw new Error(`Spreadsheet native generation is missing: ${hostSheetId}`);
  return generation;
}

function rectangularWriteCommand(
  sheet: SpreadsheetSheetGeneration,
  address: RangeLike["address"],
  input: unknown,
  kind: "values" | "formulas",
): SpreadsheetArtifactCommand {
  const matrix = rectangularMatrix(input, `spreadsheet ${kind}`);
  if (matrix.rows !== address.rowCount || matrix.columns !== address.colCount) {
    throw new Error(
      `Matrix shape ${matrix.rows}x${matrix.columns} does not match range ${address.rowCount}x${address.colCount}`,
    );
  }
  const cells: SpreadsheetCellInput[] = [];
  for (const row of matrix.values) {
    for (const value of row) {
      cells.push(kind === "values" ? nativeInputValue(value) : nativeFormula(value));
    }
  }
  return {
    kind: "cells.set",
    sheet,
    anchor: { row: address.row, column: address.col },
    rows: address.rowCount,
    columns: address.colCount,
    cells,
  };
}

function rectangularMatrix(
  input: unknown,
  label: string,
): { values: readonly (readonly unknown[])[]; rows: number; columns: number } {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be a matrix`);
  const columns = input[0]?.length ?? 0;
  if (!input.every((row) => Array.isArray(row) && row.length === columns)) {
    throw new Error(`${label} must be rectangular`);
  }
  return { values: input, rows: input.length, columns };
}

function nativeInputValue(value: unknown): SpreadsheetCellInput {
  if (value instanceof Date) {
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isSafeInteger(milliseconds)) {
      throw new TypeError("Spreadsheet cell dates must be valid ECMAScript instants");
    }
    return { date: new Date(milliseconds).toISOString() };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Spreadsheet cell numbers must be finite");
    return value;
  }
  throw new TypeError("Spreadsheet cell value is not supported by the native kernel");
}

function nativeFormula(value: unknown): SpreadsheetCellInput {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new TypeError("Spreadsheet formulas must be strings or null");
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return { formula: trimmed.startsWith("=") ? trimmed : `=${trimmed}`, cached: null };
}

function normalizedSheetName(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Worksheet name must be a string");
  const name = value.trim();
  if (!name || name.length > 31 || /[\\/?*[\]:]/u.test(name)) {
    throw new Error(`Invalid worksheet name: ${value}`);
  }
  return name;
}

export function installSpreadsheetProjection(
  workbook: Workbook,
  state: CompositeArtifactState<Workbook>,
): void {
  Object.defineProperty(workbook, "valueAt", {
    configurable: true,
    writable: true,
    value: (
      sheet: Parameters<Workbook["valueAt"]>[0],
      address: Parameters<Workbook["valueAt"]>[1],
    ): FormulaResult => {
      if (state.inMutation) {
        return ReferenceWorkbook.prototype.valueAt.call(workbook, sheet, address);
      }
      return readSpreadsheetMatrix(state, sheet.id, {
        row: address.row,
        col: address.col,
        rowCount: 1,
        colCount: 1,
      }).values[0]![0]!;
    },
  });
}

export function readSpreadsheetProperty(
  owner: unknown,
  member: PropertyKey,
  state: CompositeArtifactState<Workbook>,
): CompositePropertyRead {
  if (state.inMutation) return { handled: false };
  if (member === "values" && isRange(owner)) {
    return {
      handled: true,
      value: readSpreadsheetMatrix(state, owner.worksheet.id, owner.address).values,
    };
  }
  if (member === "formulas" && isRange(owner)) {
    return {
      handled: true,
      value: readSpreadsheetMatrix(state, owner.worksheet.id, owner.address).formulas,
    };
  }
  if (member === "name" && isWorksheet(owner)) {
    const metadata = spreadsheetMetadata(state).get(owner.id);
    if (!metadata) throw new Error(`Native worksheet is missing: ${owner.id}`);
    return { handled: true, value: metadata.name };
  }
  return { handled: false };
}

function readSpreadsheetMatrix(
  state: CompositeArtifactState<Workbook>,
  hostSheetId: string,
  address: RangeLike["address"],
): { values: FormulaResult[][]; formulas: Array<Array<string | null>> } {
  const data = spreadsheetData(state);
  const nativeSheetIdValue = data.sheetIds.get(hostSheetId);
  if (!nativeSheetIdValue) throw new Error(`Native worksheet mapping is missing: ${hostSheetId}`);
  const cells = address.rowCount * address.colCount;
  if (!Number.isSafeInteger(cells) || cells > SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS) {
    throw new RangeError(
      `Spreadsheet read exceeds the native viewport limit (${SPREADSHEET_ARTIFACT_VIEWPORT_MAX_CELLS} cells)`,
    );
  }
  const maxBytes = Math.min(
    state.native.capabilities.maxQueryResponseBytes,
    SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
  );
  const query = {
    sheetId: nativeSheetIdValue,
    startRow: address.row,
    startColumn: address.col,
    rowCount: address.rowCount,
    columnCount: address.colCount,
    maxCells: cells,
    maxBytes,
  } as const;
  const projection = decodeSpreadsheetViewportKernelProjection(
    (state.native as NativeSpreadsheetSession).query(encodeSpreadsheetViewportKernelQuery(query)),
    query,
  );
  const values: FormulaResult[][] = Array.from({ length: address.rowCount }, () =>
    Array<FormulaResult>(address.colCount).fill(null),
  );
  const formulas: Array<Array<string | null>> = Array.from({ length: address.rowCount }, () =>
    Array<string | null>(address.colCount).fill(null),
  );
  for (const cell of projection.cells) {
    const row = cell.row - address.row;
    const column = cell.column - address.col;
    values[row]![column] = projectedCellValue(cell.value);
    formulas[row]![column] = cell.formula;
  }
  return { values, formulas };
}

function spreadsheetMetadata(
  state: CompositeArtifactState<Workbook>,
): ReadonlyMap<string, SpreadsheetArtifactSheetMetadata> {
  const data = spreadsheetData(state);
  if (data.metadata) return data.metadata;
  const sheets = querySpreadsheetMetadata(
    state.native as NativeSpreadsheetSession,
    data.sheetIds.size,
  );
  const hostByNative = new Map([...data.sheetIds].map(([host, native]) => [native, host]));
  const metadata = new Map<string, SpreadsheetArtifactSheetMetadata>();
  for (const sheet of sheets) {
    const host = hostByNative.get(sheet.sheetId);
    if (host) metadata.set(host, sheet);
  }
  data.metadata = metadata;
  return metadata;
}

function querySpreadsheetMetadata(
  session: NativeSpreadsheetSession,
  maxSheets: number,
): readonly SpreadsheetArtifactSheetMetadata[] {
  const query = {
    maxSheets: Math.max(1, maxSheets),
    maxBytes: Math.min(
      session.capabilities.maxQueryResponseBytes,
      SPREADSHEET_ARTIFACT_PROJECTION_MAX_BYTES,
    ),
  } as const;
  return decodeSpreadsheetMetadataKernelProjection(
    session.query(encodeSpreadsheetMetadataKernelQuery(query)),
    query,
  ).sheets;
}

function spreadsheetData(state: CompositeArtifactState<Workbook>): SpreadsheetNativeData {
  if (state.native.modality !== "spreadsheet")
    throw new TypeError("Expected native spreadsheet session");
  const data = state.nativeData as Partial<SpreadsheetNativeData> | undefined;
  if (
    !(data?.sheetIds instanceof Map) ||
    !(data.generations instanceof Map) ||
    !(data.author instanceof SpreadsheetProjectionAuthor)
  ) {
    throw new Error("Spreadsheet native mapping is unavailable");
  }
  return data as SpreadsheetNativeData;
}

class SpreadsheetProjectionAuthor {
  readonly #session: NativeSpreadsheetSession;
  readonly #replicaId: string;
  readonly #artifactId: string;
  #transactionCounter = 0;
  #previousTransactionId: string | null = null;

  constructor(session: NativeSpreadsheetSession, namespace: bigint) {
    this.#session = session;
    this.#replicaId = u64Hex(namespace);
    this.#artifactId = `${this.#replicaId}ffffffffffffffff`;
  }

  author(commands: readonly SpreadsheetArtifactCommand[]): void {
    if (commands.length === 0) return;
    const counter = this.#transactionCounter + 1;
    const clientTransactionId = `projection.${this.#replicaId}.${counter}`;
    const revision = this.#session.revision();
    if (revision > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Native spreadsheet revision exceeds the JavaScript safe-integer range");
    }
    this.#session.authorCommands({
      intent: {
        artifactId: this.#artifactId,
        clientTransactionId,
        replicaId: this.#replicaId,
        replicaCounter: counter,
        previousLocalTransactionId: this.#previousTransactionId,
        observedHeadSequence: Number(revision),
        causalBase:
          this.#transactionCounter === 0
            ? []
            : [{ replicaId: this.#replicaId, counter: this.#transactionCounter }],
        selectiveUndoOperationIds: [],
      },
      commands: { version: 1, commands },
      resolvedBaseBytes: this.#session.frontier(),
    });
    this.#transactionCounter = counter;
    this.#previousTransactionId = clientTransactionId;
  }
}

class SpreadsheetCommandBatcher {
  readonly #author: SpreadsheetProjectionAuthor;
  readonly #maxCommands: number;
  readonly #maxCells: number;
  readonly #maxEstimatedBytes: number;
  #commands: SpreadsheetArtifactCommand[] = [];
  #cells = 0;
  #estimatedBytes = 0;

  constructor(author: SpreadsheetProjectionAuthor, session: NativeSpreadsheetSession) {
    this.#author = author;
    this.#maxCommands = Math.max(1, Math.min(session.capabilities.maxCommands, 1_000));
    this.#maxCells = Math.max(1, Math.min(session.capabilities.maxCellsPerBatch, 100_000));
    this.#maxEstimatedBytes = Math.max(
      16_384,
      Math.min(session.capabilities.maxSpreadsheetCommandBytes - 4_096, 2 * 1024 * 1024),
    );
  }

  add(command: SpreadsheetArtifactCommand): void {
    const cells = command.kind === "cells.set" ? command.cells.length : 0;
    const estimatedBytes = estimateCommandBytes(command);
    if (
      this.#commands.length > 0 &&
      (this.#commands.length + 1 > this.#maxCommands ||
        this.#cells + cells > this.#maxCells ||
        this.#estimatedBytes + estimatedBytes > this.#maxEstimatedBytes)
    ) {
      this.flush();
    }
    this.#commands.push(command);
    this.#cells += cells;
    this.#estimatedBytes += estimatedBytes;
    if (estimatedBytes > this.#maxEstimatedBytes) this.flush();
  }

  finish(): void {
    this.flush();
  }

  private flush(): void {
    if (this.#commands.length === 0) return;
    this.#author.author(this.#commands);
    this.#commands = [];
    this.#cells = 0;
    this.#estimatedBytes = 0;
  }
}

function* cellCommands(
  worksheet: SerializedWorksheet,
  generation: SpreadsheetSheetGeneration,
): Iterable<SpreadsheetArtifactCommand> {
  const cells = [...worksheet.cells].sort(
    (left, right) => left.row - right.row || left.col - right.col,
  );
  let index = 0;
  while (index < cells.length) {
    const first = cells[index]!;
    const rowCells: SpreadsheetCellInput[] = [nativeCell(first)];
    let nextColumn = first.col + 1;
    index += 1;
    while (
      index < cells.length &&
      cells[index]!.row === first.row &&
      cells[index]!.col === nextColumn &&
      rowCells.length < 4_096 &&
      estimateCellsBytes(rowCells) < 512 * 1024
    ) {
      rowCells.push(nativeCell(cells[index]!));
      nextColumn += 1;
      index += 1;
    }
    yield {
      kind: "cells.set",
      sheet: generation,
      anchor: { row: first.row, column: first.col },
      rows: 1,
      columns: rowCells.length,
      cells: rowCells,
    };
  }
}

function nativeCell(cell: SerializedCell): SpreadsheetCellInput {
  if (cell.formula !== null) return { formula: cell.formula, cached: null };
  const value = cell.value;
  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "date") {
      return { date: value.value };
    }
    throw new TypeError("Serialized spreadsheet cell value is not supported by the native kernel");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Spreadsheet cell numbers must be finite");
  }
  return value;
}

function nativeSheetId(namespace: bigint, hostId: string): ReturnType<typeof spreadsheetSheetId> {
  const match = /^ws\/(\d+)$/u.exec(hostId);
  if (!match) throw new Error(`Worksheet id cannot be mapped to the native kernel: ${hostId}`);
  // Counter 1 is the native workbook object itself. Reference worksheet ids
  // begin at ws/1, so their exact collision-free native mapping is N + 1.
  const counter = BigInt(match[1]!) + 1n;
  if (counter <= 1n || counter > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`Worksheet id counter is outside the native range: ${hostId}`);
  }
  return spreadsheetSheetId(`${u64Hex(namespace)}${u64Hex(counter)}`);
}

function projectedCellValue(value: SpreadsheetArtifactProjectedCellValue): FormulaResult {
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
      const errors: Readonly<Record<string, string>> = {
        null: "#NULL!",
        divide_by_zero: "#DIV/0!",
        value: "#VALUE!",
        reference: "#REF!",
        name: "#NAME?",
        number: "#NUM!",
        not_available: "#N/A",
        spill: "#SPILL!",
        calculation: "#CALC!",
      };
      const projected = errors[value.value];
      if (!projected) throw new Error(`Unknown native formula error: ${value.value}`);
      return projected;
    }
  }
  throw new Error("Unknown native spreadsheet cell value");
}

function estimateCommandBytes(command: SpreadsheetArtifactCommand): number {
  if (command.kind !== "cells.set") return 256;
  return 256 + estimateCellsBytes(command.cells);
}

function estimateCellsBytes(cells: readonly SpreadsheetCellInput[]): number {
  let bytes = cells.length * 16;
  for (const cell of cells) {
    if (typeof cell === "string") bytes += textEncoder.encode(cell).byteLength;
    else if (typeof cell === "object" && cell !== null) {
      if ("formula" in cell) bytes += textEncoder.encode(cell.formula).byteLength;
      else if ("error" in cell) bytes += textEncoder.encode(cell.error).byteLength;
    }
  }
  return bytes;
}

function isRange(value: unknown): value is RangeLike {
  if (typeof value !== "object" || value === null) return false;
  const worksheet = Reflect.get(value, "worksheet");
  const address = Reflect.get(value, "address");
  return (
    typeof worksheet === "object" &&
    worksheet !== null &&
    typeof Reflect.get(worksheet, "id") === "string" &&
    typeof address === "object" &&
    address !== null &&
    Number.isInteger(Reflect.get(address, "row")) &&
    Number.isInteger(Reflect.get(address, "col"))
  );
}

function isWorksheet(value: unknown): value is { id: string; name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "name") === "string" &&
    String(Reflect.get(value, "id")).startsWith("ws/") &&
    typeof Reflect.get(value, "getRangeByIndexes") === "function"
  );
}

function u64Hex(value: bigint): string {
  if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("Artifact namespace must be a nonzero u64");
  }
  return value.toString(16).padStart(16, "0");
}
