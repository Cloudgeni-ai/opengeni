// Column sizing for markdown tables on the phone. Columns are sized from their
// content as a browser's auto table layout sizes them, but a column never
// wraps narrower than a comfortable reading measure: on a phone, a sentence
// squeezed to two or three words a line reads worse than a table that scrolls.

/** Estimated width of one character of table text, and a cell's horizontal padding. */
const TABLE_CHAR_WIDTH = 8.4;
const TABLE_CELL_PADDING = 20;
/** The widest a column grows to keep a long cell on fewer lines. */
const TABLE_COLUMN_MAX = 280;
/** The narrowest any column gets, however short its words. */
const TABLE_COLUMN_MIN = 48;
/**
 * A column holding sentences keeps about 25 characters a line, so its prose
 * still reads as lines, not a word list. Short cells (names, prices, labels)
 * still wrap down to their longest word, as a browser wraps them.
 */
const TABLE_PROSE_CELL_CHARACTERS = 40;
const TABLE_PROSE_COLUMN_MIN = 220;

/**
 * A column's width range: on one line (`max`), and the narrowest it wraps to
 * (`min`): its longest word, or a readable measure for a column of sentences.
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
    const readable =
      longestCell > TABLE_PROSE_CELL_CHARACTERS ? TABLE_PROSE_COLUMN_MIN : TABLE_COLUMN_MIN;
    return { min: Math.min(max, Math.max(readable, width(longestWord))), max };
  });
}

/**
 * Column widths for the available width, as a browser lays out an auto table:
 * every column on one line when that fits (spare room goes to the longer
 * columns), otherwise cells wrap toward their minimum, and a table
 * that still can't fit scrolls sideways at those widths.
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
