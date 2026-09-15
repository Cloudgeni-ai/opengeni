import { describe, expect, test } from "bun:test";

import {
  formatSpreadsheetGeneralDisplay,
  spreadsheetCellEditSource,
} from "../src/components/artifacts/spreadsheet-general-display";

const INTL_12 = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 12,
  useGrouping: false,
});

describe("spreadsheet General display (display-only)", () => {
  test("collapses IEEE residue that String(number) leaks", () => {
    expect(110.00000000000001).not.toBe(110);
    expect(String(110.00000000000001)).toBe("110.00000000000001");
    expect(220.00000000000003).not.toBe(220);
    expect(String(220.00000000000003)).toBe("220.00000000000003");
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(String(0.1 + 0.2)).toBe("0.30000000000000004");

    expect(formatSpreadsheetGeneralDisplay(110.00000000000001)).toBe("110");
    expect(formatSpreadsheetGeneralDisplay(220.00000000000003)).toBe("220");
    expect(formatSpreadsheetGeneralDisplay(0.1 + 0.2)).toBe("0.3");
    expect(formatSpreadsheetGeneralDisplay(-110.00000000000001)).toBe("-110");
  });

  test("keeps exact edit-source text and does not feed General collapse into it", () => {
    expect(spreadsheetCellEditSource(110.00000000000001)).toBe("110.00000000000001");
    expect(spreadsheetCellEditSource(220.00000000000003)).toBe("220.00000000000003");
    expect(spreadsheetCellEditSource(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(spreadsheetCellEditSource(-110.00000000000001)).toBe("-110.00000000000001");
  });

  test("does not reuse artifact-tool Intl maximumFractionDigits:12", () => {
    expect(INTL_12.format(1e-20)).toBe("0");
    expect(formatSpreadsheetGeneralDisplay(1e-20)).toBe("1e-20");
    expect(spreadsheetCellEditSource(1e-20)).toBe("1e-20");
  });

  test("keeps exponent-scale values, legitimate precision, integers, and -0", () => {
    expect(formatSpreadsheetGeneralDisplay(1e-20)).toBe("1e-20");
    expect(formatSpreadsheetGeneralDisplay(1e21)).toBe("1e+21");
    expect(formatSpreadsheetGeneralDisplay(1.23456789012345)).toBe("1.23456789012345");
    expect(formatSpreadsheetGeneralDisplay(123456789012345)).toBe("123456789012345");
    expect(formatSpreadsheetGeneralDisplay(42)).toBe("42");
    expect(formatSpreadsheetGeneralDisplay(-42)).toBe("-42");
    expect(formatSpreadsheetGeneralDisplay(0)).toBe("0");
    expect(formatSpreadsheetGeneralDisplay(-0)).toBe("0");
    expect(spreadsheetCellEditSource(1.23456789012345)).toBe("1.23456789012345");
    expect(spreadsheetCellEditSource(1e21)).toBe("1e+21");
    expect(spreadsheetCellEditSource(42)).toBe("42");
    expect(spreadsheetCellEditSource(-0)).toBe("0");
  });

  test("leaves dates, booleans, errors, strings, and empty cells on their existing labels", () => {
    const date = new Date("2024-06-15T00:00:00Z");
    expect(formatSpreadsheetGeneralDisplay(date)).toBe(date.toLocaleDateString());
    expect(spreadsheetCellEditSource(date)).toBe(date.toLocaleDateString());
    expect(formatSpreadsheetGeneralDisplay(true)).toBe("TRUE");
    expect(formatSpreadsheetGeneralDisplay(false)).toBe("FALSE");
    expect(spreadsheetCellEditSource(true)).toBe("TRUE");
    expect(formatSpreadsheetGeneralDisplay("#DIV/0!")).toBe("#DIV/0!");
    expect(spreadsheetCellEditSource("#DIV/0!")).toBe("#DIV/0!");
    expect(formatSpreadsheetGeneralDisplay("kept exactly")).toBe("kept exactly");
    expect(formatSpreadsheetGeneralDisplay(null)).toBe("");
    expect(formatSpreadsheetGeneralDisplay(undefined)).toBe("");
    expect(formatSpreadsheetGeneralDisplay(Number.NaN)).toBe("NaN");
    expect(formatSpreadsheetGeneralDisplay(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});
