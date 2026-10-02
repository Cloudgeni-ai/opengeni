import { describe, expect, test } from "bun:test";
import type { OrganizationModelUsageTotals } from "@opengeni/contracts/organization-model-usage";

import {
  cacheHitLabel,
  externalSpendCellLabel,
  externalSpendLabel,
  formatMicrosUsd,
  formatTokenCount,
  ledgerCoverageNote,
  organizationPayerRows,
  summarizeModelUsage,
} from "./organization-model-usage";

function totals(overrides: Partial<OrganizationModelUsageTotals>): OrganizationModelUsageTotals {
  return {
    billingPath: "opengeni_credits",
    calls: "0",
    inputTokens: "0",
    outputTokens: "0",
    cachedTokens: "0",
    cacheInputTokens: "0",
    cacheWriteTokens: "0",
    totalTokens: "0",
    tokenKnownCalls: "0",
    cacheKnownCalls: "0",
    creditMicros: "0",
    estimatedProviderMicros: "0",
    estimatedProviderKnownCalls: "0",
    ...overrides,
  };
}

describe("organization model usage view", () => {
  test("keeps charged credits and the external estimate separate and exact", () => {
    const summary = summarizeModelUsage([
      totals({
        calls: "3",
        creditMicros: "9007199254740993",
        estimatedProviderMicros: "7",
        cachedTokens: "30",
        cacheInputTokens: "120",
        totalTokens: "150",
      }),
      totals({
        billingPath: "external",
        calls: "4",
        estimatedProviderMicros: "2500000",
        estimatedProviderKnownCalls: "3",
        totalTokens: "50",
      }),
    ]);
    expect(summary.creditMicros).toBe(9007199254740993n);
    expect(summary.creditCalls).toBe(3n);
    expect(summary.externalEstimateMicros).toBe(2500000n);
    expect(summary.externalPricedCalls).toBe(3n);
    expect(formatMicrosUsd(summary.creditMicros)).toBe("$9,007,199,254.74");
    expect(externalSpendLabel(summary)).toBe("~$2.50");
    expect(externalSpendCellLabel(summary)).toBe("~$2.50 · 3/4 priced");
    expect(cacheHitLabel(summary)).toBe("25%");
    expect(cacheHitLabel({ cachedTokens: 999n, cacheInputTokens: 1000n })).toBe("100%");
    expect(cacheHitLabel({ cachedTokens: 994n, cacheInputTokens: 1000n })).toBe("99%");
    expect(formatTokenCount(summary.totalTokens)).toBe("200");
  });

  test("reports Unknown instead of zero when nothing was priced or cache was unreported", () => {
    const summary = summarizeModelUsage([totals({ billingPath: "external", calls: "2" })]);
    expect(externalSpendLabel(summary)).toBe("Unknown");
    expect(cacheHitLabel(summary)).toBe("Unknown");
    expect(externalSpendLabel(summarizeModelUsage([]))).toBe("$0.00");
  });

  test("states exact ledger coverage only when the per-call breakdown differs by a cent or more", () => {
    expect(ledgerCoverageNote(undefined, 5_000_000n)).toBeNull();
    expect(ledgerCoverageNote("5009999", 5_000_000n)).toBeNull();
    expect(ledgerCoverageNote("7500000", 5_000_000n)).toBe(
      "$2.50 of the $7.50 charged has no per-call record yet, so the lists below add up to $5.00. Missing records are rebuilt from each call's usage automatically.",
    );
    expect(ledgerCoverageNote("4000000", 5_000_000n)).toBe(
      "The per-call records add up to $1.00 more than the $4.00 charged in this period.",
    );
    expect(formatTokenCount(22_059_000_000n)).toBe("22.1B");
  });

  test("splits spend by who pays from the server's payer totals, else from the models", () => {
    const credit = totals({ calls: "2", totalTokens: "100", creditMicros: "1500000" });
    const plan = totals({
      billingPath: "external",
      calls: "3",
      totalTokens: "300",
      estimatedProviderMicros: "2000000",
      estimatedProviderKnownCalls: "2",
    });
    const strip = ({ billingPath: _path, ...rest }: OrganizationModelUsageTotals) => rest;
    expect(
      organizationPayerRows({
        payers: [
          { payer: "own_key", ...strip(plan) },
          { payer: "opengeni_credits", ...strip(credit) },
        ],
        models: [],
      }).map((row) => [row.payer, row.calls, row.micros, row.pricedCalls]),
    ).toEqual([
      ["opengeni_credits", 2n, 1_500_000n, 2n],
      ["own_key", 3n, 2_000_000n, 2n],
    ]);
    expect(
      organizationPayerRows({
        models: [
          { provider: "codex-subscription", model: "gpt-6", totals: plan },
          { provider: "openai", model: "gpt-5", totals: credit },
        ],
      }).map((row) => row.payer),
    ).toEqual(["opengeni_credits", "subscription"]);
  });
});
