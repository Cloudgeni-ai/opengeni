import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/spreadsheet-artifact-dimensions.json";
import {
  encodeSpreadsheetArtifactCommandBatch,
  decodeSpreadsheetArtifactCommandBatch,
  encodeSpreadsheetMetadataKernelProjection,
  decodeSpreadsheetMetadataKernelProjection,
  encodeSpreadsheetViewportKernelProjection,
  decodeSpreadsheetViewportKernelProjection,
  spreadsheetSheetId,
  editableArtifactStableId,
} from "../src/editable-artifacts";

const sheetId = spreadsheetSheetId("00000000000000010000000000000002");
const generationId = editableArtifactStableId("00000000000000030000000000000004");
const sheet = { kind: "generation" as const, sheetId, creationOperationId: generationId };
const dimensions = {
  defaultRowHeight: 24,
  defaultColumnWidth: 96,
  rowHeights: [[3, 48]] as const,
  columnWidths: [[5, 180]] as const,
};

describe("durable spreadsheet dimension contracts", () => {
  test("bounds integer pixels, normalizes explicit defaults, and supports reset", () => {
    const commands = [
      { kind: "row.height.set" as const, sheet, row: 3, height: 48 },
      { kind: "column.width.set" as const, sheet, column: 5, width: 180 },
      { kind: "row.height.set" as const, sheet, row: 0xffff_ffff, height: 24 },
      { kind: "column.width.set" as const, sheet, column: 0, width: null },
    ] as const;
    const bytes = encodeSpreadsheetArtifactCommandBatch({ version: 2, commands });
    expect(Buffer.from(bytes).toString("hex")).toBe(fixture.commandHex);
    const decoded = decodeSpreadsheetArtifactCommandBatch(bytes);
    expect(decoded.commands).toEqual([
      commands[0],
      commands[1],
      { ...commands[2], height: null },
      commands[3],
    ]);
    expect(encodeSpreadsheetArtifactCommandBatch(decoded)).toEqual(bytes);
    for (const height of [0, -1, 1.5, 4097, NaN, Infinity, undefined]) {
      expect(() =>
        encodeSpreadsheetArtifactCommandBatch({
          version: 2,
          commands: [{ ...commands[0]!, height } as never],
        }),
      ).toThrow();
    }
    for (const row of [-1, 1.5, 0x1_0000_0000]) {
      expect(() =>
        encodeSpreadsheetArtifactCommandBatch({ version: 2, commands: [{ ...commands[0]!, row }] }),
      ).toThrow();
    }
  });

  test("metadata and viewport expose exact sparse dimensions", () => {
    const metadata = {
      revision: 4n,
      modeledFeatures: { dimensions: true, hidden: false as const, merges: false as const },
      sheets: [{ sheetId, generationId, name: "Data", usedBounds: null, ...dimensions }],
    };
    expect(
      decodeSpreadsheetMetadataKernelProjection(
        encodeSpreadsheetMetadataKernelProjection(metadata),
      ),
    ).toEqual(metadata);
    const viewport = {
      revision: 4n,
      sheetId,
      generationId,
      startRow: 3,
      startColumn: 5,
      rowCount: 1,
      columnCount: 1,
      cells: [],
      ...dimensions,
    };
    const bytes = encodeSpreadsheetViewportKernelProjection(viewport);
    expect(Buffer.from(bytes).toString("hex")).toBe(fixture.viewportHex);
    expect(decodeSpreadsheetViewportKernelProjection(bytes)).toEqual(viewport);
    expect(() => encodeSpreadsheetViewportKernelProjection(viewport, bytes.length - 1)).toThrow();
    for (const rowHeights of [
      [[3, 24]],
      [[3, 0]],
      [[3, 4097]],
      [
        [3, 48],
        [3, 50],
      ],
      [[4, 48]],
      [[3, 1.5]],
      new Array(1),
      [new Array(2)],
    ]) {
      expect(() =>
        encodeSpreadsheetViewportKernelProjection({ ...viewport, rowHeights: rowHeights as never }),
      ).toThrow();
    }
    expect(() =>
      encodeSpreadsheetMetadataKernelProjection({
        ...metadata,
        sheets: [{ ...metadata.sheets[0]!, defaultRowHeight: 25 }],
      }),
    ).toThrow();
  });
});
