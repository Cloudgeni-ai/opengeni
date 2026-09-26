import { describe, expect, test } from "bun:test";
import type { OrganizationModelUsageTotals } from "@opengeni/contracts/organization-model-usage";

import {
  cacheHitLabel,
  externalSpendLabel,
  formatMicrosUsd,
  formatTokenCount,
  ledgerCoverageNote,
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
    expect(cacheHitLabel(summary)).toBe("25%");
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
      "Per-call records cover $5.00 of the $7.50 charged. $2.50 has no per-call record yet; recent gaps are rebuilt automatically from each call's usage event.",
    );
    expect(ledgerCoverageNote("4000000", 5_000_000n)).toBe(
      "Per-call records exceed the $4.00 charged in this period by $1.00.",
    );
    expect(formatTokenCount(22_059_000_000n)).toBe("22.1B");
  });
});
