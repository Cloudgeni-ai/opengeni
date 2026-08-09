import { describe, expect, test } from "bun:test";
import {
  EXCEL_MAX_COLUMNS,
  EXCEL_MAX_ROWS,
  columnIndexToName,
  columnNameToIndex,
  formatCellAddress,
  formatRangeAddress,
  parseCellAddress,
  parseRangeAddress,
} from "../src/spreadsheet-address";

describe("A1 addressing", () => {
  test("round-trips every XLSX column", () => {
    for (let col = 0; col < EXCEL_MAX_COLUMNS; col += 1) {
      expect(columnNameToIndex(columnIndexToName(col))).toBe(col);
    }
  });

  test("round-trips deterministic cell and range samples", () => {
    let state = 0x5eed1234;
    for (let index = 0; index < 10_000; index += 1) {
      state = xorshift(state);
      const row = state % EXCEL_MAX_ROWS;
      state = xorshift(state);
      const col = state % EXCEL_MAX_COLUMNS;
      const cell = { row, col };
      expect(parseCellAddress(formatCellAddress(cell))).toEqual(cell);
    }
    expect(formatRangeAddress(parseRangeAddress("$B$2:$XFD$1048576"))).toBe("B2:XFD1048576");
  });

  test("rejects reversed and out-of-bounds ranges", () => {
    expect(() => parseRangeAddress("B2:A1")).toThrow("top-left");
    expect(() => parseCellAddress("XFE1")).toThrow("outside");
    expect(() => parseCellAddress("A1048577")).toThrow("outside");
  });
});

function xorshift(value: number): number {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}
