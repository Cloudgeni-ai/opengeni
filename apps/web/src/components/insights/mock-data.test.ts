import { describe, expect, test } from "bun:test";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import {
  buildInsightsDiagnostics,
  buildInsightsView,
  formatDeltaUsd,
  formatPctDelta,
  formatUsd,
  formatUtcTimestamp,
  formatWarmHours,
  pctDelta,
} from "./mock-data";

function snapshot(overrides: Partial<WorkspaceInsightsSnapshot> = {}): WorkspaceInsightsSnapshot {
  return {
    range: "week",
    rangeLabel: "Last 7 days (UTC)",
    priorLabel: "Prior 7 days",
    seriesLabel: "Credit $ / UTC day",
    cacheSeriesLabel: "Cache hit % / UTC day",
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-07-08T00:00:00.000Z",
    generatedAt: "2026-07-08T00:00:00.000Z",
    timezone: "UTC",
    models: [
      {
        id: "openai:gpt-5.4:opengeni_credits",
        model: "gpt-5.4",
        provider: "openai",
        billing: "opengeni_credits",
        calls: 10,
        inputTokens: 1000,
        outputTokens: 100,
        cachedTokens: 400,
        cacheInputTokens: 1_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1_100,
        tokenKnownCalls: 10,
        cacheKnownCalls: 10,
        creditUsd: 2.5,
        estimatedProviderUsd: 2,
        estimatedProviderCostKnownCalls: 8,
        equivalentCreditUsd: 2.1,
        equivalentCreditCostKnownCalls: 8,
      },
    ],
    facets: [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "anthropic", model: "claude-sonnet" },
    ],
    series: [
      {
        label: "07-01",
        modelCostUsd: 1.2,
        estimatedProviderUsd: 1,
        estimatedProviderCostKnownCalls: 4,
        equivalentCreditUsd: 1.05,
        equivalentCreditCostKnownCalls: 4,
        warmSeconds: 3600,
        inputTokens: 500,
        outputTokens: 50,
        cachedTokens: 200,
        cacheInputTokens: 500,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 550,
        tokenKnownCalls: 5,
        cacheKnownCalls: 5,
        cacheHitPct: 40,
        calls: 5,
      },
    ],
    depth: [{ depth: 0, sessions: 3 }],
    drivers: [],
    schedules: [],
    recentCalls: [],
    promptContributions: {
      estimatedTokens: 0,
      utf8Bytes: 0,
      coveredCalls: 0,
      totalCalls: 0,
      sources: [],
    },
    warmSeconds: 7200,
    priorWarmSeconds: 3600,
    warmGroups: [],
    liveWarm: [],
    floor: [],
    selfhostedEnabled: false,
    machinesOnline: 0,
    workspaceCreditUsd: 3,
    priorWorkspaceCreditUsd: 1,
    creditUsd: 2.5,
    priorCreditUsd: 1,
    estimatedProviderUsd: 2,
    priorEstimatedProviderUsd: 1,
    estimatedProviderCostKnownCalls: 8,
    priorEstimatedProviderCostKnownCalls: 4,
    equivalentCreditUsd: 2.1,
    priorEquivalentCreditUsd: 1.05,
    equivalentCreditCostKnownCalls: 8,
    priorEquivalentCreditCostKnownCalls: 4,
    modelCalls: 10,
    priorInputTokens: 500,
    priorTotalTokens: 550,
    priorCacheHitPct: 20,
    priorCalls: 4,
    goalsActive: 1,
    goalsCompleted: 2,
    sessionsTouched: 3,
    rootSessions: 3,
    deepestDepth: 0,
    deepestSessionTitle: "",
    avgDepth: 0,
    warmIdleNow: 0,
    billableTokensUsed: 1000,
    billableTokenCap: 10_000,
    agentRunsUsed: 5,
    agentRunCap: 100,
    modelFilterActive: false,
    dataThrough: "2026-07-07T23:59:00.000Z",
    cacheHitPct: 40,
    scope: { rootSessionId: null, sessionId: null },
    driverGroups: 0,
    driversTruncated: false,
    facetsTruncated: false,
    recentCallsTruncated: false,
    ...overrides,
  };
}

describe("buildInsightsView", () => {
  test("does not rescale warm series when deriving totals", () => {
    const view = buildInsightsView(snapshot(), { provider: "all", model: "all" });
    expect(view.totals.creditUsd).toBe(3);
    expect(view.totals.cacheHitPct).toBe(40);
    expect(view.series[0]?.warmSeconds).toBe(3600);
    expect(view.deltas.warmPct).toBe(100);
  });

  test("keeps unfiltered facet options for dropdowns", () => {
    const view = buildInsightsView(
      snapshot({
        modelFilterActive: true,
        models: [
          {
            id: "openai:gpt-5.4:opengeni_credits",
            model: "gpt-5.4",
            provider: "openai",
            billing: "opengeni_credits",
            calls: 1,
            inputTokens: 10,
            outputTokens: 1,
            cachedTokens: 0,
            cacheInputTokens: 10,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 11,
            tokenKnownCalls: 1,
            cacheKnownCalls: 1,
            creditUsd: 0.1,
            estimatedProviderUsd: 0.08,
            estimatedProviderCostKnownCalls: 1,
            equivalentCreditUsd: 0.084,
            equivalentCreditCostKnownCalls: 1,
          },
        ],
      }),
      { provider: "openai", model: "all" },
    );
    expect(view.availableProviders).toEqual(["anthropic", "openai"]);
    expect(view.availableModels).toEqual(["gpt-5.4"]);
    expect(view.totals.creditUsd).toBe(2.5);
    expect(view.totals.estimatedProviderUsd).toBe(2);
  });

  test("counts a provider model once across billing paths", () => {
    const base = snapshot().models[0]!;
    const view = buildInsightsView(
      snapshot({
        models: [
          base,
          {
            ...base,
            id: "openai:gpt-5.4:external",
            billing: "external",
            calls: 2,
            creditUsd: 0,
          },
        ],
      }),
      { provider: "all", model: "all" },
    );

    expect(view.providers[0]?.models).toBe(1);
    expect(view.providers[0]?.calls).toBe(12);
  });

  test("splits credit-paid spend from the external estimate and uncached input", () => {
    const base = snapshot().models[0]!;
    const view = buildInsightsView(
      snapshot({
        models: [
          base,
          {
            ...base,
            id: "openai:gpt-5.4:external",
            billing: "external",
            creditUsd: 0,
            estimatedProviderUsd: 1.25,
          },
        ],
      }),
      { provider: "all", model: "all" },
    );
    expect(view.totals.creditPaidUsd).toBe(2.5);
    expect(view.totals.externalEstimatedUsd).toBe(1.25);
    expect(view.totals.uncachedInputTokens).toBe(1_200);
  });

  test("keeps cache hit Unknown instead of zero when no input was reported", () => {
    const base = snapshot().models[0]!;
    const view = buildInsightsView(
      snapshot({
        models: [{ ...base, cachedTokens: 0, cacheInputTokens: 0, cacheKnownCalls: 0 }],
        priorCacheHitPct: null,
      }),
      { provider: "all", model: "all" },
    );
    expect(view.totals.cacheHitPct).toBeNull();
    expect(view.deltas.cachePts).toBeNull();
  });

  test("uses the scoped fact total instead of the workspace ledger for a session scope", () => {
    const view = buildInsightsView(
      snapshot({
        scope: { rootSessionId: "00000000-0000-4000-8000-000000000001", sessionId: null },
      }),
      { provider: "all", model: "all" },
    );
    expect(view.totals.creditUsd).toBe(2.5);
  });

  test("formats signed USD deltas with the sign before the currency", () => {
    expect(formatDeltaUsd(-0.1754)).toBe("\u2212$0.1754");
    expect(formatDeltaUsd(1.17)).toBe("+$1.17");
    expect(formatDeltaUsd(0)).toBe("$0.00");
  });

  test("formatWarmHours stays in hours", () => {
    expect(formatWarmHours(3600)).toBe("1.00h");
    expect(formatWarmHours(36_000)).toBe("10.0h");
  });

  test("pctDelta is null for a new non-zero window", () => {
    expect(pctDelta(10, 0)).toBeNull();
    expect(formatPctDelta(null, "Prior 7 days")).toBe("new vs prior 7 days");
  });

  test("keeps sub-cent USD precision and formats timestamps explicitly in UTC", () => {
    expect(formatUsd(0.000002)).toBe("$0.000002");
    expect(formatUtcTimestamp("2026-08-07T12:34:56.000Z")).toContain("UTC");
  });
});

describe("buildInsightsDiagnostics", () => {
  function call(
    id: string,
    totalTokens: number | null,
    inputTokens: number | null,
    cached: number | null,
  ) {
    return {
      id,
      occurredAt: "2026-07-07T10:00:00.000Z",
      recordedAt: "2026-07-07T10:00:01.000Z",
      sessionId: "00000000-0000-4000-8000-000000000009",
      sessionTitle: `Session ${id}`,
      turnId: "00000000-0000-4000-8000-000000000010",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.4",
      billing: "opengeni_credits" as const,
      inputTokens,
      outputTokens: 10,
      cachedTokens: cached,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens,
      creditUsd: 0.01,
      estimatedProviderUsd: null,
      equivalentCreditUsd: null,
      pricingSource: null,
    };
  }

  test("flags calls far above the sampled median and ignores unreported totals", () => {
    const diagnostics = buildInsightsDiagnostics(
      snapshot({
        recentCalls: [
          call("a", 1_000, 900, 800),
          call("b", 1_100, 1_000, 900),
          call("c", 900, 800, 700),
          call("d", 1_000, 900, 800),
          call("e", 12_000, 11_900, 0),
          call("f", null, null, null),
        ],
      }),
    );
    expect(diagnostics.medianTotalTokens).toBe(1_000);
    expect(diagnostics.outliers.map((row) => row.call.id)).toEqual(["e"]);
    expect(diagnostics.cacheMisses.map((row) => row.call.id)).toEqual(["e"]);
  });

  test("reports no outliers when the sample is too small to have a median", () => {
    const diagnostics = buildInsightsDiagnostics(
      snapshot({ recentCalls: [call("a", 1_000, 900, 0), call("b", 90_000, 20_000, 0)] }),
    );
    expect(diagnostics.outliers).toEqual([]);
    expect(diagnostics.cacheMisses.map((row) => row.call.id)).toEqual(["b"]);
  });
});
