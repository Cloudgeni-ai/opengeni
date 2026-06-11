import { describe, expect, test } from "bun:test";

import { isCentPrecisionUsdAmount } from "../src/money";

describe("isCentPrecisionUsdAmount", () => {
  test("accepts cent-aligned amounts affected by binary floating-point error", () => {
    expect(isCentPrecisionUsdAmount(19.99)).toBe(true);
    expect(isCentPrecisionUsdAmount(0.1 + 0.2)).toBe(true);
  });

  test("rejects sub-cent precision", () => {
    expect(isCentPrecisionUsdAmount(5.001)).toBe(false);
    expect(isCentPrecisionUsdAmount(19.999)).toBe(false);
  });
});
