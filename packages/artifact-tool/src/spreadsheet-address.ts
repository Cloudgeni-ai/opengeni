export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLUMNS = 16_384;

export type CellAddress = { row: number; col: number };
export type RangeAddress = CellAddress & { rowCount: number; colCount: number };

export function columnNameToIndex(name: string): number {
  if (!/^[A-Za-z]+$/.test(name)) throw new Error(`Invalid column name: ${name}`);
  let value = 0;
  for (const character of name.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  const index = value - 1;
  if (index < 0 || index >= EXCEL_MAX_COLUMNS) {
    throw new Error(`Column is outside the XLSX range: ${name}`);
  }
  return index;
}

export function columnIndexToName(index: number): string {
  assertIntegerInRange(index, 0, EXCEL_MAX_COLUMNS - 1, "column index");
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function parseCellAddress(input: string): CellAddress {
  const match = /^\$?([A-Za-z]+)\$?([1-9]\d*)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid A1 cell address: ${input}`);
  const row = Number(match[2]) - 1;
  if (row < 0 || row >= EXCEL_MAX_ROWS) {
    throw new Error(`Row is outside the XLSX range: ${input}`);
  }
  return { row, col: columnNameToIndex(match[1]!) };
}

export function parseRangeAddress(input: string): RangeAddress {
  const parts = input.trim().split(":");
  if (parts.length > 2 || !parts[0]) throw new Error(`Invalid A1 range: ${input}`);
  const start = parseCellAddress(parts[0]);
  const end = parseCellAddress(parts[1] ?? parts[0]);
  if (end.row < start.row || end.col < start.col) {
    throw new Error(`Range must run top-left to bottom-right: ${input}`);
  }
  return {
    row: start.row,
    col: start.col,
    rowCount: end.row - start.row + 1,
    colCount: end.col - start.col + 1,
  };
}

export function formatCellAddress(address: CellAddress): string {
  return `${columnIndexToName(address.col)}${address.row + 1}`;
}

export function formatRangeAddress(address: RangeAddress): string {
  const start = formatCellAddress(address);
  if (address.rowCount === 1 && address.colCount === 1) return start;
  return `${start}:${formatCellAddress({
    row: address.row + address.rowCount - 1,
    col: address.col + address.colCount - 1,
  })}`;
}

export function cellKey(row: number, col: number): number {
  return row * EXCEL_MAX_COLUMNS + col;
}

export function assertRange(address: RangeAddress): void {
  assertIntegerInRange(address.row, 0, EXCEL_MAX_ROWS - 1, "start row");
  assertIntegerInRange(address.col, 0, EXCEL_MAX_COLUMNS - 1, "start column");
  assertIntegerInRange(address.rowCount, 1, EXCEL_MAX_ROWS, "row count");
  assertIntegerInRange(address.colCount, 1, EXCEL_MAX_COLUMNS, "column count");
  if (address.row + address.rowCount > EXCEL_MAX_ROWS) throw new Error("Range exceeds XLSX rows");
  if (address.col + address.colCount > EXCEL_MAX_COLUMNS) {
    throw new Error("Range exceeds XLSX columns");
  }
}

function assertIntegerInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}
