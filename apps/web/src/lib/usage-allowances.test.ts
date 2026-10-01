import { describe, expect, test } from "bun:test";

import {
  MAX_BUDGET_MICROS,
  dollarsInputValue,
  formatBudget,
  ordinalDay,
  parseDollars,
} from "./usage-allowances";

describe("console budget units", () => {
  test("dollars typed by a person become exact integer micros", () => {
    expect(parseDollars("500")).toBe(500_000_000);
    expect(parseDollars("$1,200.50")).toBe(1_200_500_000);
    expect(parseDollars(" 83.33 ")).toBe(83_330_000);
    for (const invalid of ["", "-5", "1.234", "abc", "1e3"])
      expect(parseDollars(invalid)).toBeNull();
    expect(parseDollars(String(MAX_BUDGET_MICROS / 1_000_000 + 1))).toBeNull();
  });

  test("budgets read as round numbers and round-trip through the input", () => {
    expect(formatBudget(500_000_000)).toBe("$500");
    expect(formatBudget(83_333_333)).toBe("$83.33");
    expect(dollarsInputValue(500_000_000)).toBe("500");
    expect(dollarsInputValue(83_330_000)).toBe("83.33");
  });

  test("reset days read as ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinalDay)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
    ]);
  });
});
