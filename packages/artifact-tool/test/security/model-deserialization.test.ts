import { describe, expect, test } from "bun:test";

import { Workbook } from "../../src/spreadsheet";

describe("canonical model deserialization security", () => {
  test("SEC-010 validates spreadsheet snapshot coordinates and aggregate budgets before restore", () => {
    const malformed = {
      version: 1,
      worksheets: [
        {
          id: "ws/attacker",
          name: "Unsafe",
          showGridLines: true,
          freezePanes: { rows: 0, columns: 0 },
          cells: [
            {
              row: -1,
              col: 16_384,
              value: "outside",
              formula: null,
              format: {},
            },
          ],
          merges: [],
          columnWidths: [[-1, Number.POSITIVE_INFINITY]],
          rowHeights: [[-1, Number.POSITIVE_INFINITY]],
          tables: [],
          charts: [],
          sparklines: [],
          images: [],
        },
      ],
      comments: [],
    };

    expect(() => Workbook.fromJSON(malformed as never)).toThrow(/row|column|bounds|limit/i);
  });

  test("SEC-013 bounds live and restored spreadsheet dimensions before layout", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Bounded");

    expect(() => sheet.setColumnWidth(-1, 100)).toThrow(/column|index|bounds|limit/i);
    expect(() => sheet.setColumnWidth(16_384, 100)).toThrow(/column|index|bounds|limit/i);
    expect(() => sheet.setColumnWidth(0, 1_000_001)).toThrow(/width|dimension|bounds|limit/i);
    expect(() => sheet.setColumnWidth(0, 0.5)).toThrow(/width|dimension|bounds|at least/i);
    expect(() => sheet.setRowHeight(-1, 100)).toThrow(/row|index|bounds|limit/i);
    expect(() => sheet.setRowHeight(1_048_576, 100)).toThrow(/row|index|bounds|limit/i);
    expect(() => sheet.setRowHeight(0, 1_000_001)).toThrow(/height|dimension|bounds|limit/i);
    expect(() => sheet.setRowHeight(0, 0.5)).toThrow(/height|dimension|bounds|at least/i);

    const snapshot = workbook.toJSON();
    snapshot.worksheets[0]!.columnWidths = [[0, Number.MAX_VALUE]];
    expect(() => Workbook.fromJSON(snapshot)).toThrow(/width|dimension|bounds|limit/i);

    const tiny = workbook.toJSON();
    tiny.worksheets[0]!.rowHeights = [[0, 0.0001]];
    expect(() => Workbook.fromJSON(tiny)).toThrow(/height|dimension|bounds|at least/i);
  });
});
