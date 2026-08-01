import { describe, expect, test } from "bun:test";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import { buildInsightsView, formatPctDelta, formatWarmHours, pctDelta } from "./mock-data";

function snapshot(overrides: Partial<WorkspaceInsightsSnapshot> = {}): WorkspaceInsightsSnapshot {
  return {
    range: "week",
    rangeLabel: "Last 7 days (UTC)",
    priorLabel: "Prior 7 days",
    seriesLabel: "Credit $ / day",
    cacheSeriesLabel: "Cache hit % / day",
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
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        creditUsd: 2.5,
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
        warmSeconds: 3600,
        inputTokens: 500,
        cachedTokens: 200,
        cacheHitPct: 40,
        calls: 5,
      },
    ],
    depth: [{ depth: 0, sessions: 3 }],
    drivers: [],
    schedules: [],
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
    priorInputTokens: 500,
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
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            creditUsd: 0.1,
          },
        ],
      }),
      { provider: "openai", model: "all" },
    );
    expect(view.availableProviders).toEqual(["anthropic", "openai"]);
    expect(view.availableModels).toEqual(["gpt-5.4"]);
    expect(view.totals.creditUsd).toBe(2.5);
  });

  test("formatWarmHours stays in hours", () => {
    expect(formatWarmHours(3600)).toBe("1.00h");
    expect(formatWarmHours(36_000)).toBe("10.0h");
  });

  test("pctDelta is null for a new non-zero window", () => {
    expect(pctDelta(10, 0)).toBeNull();
    expect(formatPctDelta(null, "Prior 7 days")).toBe("new vs prior 7 days");
  });
});
