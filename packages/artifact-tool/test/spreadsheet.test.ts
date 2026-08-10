import { describe, expect, test } from "bun:test";

import {
  formulaFromR1C1,
  formulaToR1C1,
  referencesInFormula,
  translateFormula,
} from "../src/spreadsheet-formula";
import { Workbook } from "../src/spreadsheet";

describe("spreadsheet formulas", () => {
  test("evaluates references, errors, lazy branches, and Excel operator semantics", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Calc");
    const inputs = workbook.worksheets.add("Inputs Q1");
    const jan = workbook.worksheets.add("Jan1");

    sheet.getRange("A1:A2").values = [[1], [2]];
    inputs.getRange("A1:B2").values = [
      [10, 2],
      [8, 4],
    ];
    jan.getRange("A1").values = [[5]];
    sheet.getRange("B1:B11").formulas = [
      ["='Inputs Q1'!A1/'Inputs Q1'!B1"],
      ["=SUM(A2:A1)"],
      ["=IFERROR(1/0,99)"],
      ["=IF(FALSE,1/0,42)"],
      ["=SUM(1,1/0)"],
      ["=2^3^2"],
      ["=-1^2"],
      ["=ROUNDUP(-1.21,1)"],
      ["=ROUNDDOWN(-1.29,1)"],
      ["=SQRT(-1)"],
      ["=Jan1!A1"],
    ];

    expect(sheet.getRange("B1:B11").values).toEqual([
      [5],
      [3],
      [99],
      [42],
      ["#DIV/0!"],
      [512],
      [1],
      [-1.3],
      [-1.2],
      ["#NUM!"],
      [5],
    ]);

    sheet.getRange("C1:C4").formulas = [
      ['="A1"&A1'],
      ["=IFERROR(Missing!A1,7)"],
      ["=AND(FALSE,1/0)"],
      ["=#REF!"],
    ];
    expect(sheet.getRange("C1:C4").values).toEqual([["A11"], [7], ["#DIV/0!"], ["#REF!"]]);

    sheet.getRange("D1").formulas = [["=D1"]];
    expect(sheet.getRange("D1").values).toEqual([["#CYCLE!"]]);
  });

  test("finds and translates only real A1 references", () => {
    expect(
      referencesInFormula("=SUM(A1:B2,\"C3\",'Inputs Q1'!$D$4,LOG10(E5),'O''Brien'!F6)"),
    ).toEqual([
      {
        sheetName: null,
        start: { row: 0, col: 0 },
        end: { row: 1, col: 1 },
      },
      {
        sheetName: "Inputs Q1",
        start: { row: 3, col: 3 },
        end: { row: 3, col: 3 },
      },
      {
        sheetName: null,
        start: { row: 4, col: 4 },
        end: { row: 4, col: 4 },
      },
      {
        sheetName: "O'Brien",
        start: { row: 5, col: 5 },
        end: { row: 5, col: 5 },
      },
    ]);

    expect(translateFormula("=A1+$B$1+C$1+$D1+\"A1\"+'O''Brien'!E5", 1, 1)).toBe(
      "=B2+$B$1+D$1+$D2+\"A1\"+'O''Brien'!F6",
    );
    expect(translateFormula("=XFD1", 0, 1)).toBe("=#REF!");

    const doubleQuotedSheet = `='A"B'!A1&"A1"`;
    expect(referencesInFormula(doubleQuotedSheet)).toEqual([
      {
        sheetName: 'A"B',
        start: { row: 0, col: 0 },
        end: { row: 0, col: 0 },
      },
    ]);
    expect(translateFormula(doubleQuotedSheet, 1, 1)).toBe(`='A"B'!B2&"A1"`);
  });

  test("round-trips A1 and R1C1 formulas while preserving literals", () => {
    const anchor = { row: 3, col: 3 };
    const a1 = '=C4+$A$1+D$2+"RC[-1]"';
    const r1c1 = '=RC[-1]+R1C1+R2C+"RC[-1]"';

    expect(formulaToR1C1(a1, anchor)).toBe(r1c1);
    expect(formulaFromR1C1(r1c1, anchor)).toBe(a1);
    expect(formulaFromR1C1("=R1C1!R1C1+'R[1]C[1]'!R2C2", anchor)).toBe(
      "=R1C1!$A$1+'R[1]C[1]'!$B$2",
    );
    expect(formulaToR1C1(`='A"B'!D4&"D4"`, anchor)).toBe(`='A"B'!RC&"D4"`);
    expect(formulaFromR1C1(`='A"B'!RC&"RC"`, anchor)).toBe(`='A"B'!D4&"RC"`);
    expect(() => formulaFromR1C1("=R[-1]C", { row: 0, col: 0 })).toThrow(
      /outside worksheet bounds/,
    );
  });
});

describe("spreadsheet range mutations", () => {
  test("fills formulas with relative and absolute references in one transaction", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Sheet1");
    sheet.getRange("A1:D4").values = [
      [10, 20, 30, 40],
      [11, 21, 31, 41],
      [12, 22, 32, 42],
      [13, 23, 33, 43],
    ];
    sheet.getRange("E2").formulas = [['=A2+$B$1+C$1+$D2+"A2"']];

    const beforeFill = workbook.revision;
    sheet.getRange("E2:E4").fillDown();
    expect(workbook.revision).toBe(beforeFill + 1);
    expect(sheet.getRange("E2:E4").formulas).toEqual([
      ['=A2+$B$1+C$1+$D2+"A2"'],
      ['=A3+$B$1+C$1+$D3+"A2"'],
      ['=A4+$B$1+C$1+$D4+"A2"'],
    ]);

    sheet.getRange("F1").formulas = [['=A1+$B1+C$1+"A1"']];
    sheet.getRange("F1:H1").fillRight();
    expect(sheet.getRange("F1:H1").formulas).toEqual([
      ['=A1+$B1+C$1+"A1"', '=B1+$B1+D$1+"A1"', '=C1+$B1+E$1+"A1"'],
    ]);
  });

  test("supports atomic auto-sized writes and explicit R1C1 payloads", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Sheet1");

    const beforeValues = workbook.revision;
    const written = sheet.getRange("B2").write([
      [1, 2],
      [3, 4],
    ]);
    expect(workbook.revision).toBe(beforeValues + 1);
    expect(written.address).toEqual({
      row: 1,
      col: 1,
      rowCount: 2,
      colCount: 2,
    });
    expect(sheet.getRange("B2:C3").values).toEqual([
      [1, 2],
      [3, 4],
    ]);

    sheet.getRange("D2").write({ formulasR1C1: [["=RC[-2]*2"], ["=RC[-2]*2"]] });
    expect(sheet.getRange("D2:D3").formulas).toEqual([["=B2*2"], ["=B3*2"]]);
    expect(sheet.getRange("D2:D3").formulasR1C1).toEqual([["=RC[-2]*2"], ["=RC[-2]*2"]]);
    expect(sheet.getRange("D2:D3").values).toEqual([[2], [6]]);

    expect(() => sheet.getRange("A1").write({} as never)).toThrow(/exactly one/);
    expect(() =>
      sheet.getRange("A1").write({ values: [[1]], formulas: [["=1"]] } as never),
    ).toThrow(/exactly one/);
    expect(() => sheet.getRange("A1").write([[1, 2], [3]])).toThrow(/equal length/);
  });

  test("copies formulas relatively and snapshots overlapping value copies", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Sheet1");
    sheet.getRange("A1:D2").values = [
      [10, 20, 30, 40],
      [11, 21, 31, 41],
    ];
    sheet.getRange("E1").formulas = [['=A1+$B$1+C$1+$D1+"A1"']];
    sheet.getRange("F2").copyFrom(sheet.getRange("E1"), "formulas");
    expect(sheet.getRange("F2").formulas).toEqual([['=B2+$B$1+D$1+$D2+"A1"']]);

    sheet.getRange("A4:C4").values = [[1, 2, 3]];
    const beforeCopy = workbook.revision;
    sheet.getRange("B4:C4").copyFrom(sheet.getRange("A4:B4"), "values");
    expect(workbook.revision).toBe(beforeCopy + 1);
    expect(sheet.getRange("A4:C4").values).toEqual([[1, 1, 2]]);
  });

  test("imports ragged CSV rows into a rectangular sparse model", async () => {
    const workbook = await Workbook.fromCSV("name,value\nalpha\nbeta,2");
    const sheet = workbook.worksheets.getActiveWorksheet();
    expect(sheet.getRange("A1:B3").values).toEqual([
      ["name", "value"],
      ["alpha", null],
      ["beta", 2],
    ]);

    const empty = await Workbook.fromCSV("");
    expect(empty.worksheets.getActiveWorksheet().getUsedRange()).toBeNull();
  });
});

test("spreadsheet facade fails explicitly for shapes it cannot persist", () => {
  const sheet = Workbook.create().worksheets.add("Sheet1");
  expect(() => sheet.shapes.add({ geometry: "textbox", text: "not silently lost" })).toThrow(
    /Spreadsheet shapes.*not supported/i,
  );
  expect(sheet.shapes.items).toHaveLength(0);
});
