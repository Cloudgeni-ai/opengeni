import { describe, expect, test } from "bun:test";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import {
  buildInsightsView,
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
    seriesLabel: "Credit $ / day",
    cacheSeriesLabel: "Cache hit % / day",
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
