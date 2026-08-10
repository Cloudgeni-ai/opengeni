import { describe, expect, test } from "bun:test";

import { ArtifactLimitError } from "../src/errors";
import {
  FormulaEvaluationBudget,
  evaluateFormula,
  validateFormulaLimits,
} from "../src/spreadsheet-formula";
import { Workbook } from "../src/spreadsheet";

describe("formula resource boundaries", () => {
  test("rejects a full-sheet range before allocating or reading one cell", () => {
    let reads = 0;
    const action = () =>
      evaluateFormula("=SUM(A1:XFD1048576)", {
        currentSheetName: "Sheet1",
        getCell: () => {
          reads += 1;
          return null;
        },
      });

    expect(action).toThrow(ArtifactLimitError);
    expect(action).toThrow(/formula range cells/);
    expect(reads).toBe(0);
  });

  test("bounds UTF-8 source bytes, tokens, nesting, and function arguments", () => {
    expect(() => validateFormulaLimits('="ééééé"', { maxFormulaBytes: 10 })).toThrow(
      /formula bytes/,
    );
    expect(() => validateFormulaLimits("=1+2+3", { maxTokens: 4 })).toThrow(/formula tokens/);
    expect(() => validateFormulaLimits("=((((1))))", { maxNestingDepth: 3 })).toThrow(
      /formula nesting depth/,
    );
    expect(() => validateFormulaLimits("=SUM(1,2,3)", { maxFunctionArguments: 2 })).toThrow(
      /formula function arguments/,
    );
  });

  test("charges dependency fanout and operations before the rejected work", () => {
    let reads = 0;
    const readBudget = new FormulaEvaluationBudget({ maxCellReads: 2 });
    expect(() =>
      evaluateFormula("=A1+A2+A3", {
        currentSheetName: "Sheet1",
        budget: readBudget,
        getCell: () => {
          reads += 1;
          return 1;
        },
      }),
    ).toThrow(/formula dependency reads/);
    expect(reads).toBe(2);
    expect(readBudget.usage.cellReads).toBe(2);

    const operationBudget = new FormulaEvaluationBudget({ maxOperations: 2 });
    expect(() =>
      evaluateFormula("=1+2", {
        currentSheetName: "Sheet1",
        budget: operationBudget,
        getCell: () => null,
      }),
    ).toThrow(/formula evaluation operations/);
    expect(operationBudget.usage.operations).toBe(2);
  });

  test("reuses fuel only between roots and cannot reset from a cell callback", () => {
    const budget = new FormulaEvaluationBudget({
      maxCellReads: 2,
      maxOperations: 8,
    });
    let resetAttempts = 0;
    const bypassResult = budget.runIsolatedRoot((rootBudget) =>
      evaluateFormula("=A1+A2+A3", {
        currentSheetName: "Sheet1",
        budget: rootBudget,
        getCell: () => {
          resetAttempts += 1;
          rootBudget.runIsolatedRoot(() => undefined);
          return 1;
        },
      }),
    );
    expect(bypassResult).toBe("#VALUE!");
    expect(resetAttempts).toBe(1);
    expect(budget.usage.cellReads).toBe(1);

    const independentResult = budget.runIsolatedRoot((rootBudget) =>
      evaluateFormula("=A1", {
        currentSheetName: "Sheet1",
        budget: rootBudget,
        getCell: () => 7,
      }),
    );
    expect(independentResult).toBe(7);
    expect(budget.usage.cellReads).toBe(1);

    let expiredRoot:
      | ((evaluate: (rootBudget: FormulaEvaluationBudget) => number) => number)
      | undefined;
    const batch = budget.runIsolatedRoots((runRoot) => {
      expiredRoot = runRoot;
      const first = runRoot((rootBudget) => {
        rootBudget.consumeOperations(2);
        expect(() => runRoot(() => 0)).toThrow(/active root/i);
        return rootBudget.operationCount;
      });
      const second = runRoot((rootBudget) => rootBudget.operationCount);
      return [first, second];
    });
    expect(batch).toEqual([2, 0]);
    expect(() => expiredRoot!(() => 0)).toThrow(/no longer active/i);
  });

  test("checks concatenated result length before joining", () => {
    const values = new Map([
      ["0:0", "abc"],
      ["1:0", "def"],
    ]);
    expect(() =>
      evaluateFormula("=A1&A2", {
        currentSheetName: "Sheet1",
        budget: new FormulaEvaluationBudget({ maxResultStringChars: 5 }),
        getCell: (_sheetName, address) => values.get(`${address.row}:${address.col}`) ?? null,
      }),
    ).toThrow(/formula result characters/);
  });

  test("bounds dependency recursion with one shared root budget", () => {
    const workbook = Workbook.create({
      formulaLimits: { maxDependencyDepth: 2 },
    });
    const sheet = workbook.worksheets.add("Sheet1");
    sheet.getRange("A1:A3").formulas = [["=A2"], ["=A3"], ["=A4"]];
    sheet.getRange("A4").values = [[1]];

    expect(() => sheet.getRange("A1").values).toThrow(/formula dependency depth/);
  });

  test("meters whole recalculations and never launders failed dependency work through cache", () => {
    const aggregate = Workbook.create({
      recalculationLimits: { maxOperations: 4 },
    });
    aggregate.worksheets.add("Aggregate").getRange("A1:A2").formulas = [["=1+1"], ["=1+1"]];
    expect(() => aggregate.recalculate()).toThrow(/spreadsheet recalculation operations/);

    const retry = Workbook.create({ formulaLimits: { maxOperations: 8 } });
    const retrySheet = retry.worksheets.add("Retry");
    retrySheet.getRange("B1:C1").formulas = [["=1+2", "=3+4"]];
    retrySheet.getRange("A1").formulas = [["=B1+C1"]];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => retrySheet.getRange("A1").values).toThrow(/formula evaluation operations/);
    }
  });

  test("cached dependency results cannot hide structural depth", () => {
    const workbook = Workbook.create({
      formulaLimits: { maxDependencyDepth: 2 },
    });
    const sheet = workbook.worksheets.add("Depth");
    sheet.getRange("A1:A3").formulas = [["=A2"], ["=A3"], ["=A4"]];
    sheet.getRange("A4").values = [[1]];

    expect(sheet.getRange("A3").values).toEqual([[1]]);
    expect(() => sheet.getRange("A1").values).toThrow(/formula dependency depth/);
  });

  test("validates a formula batch before mutating any cell", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Sheet1");
    sheet.getRange("A1:B1").values = [["left", "right"]];

    expect(() => {
      sheet.getRange("A1:B1").formulas = [["=1", "=SUM(A1:XFD1048576)"]];
    }).toThrow(/formula range cells/);
    expect(sheet.getRange("A1:B1").values).toEqual([["left", "right"]]);
    expect(sheet.getRange("A1:B1").formulas).toEqual([[null, null]]);
  });
});
