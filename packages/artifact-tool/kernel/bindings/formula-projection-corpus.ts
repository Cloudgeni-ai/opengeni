import {
  EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
  decodeSpreadsheetViewportKernelProjection,
  encodeEditableArtifactCausalFrontier,
  encodeEditableArtifactMutationIntent,
  encodeSpreadsheetArtifactCommandBatch,
  encodeSpreadsheetArtifactKernelQuery,
  spreadsheetSheetId,
} from "@opengeni/contracts/editable-artifacts";

import { encodeArtifactReplicaNamespace } from "../../src/runtime";

const NAMESPACE = 0x0a11_ce55_1a7e_0001n;
const REPLICA_ID = "0a11ce551a7e0001";
const ARTIFACT_ID = "11111111111111112222222222222222";
const INPUT_SHEET_ID = spreadsheetSheetId("0a11ce551a7e00010000000000000032");
const OUTPUT_SHEET_ID = spreadsheetSheetId("0a11ce551a7e00010000000000000033");
const DEPENDENCY_CHAIN_LENGTH = 128;
const MATH_FORMULAS = [
  "=1/(1+$B$11)^4",
  "=POWER(1.1,-4)",
  "=POWER(2,-1024)",
  "=POWER(2,-3)",
  "=POWER(2,-0)",
  "=POWER(2,0)",
  "=POWER(2,1)",
  "=POWER(2,2)",
  "=POWER(2,3)",
  "=POWER(2,4)",
  "=POWER(1,9007199254740991)",
  "=POWER(2,0.5)",
  "=POWER(4,-0.5)",
  "=POWER(-2,3)",
  "=POWER(-2,0.5)",
  "=POWER(-0,3)",
  "=POWER(0,3)",
  "=POWER(0,-1)",
  "=POWER(5E-324,1)",
  "=POWER(1E308,2)",
  "=ROUND(2.55,1)",
  "=ROUNDUP(-1.21,1)",
  "=ROUNDDOWN(-1.29,1)",
  "=ROUND(1.2345,309)",
  "=ROUND(1.2345,-324)",
  "=SQRT(9)",
  "=SQRT(-1)",
  "=SQRT(5E-324)",
  "=-0",
  "=POWER(-0,-3)",
  "=1/0",
] as const;

type FormulaCorpusSession = {
  authorTransaction(intentBytes: Uint8Array, resolvedBaseBytes: Uint8Array): Uint8Array;
  query(queryBytes: Uint8Array): Uint8Array;
  dispose?: () => void;
  free?: () => void;
};

export type FormulaCorpusBinding = Readonly<{
  ArtifactCollaborationSession: Readonly<{
    create(namespaceBytes: Uint8Array): FormulaCorpusSession;
  }>;
}>;

export type FormulaCorpusInput = Readonly<{
  namespace: bigint;
  intentBytes: Uint8Array;
  resolvedBaseBytes: Uint8Array;
  queryBytes: Uint8Array;
}>;

/** Executes the release-gating formula corpus through one packaged binding. */
export function spreadsheetFormulaProjectionCorpusBytes(
  binding: FormulaCorpusBinding,
  captureInput?: (input: FormulaCorpusInput) => void,
): Uint8Array {
  const session = binding.ArtifactCollaborationSession.create(
    encodeArtifactReplicaNamespace(NAMESPACE),
  );
  try {
    const inputSheet = {
      kind: "created-in-batch" as const,
      sheetId: INPUT_SHEET_ID,
      createCommandIndex: 0,
    };
    const outputSheet = {
      kind: "created-in-batch" as const,
      sheetId: OUTPUT_SHEET_ID,
      createCommandIndex: 1,
    };
    const commandBytes = encodeSpreadsheetArtifactCommandBatch({
      version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
      commands: [
        { kind: "sheet.create", sheetId: INPUT_SHEET_ID, name: "Inputs Q1", after: null },
        { kind: "sheet.create", sheetId: OUTPUT_SHEET_ID, name: "Calculated", after: inputSheet },
        {
          kind: "cells.set",
          sheet: inputSheet,
          anchor: { row: 0, column: 0 },
          rows: 3,
          columns: 1,
          cells: [1, 2, 3],
        },
        {
          kind: "cells.set",
          sheet: outputSheet,
          anchor: { row: 8, column: 0 },
          rows: MATH_FORMULAS.length,
          columns: 1,
          cells: MATH_FORMULAS.map((formula) => ({ formula })),
        },
        {
          kind: "cells.set",
          sheet: outputSheet,
          anchor: { row: 0, column: 0 },
          rows: 6,
          columns: 1,
          cells: ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA"].map((functionName) => ({
            formula: `=${functionName}('Inputs Q1'!A1:A3)`,
          })),
        },
        {
          kind: "cells.set",
          sheet: outputSheet,
          anchor: { row: 0, column: 1 },
          rows: 3,
          columns: 1,
          cells: [{ formula: "=B2+1" }, { formula: "=B1+1" }, { formula: "=B1+1" }],
        },
        {
          kind: "cells.set",
          sheet: outputSheet,
          anchor: { row: 10, column: 1 },
          rows: 1,
          columns: 1,
          cells: [0.1],
        },
        {
          kind: "cells.set",
          sheet: outputSheet,
          anchor: { row: 6, column: 0 },
          rows: 2,
          columns: 1,
          cells: [{ formula: "=1/0" }, { formula: "=A7+1" }],
        },
        {
          kind: "cells.set",
          sheet: outputSheet,
          anchor: { row: 0, column: 2 },
          rows: DEPENDENCY_CHAIN_LENGTH,
          columns: 1,
          cells: Array.from({ length: DEPENDENCY_CHAIN_LENGTH }, (_, row) => ({
            formula: row === 0 ? "=1" : `=C${row}+1`,
          })),
        },
      ],
    });
    const intentBytes = encodeEditableArtifactMutationIntent({
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion: EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION,
      modelSchemaVersion: SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION,
      commandProtocolVersion: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
      artifactId: ARTIFACT_ID,
      clientTransactionId: "formula.projection.corpus.current",
      replicaId: REPLICA_ID,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: 0,
      causalBase: [],
      selectiveUndoOperationIds: [],
      commandBytes,
    });
    const resolvedBaseBytes = encodeEditableArtifactCausalFrontier([]);
    session.authorTransaction(intentBytes, resolvedBaseBytes);
    const viewportQuery = {
      sheetId: OUTPUT_SHEET_ID,
      startRow: 0,
      startColumn: 0,
      rowCount: DEPENDENCY_CHAIN_LENGTH,
      columnCount: 3,
      maxCells: 192,
      maxBytes: 256 * 1024,
    } as const;
    const queryBytes = encodeSpreadsheetArtifactKernelQuery({
      kind: "viewport",
      query: viewportQuery,
    });
    captureInput?.(
      Object.freeze({
        namespace: NAMESPACE,
        intentBytes: intentBytes.slice(),
        resolvedBaseBytes: resolvedBaseBytes.slice(),
        queryBytes: queryBytes.slice(),
      }),
    );
    const projectionBytes = session.query(queryBytes).slice();
    assertFormulaCorpusProjection(
      decodeSpreadsheetViewportKernelProjection(projectionBytes, viewportQuery),
    );
    return projectionBytes;
  } finally {
    session.dispose?.();
    session.free?.();
  }
}

function assertFormulaCorpusProjection(
  projection: ReturnType<typeof decodeSpreadsheetViewportKernelProjection>,
): void {
  assertNumberBits(projection, 8, 0, 0x3fe5_db3f_08b0_ab7dn, "incident result");
  assertNumberBits(projection, 9, 0, 0x3fe5_db3f_08b0_ab7dn, "negative power");
  assertNumberBits(projection, 10, 0, 0x0004_0000_0000_0000n, "subnormal underflow");
  assertNumberBits(projection, 26, 0, 0x0000_0000_0000_0001n, "subnormal base");
  assertNumberBits(projection, 36, 0, 0x0000_0000_0000_0000n, "canonical zero");
  assertProjectedValue(projection, 22, 0, "error", "number", "negative fractional base");
  assertProjectedValue(projection, 27, 0, "error", "number", "overflow");
  assertProjectedValue(projection, 38, 0, "error", "divide_by_zero", "division by zero");
  assertProjectedValue(projection, DEPENDENCY_CHAIN_LENGTH - 1, 2, "number", 128, "chain");
}

function assertNumberBits(
  projection: ReturnType<typeof decodeSpreadsheetViewportKernelProjection>,
  row: number,
  column: number,
  expected: bigint,
  label: string,
): void {
  const value = projectedValue(projection, row, column);
  if (value.kind !== "number" || float64Bits(value.value) !== expected) {
    throw new Error(`Formula projection corpus ${label} did not match its bit golden`);
  }
}

function assertProjectedValue(
  projection: ReturnType<typeof decodeSpreadsheetViewportKernelProjection>,
  row: number,
  column: number,
  kind: "error" | "number",
  expected: string | number,
  label: string,
): void {
  const value = projectedValue(projection, row, column);
  const matches =
    kind === "number"
      ? value.kind === "number" && value.value === expected
      : value.kind === "error" && value.value === expected;
  if (!matches) {
    throw new Error(`Formula projection corpus ${label} did not match its semantic golden`);
  }
}

function projectedValue(
  projection: ReturnType<typeof decodeSpreadsheetViewportKernelProjection>,
  row: number,
  column: number,
) {
  const cell = projection.cells.find(
    (candidate) => candidate.row === row && candidate.column === column,
  );
  if (cell === undefined) throw new Error("Formula projection corpus is missing a required cell");
  return cell.value;
}

function float64Bits(value: number): bigint {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}
