// Column sizing for markdown tables on the phone, as a browser's auto table
// layout sizes them, so a table shows as many columns as it does on the web.

/** Estimated width of one character of table text, and a cell's horizontal padding. */
const TABLE_CHAR_WIDTH = 8.4;
const TABLE_CELL_PADDING = 20;
/** The widest a column grows to keep a long cell on fewer lines. */
const TABLE_COLUMN_MAX = 280;

/**
 * A column's width range, as a browser's auto table layout measures it: on one
 * line (`max`), and wrapped down to its longest word (`min`).
 */
export type TableColumn = { min: number; max: number };

export function tableColumns(rows: string[][]): TableColumn[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const width = (characters: number) =>
    Math.ceil(Math.max(1, characters) * TABLE_CHAR_WIDTH) + TABLE_CELL_PADDING;
  return Array.from({ length: count }, (_, index) => {
    const cells = rows.map((row) => row[index] ?? "");
    const longestCell = Math.max(0, ...cells.map((cell) => cell.length));
    const longestWord = Math.max(
      0,
      ...cells.flatMap((cell) => cell.split(/\s+/).map((word) => word.length)),
    );
    const max = Math.min(TABLE_COLUMN_MAX, width(longestCell));
    return { min: Math.min(max, Math.max(48, width(longestWord))), max };
  });
}

/**
 * Column widths for the available width, as a browser lays out an auto table:
 * every column on one line when that fits (spare room goes to the longer
 * columns), otherwise cells wrap toward their longest word, and only a table
 * that still can't fit scrolls sideways at those narrowest widths.
 */
export function tableLayout(
  columns: readonly TableColumn[],
  available: number,
): { widths: number[]; scrolls: boolean } {
  const sumMin = columns.reduce((sum, column) => sum + column.min, 0);
  const sumMax = columns.reduce((sum, column) => sum + column.max, 0);
  if (sumMax <= available) {
    const spare = available - sumMax;
    return {
      widths: columns.map(
        (column) => column.max + (sumMax > 0 ? (spare * column.max) / sumMax : 0),
      ),
      scrolls: false,
    };
  }
  if (sumMin <= available) {
    const share = (available - sumMin) / (sumMax - sumMin);
    return {
      widths: columns.map((column) => column.min + (column.max - column.min) * share),
      scrolls: false,
    };
  }
  return { widths: columns.map((column) => column.min), scrolls: true };
}
