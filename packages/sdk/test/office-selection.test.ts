import { describe, expect, test } from "bun:test";

import {
  rangePart,
  readSelection,
  selectionContextItem,
  type SelectionRequestContext,
  type SelectionSnapshot,
} from "../src/office/selection";

const base: SelectionSnapshot = {
  sheet: "Budget",
  address: "B2:C4",
  rows: 3,
  columns: 2,
  filled: "B2:C4",
  filledRows: 3,
  filledColumns: 2,
  text: [
    ["Item", "Cost"],
    ["Rent", "1,200"],
    ["Total", "1,200"],
  ],
  formulas: [
    ["Item", "Cost"],
    ["Rent", 1200],
    ["Total", "=SUM(C3:C3)"],
  ],
};

describe("selectionContextItem", () => {
  test("describes the range, its cells and formulas", () => {
    const item = selectionContextItem(base, "Q3.xlsx");
    expect(item.label).toBe("Budget · B2:C4");
    expect(item.detail).toBe("Budget!B2:C4 in Q3.xlsx");
    expect(item.text).toBe(
      [
        'Selected in the workbook when the person sent this: Budget!B2:C4 (3 rows × 2 columns), on the active sheet "Budget".',
        "Its cells as displayed (tab-separated):",
        "Item\tCost\nRent\t1,200\nTotal\t1,200",
        "Formulas:",
        "C4: =SUM(C3:C3)",
      ].join("\n"),
    );
  });

  test("names the filled part of a large selection and says the sample is partial", () => {
    const item = selectionContextItem(
      { ...base, address: "A:D", rows: 1_048_576, columns: 4, filled: "B2:C40", filledRows: 39 },
      "Q3.xlsx",
    );
    expect(item.text).toContain("The cells with content in it are Budget!B2:C40.");
    expect(item.text).toContain("Its first 3 rows × 2 columns as displayed");
  });

  test("says when the selection is empty or not a range", () => {
    expect(
      selectionContextItem(
        { ...base, address: "F9", rows: 1, columns: 1, filled: null, text: [], formulas: [] },
        "Q3.xlsx",
      ).text,
    ).toContain("F9 (1 row × 1 column)");
    const chart = selectionContextItem(
      { ...base, address: null, filled: null, text: [], formulas: [] },
      "Q3.xlsx",
    );
    expect(chart.label).toBe("Budget");
    expect(chart.text).toBe(
      'The person was on the sheet "Budget" with no cell range selected when they sent this.',
    );
  });

  test("flattens and shortens long cells", () => {
    const long = "x".repeat(60);
    const item = selectionContextItem(
      { ...base, text: [[`a\nb`, long]], formulas: [["", ""]] },
      "Q3.xlsx",
    );
    expect(item.text).toContain(`a b\t${"x".repeat(39)}…`);
  });
});

test("rangePart drops the sheet", () => {
  expect(rangePart("Sheet1!B2:D14")).toBe("B2:D14");
  expect(rangePart("'My sheet'!A1")).toBe("A1");
  expect(rangePart("A1")).toBe("A1");
});

describe("readSelection", () => {
  function fakeExcel(options: { selected?: "throws"; empty?: boolean }) {
    const range = (address: string, rows: number, columns: number) => {
      const proxy = {
        address,
        rowCount: rows,
        columnCount: columns,
        isNullObject: false,
        text: [["a"]],
        formulas: [["=1"]],
        resized: [0, 0] as [number, number],
        load: () => undefined,
        getIntersectionOrNullObject: () => ({
          ...range("Sheet1!B2:C3", 2, 2),
          isNullObject: options.empty === true,
        }),
        getCell: () => proxy,
        getResizedRange: (r: number, c: number) => {
          proxy.resized = [r, c];
          return proxy;
        },
      };
      return proxy;
    };
    const selected = range("Sheet1!A1:Z100", 100, 26);
    const context = {
      workbook: {
        getSelectedRange: () => {
          if (options.selected === "throws") throw new Error("InvalidSelection");
          return selected;
        },
        worksheets: {
          getActiveWorksheet: () => ({
            name: "Sheet1",
            load: () => undefined,
            getUsedRangeOrNullObject: () => range("Sheet1!B2:C3", 2, 2),
          }),
        },
      },
      sync: async () => undefined,
    };
    return context as unknown as SelectionRequestContext;
  }

  test("reads the range and samples its filled part", async () => {
    expect(await readSelection(fakeExcel({}))).toMatchObject({
      sheet: "Sheet1",
      address: "A1:Z100",
      rows: 100,
      columns: 26,
      filled: "B2:C3",
      text: [["a"]],
      formulas: [["=1"]],
    });
  });

  test("knows only the sheet when no range is selected, and nothing filled when empty", async () => {
    expect(await readSelection(fakeExcel({ selected: "throws" }))).toMatchObject({
      sheet: "Sheet1",
      address: null,
    });
    expect(await readSelection(fakeExcel({ empty: true }))).toMatchObject({
      address: "A1:Z100",
      filled: null,
      text: [],
    });
  });
});
