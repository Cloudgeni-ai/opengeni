import { describe, expect, test } from "bun:test";
import { auditModelPricingAgainstLlmPrices } from "./check-model-pricing";

describe("check-model-pricing", () => {
  test("matches the committed llm-prices sample fixture", async () => {
    const doc = await Bun.file(
      new URL("./fixtures/llm-prices-current-v1.sample.json", import.meta.url),
    ).json();
    const result = auditModelPricingAgainstLlmPrices(doc);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("reports drift when a short-context rate moves", async () => {
    const doc = await Bun.file(
      new URL("./fixtures/llm-prices-current-v1.sample.json", import.meta.url),
    ).json();
    doc.prices = doc.prices.map((row: { id: string; input: number }) =>
      row.id === "gpt-5.6-luna" ? { ...row, input: 1 } : row,
    );
    const result = auditModelPricingAgainstLlmPrices(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("gpt-5.6-luna input"))).toBe(true);
  });
});
