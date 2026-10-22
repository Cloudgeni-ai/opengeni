// What the person has selected in the workbook, read whenever the selection or
// the active sheet changes, and sent with their next message as context (a pill
// above the composer they can leave out). A bounded sample of the selection
// goes with it, so "explain this" or "fix these numbers" needs no extra read.

/**
 * One piece of per-message context for the model, in the shape the session UI's
 * `messageContext` takes: `text` goes to the model, `label` is the pill.
 */
export type OfficeContextItem = {
  id: string;
  text: string;
  label?: string;
  detail?: string;
};

export type SelectionSnapshot = {
  sheet: string;
  /** The selected range without its sheet, such as "B2:D14"; null when no range is selected (a chart or shape). */
  address: string | null;
  rows: number;
  columns: number;
  /** The part of the selection with content, such as "C5:F40"; null when it is all empty. */
  filled: string | null;
  filledRows: number;
  filledColumns: number;
  /** Displayed text of the filled part's top-left corner, at most SAMPLE_ROWS × SAMPLE_COLUMNS. */
  text: string[][];
  /** Formulas over the same cells ("" or a plain value where there is none). */
  formulas: unknown[][];
};

export const SAMPLE_ROWS = 20;
export const SAMPLE_COLUMNS = 8;
const CELL_CHARS = 40;
const SAMPLE_CHARS = 1_500;
const FORMULA_LIMIT = 10;

/** "Sheet1!B2:D14" or "'My sheet'!B2" to its range part. */
export function rangePart(address: string): string {
  const bang = address.lastIndexOf("!");
  return bang >= 0 ? address.slice(bang + 1) : address;
}

/** A1-style column letters for a 0-based column index. */
function columnLetters(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function topLeft(address: string): { column: number; row: number } {
  const match = /^\$?([A-Z]+)\$?(\d+)/u.exec(rangePart(address));
  if (!match) return { column: 0, row: 1 };
  const column = [...match[1]!].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
  return { column: column - 1, row: Number(match[2]) };
}

function cell(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > CELL_CHARS ? `${flat.slice(0, CELL_CHARS - 1)}…` : flat;
}

export function selectionContextItem(
  selection: SelectionSnapshot,
  workbookName: string,
): OfficeContextItem {
  const where = selection.address
    ? `${selection.sheet}!${selection.address}`
    : `the sheet "${selection.sheet}"`;
  const lines = [
    selection.address
      ? `Selected in the workbook when the person sent this: ${where} (${selection.rows} ${selection.rows === 1 ? "row" : "rows"} × ${selection.columns} ${selection.columns === 1 ? "column" : "columns"}), on the active sheet "${selection.sheet}".`
      : `The person was on the sheet "${selection.sheet}" with no cell range selected when they sent this.`,
  ];
  if (selection.address && selection.filled) {
    if (selection.filled !== selection.address) {
      lines.push(`The cells with content in it are ${selection.sheet}!${selection.filled}.`);
    }
    const shown =
      selection.filledRows > selection.text.length ||
      selection.filledColumns > (selection.text[0]?.length ?? 0);
    let sample = selection.text.map((row) => row.map(cell).join("\t")).join("\n");
    if (sample.length > SAMPLE_CHARS) sample = `${sample.slice(0, SAMPLE_CHARS)}…`;
    lines.push(
      shown
        ? `Its first ${selection.text.length} rows × ${selection.text[0]?.length ?? 0} columns as displayed (tab-separated):`
        : "Its cells as displayed (tab-separated):",
      sample,
    );
    const origin = topLeft(selection.filled);
    const formulas: string[] = [];
    selection.formulas.forEach((row, r) =>
      row.forEach((formula, c) => {
        if (typeof formula === "string" && formula.startsWith("=")) {
          formulas.push(`${columnLetters(origin.column + c)}${origin.row + r}: ${formula}`);
        }
      }),
    );
    if (formulas.length > 0) {
      lines.push(
        `Formulas${formulas.length > FORMULA_LIMIT ? ` (first ${FORMULA_LIMIT} of ${formulas.length})` : ""}:`,
        ...formulas.slice(0, FORMULA_LIMIT),
      );
    }
  } else if (selection.address) {
    lines.push("The selected cells are empty.");
  }
  return {
    id: "excel-selection",
    label: selection.address ? `${selection.sheet} · ${selection.address}` : selection.sheet,
    detail: `${where} in ${workbookName}`,
    text: lines.join("\n"),
  };
}

// The few Office.js calls this reads with, so tests can stand in for Excel.
type Loadable = { load(properties: string): void };
type RangeProxy = Loadable & {
  address: string;
  rowCount: number;
  columnCount: number;
  isNullObject?: boolean;
  text: string[][];
  formulas: unknown[][];
  getIntersectionOrNullObject(other: RangeProxy): RangeProxy;
  getCell(row: number, column: number): RangeProxy;
  getResizedRange(rows: number, columns: number): RangeProxy;
};
export type SelectionRequestContext = {
  workbook: {
    getSelectedRange(): RangeProxy;
    worksheets: {
      getActiveWorksheet(): Loadable & {
        name: string;
        getUsedRangeOrNullObject(valuesOnly?: boolean): RangeProxy;
      };
    };
  };
  sync(): Promise<void>;
};

export async function readSelection(context: SelectionRequestContext): Promise<SelectionSnapshot> {
  const sheet = context.workbook.worksheets.getActiveWorksheet();
  sheet.load("name");
  await context.sync();
  const none: SelectionSnapshot = {
    sheet: sheet.name,
    address: null,
    rows: 0,
    columns: 0,
    filled: null,
    filledRows: 0,
    filledColumns: 0,
    text: [],
    formulas: [],
  };
  let selected: RangeProxy;
  try {
    selected = context.workbook.getSelectedRange();
    selected.load("address,rowCount,columnCount");
    await context.sync();
  } catch {
    // A chart, a shape or several areas: only the sheet is known.
    return none;
  }
  const snapshot: SelectionSnapshot = {
    ...none,
    address: rangePart(selected.address),
    rows: selected.rowCount,
    columns: selected.columnCount,
  };
  // Sample only cells with content: a whole-column selection reads its used part.
  const used = sheet.getUsedRangeOrNullObject(true);
  const filled = selected.getIntersectionOrNullObject(used);
  filled.load("address,rowCount,columnCount");
  await context.sync();
  if (filled.isNullObject) return snapshot;
  const sample = filled
    .getCell(0, 0)
    .getResizedRange(
      Math.min(filled.rowCount, SAMPLE_ROWS) - 1,
      Math.min(filled.columnCount, SAMPLE_COLUMNS) - 1,
    );
  sample.load("text,formulas");
  await context.sync();
  return {
    ...snapshot,
    filled: rangePart(filled.address),
    filledRows: filled.rowCount,
    filledColumns: filled.columnCount,
    text: sample.text,
    formulas: sample.formulas,
  };
}
