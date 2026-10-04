import { describe, expect, test } from "bun:test";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import { catalogLabels, modelDisplayName, providerDisplayName } from "./model-display";
import { workspaceUsageFromSnapshot } from "./usage-adapter";
import { emptyMeasures, parseModelFilterKey, type UsageGroup } from "./usage-contract";
import { niceScale } from "./usage-chart";
import { breakdownRows } from "./usage-groups";
import { cacheHitRate, costMicros, formatMoney, relativeChange } from "./usage-format";
import { nextUsageSearch, parseUsageSearch, usageQuery } from "./usage-search";

describe("model display", () => {
  test("clean names from raw ids, with the connection prefix gone", () => {
    expect(modelDisplayName("codex-subscription", "codex/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(
      modelDisplayName(
        "organization-claude-subscription",
        "organization-claude-subscription/claude-opus-5-5",
      ),
    ).toBe("Claude Opus 5.5");
    expect(modelDisplayName("opengeni-gateway", "anthropic/claude-sonnet-4.6")).toBe(
      "Claude Sonnet 4.6",
    );
    expect(modelDisplayName("supergrok-subscription", "grok-4.6")).toBe("Grok 4.6");
  });

  test("a curated catalog label wins", () => {
    const labels = catalogLabels([{ id: "codex/gpt-6.1-sol", label: "GPT-6.1 Sol (fast)" }]);
    expect(modelDisplayName("codex-subscription", "codex/gpt-6.1-sol", labels)).toBe(
      "GPT-6.1 Sol (fast)",
    );
  });

  test("workspace and organization connections read the same", () => {
    expect(providerDisplayName("workspace-claude-subscription")).toBe("Claude plan");
    expect(providerDisplayName("organization-claude-subscription")).toBe("Claude plan");
    expect(providerDisplayName("codex-subscription")).toBe("ChatGPT plan");
  });
});

describe("usage search", () => {
  test("drops defaults and invalid values", () => {
    expect(parseUsageSearch({ range: "week", group: "model", metric: "spend" })).toEqual({});
    expect(parseUsageSearch({ range: "forever", payer: "nobody,subscription" })).toEqual({
      payer: "subscription",
    });
  });

  test("a custom range needs both days in order", () => {
    expect(parseUsageSearch({ range: "custom", start: "2026-09-01", end: "2026-09-15" })).toEqual({
      range: "custom",
      start: "2026-09-01",
      end: "2026-09-15",
    });
    expect(parseUsageSearch({ range: "custom", start: "2026-09-15", end: "2026-09-01" })).toEqual(
      {},
    );
    expect(parseUsageSearch({ range: "custom", start: "nope" })).toEqual({});
    expect(
      nextUsageSearch(
        { range: "custom", start: "2026-09-01", end: "2026-09-02" },
        { range: "ytd" },
      ),
    ).toEqual({
      range: "ytd",
    });
  });

  test("filters round-trip, models split on the first slash", () => {
    const search = nextUsageSearch(
      {},
      { filter: { field: "model", values: ["codex-subscription/codex/gpt-6.1-sol"] } },
    );
    expect(usageQuery(search).filters.model).toEqual(["codex-subscription/codex/gpt-6.1-sol"]);
    expect(parseModelFilterKey("codex-subscription/codex/gpt-6.1-sol")).toEqual({
      provider: "codex-subscription",
      model: "codex/gpt-6.1-sol",
    });
    expect(nextUsageSearch(search, { clearFilters: true })).toEqual({});
  });
});

describe("usage math", () => {
  test("cost counts credits charged plus list price for plans and keys", () => {
    const measures = {
      ...emptyMeasures(),
      calls: 3,
      chargedMicros: 1_000_000,
      listMicros: 5_000_000,
      byPayer: {
        opengeni_credits: { calls: 1, chargedMicros: 1_000_000, listMicros: 900_000 },
        subscription: { calls: 2, chargedMicros: 0, listMicros: 4_100_000 },
      },
    };
    expect(costMicros(measures)).toBe(5_100_000);
    expect(formatMoney(5_100_000)).toBe("$5.10");
  });

  test("cache hit rate is cache reads over all input, null without cache data", () => {
    const measures = {
      ...emptyMeasures(),
      calls: 1,
      cacheKnownCalls: 1,
      tokens: { uncachedInput: 10, cacheRead: 80, cacheWrite: 10, output: 5, reasoning: 0 },
    };
    expect(cacheHitRate(measures)).toBe(0.8);
    expect(cacheHitRate(emptyMeasures())).toBeNull();
  });

  test("no comparison against an empty prior window", () => {
    expect(relativeChange(10, 0)).toBeNull();
    expect(relativeChange(10, null)).toBeNull();
    expect(relativeChange(15, 10)).toBe(0.5);
  });

  test("chart axis steps are round", () => {
    expect(niceScale(27)).toEqual({ max: 30, step: 10 });
    expect(niceScale(1.7)).toEqual({ max: 2, step: 0.5 });
  });
});

describe("breakdown rows", () => {
  const group = (overrides: Partial<UsageGroup>): UsageGroup => ({
    key: "k",
    kind: "item",
    label: "x",
    measures: { ...emptyMeasures(), calls: 1 },
    ...overrides,
  });

  test("a model served by both Claude plans is one row that filters to both", () => {
    const rows = breakdownRows({
      groupBy: "model",
      groups: [
        group({ key: "a", provider: "organization-claude-subscription", model: "claude-opus-5-5" }),
        group({ key: "b", provider: "workspace-claude-subscription", model: "claude-opus-5-5" }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Claude Opus 5.5");
    expect(rows[0]?.measures.calls).toBe(2);
    expect(rows[0]?.filter?.values).toEqual([
      "organization-claude-subscription/claude-opus-5-5",
      "workspace-claude-subscription/claude-opus-5-5",
    ]);
  });

  test("groups with no usage in the period are left out", () => {
    const rows = breakdownRows({
      groupBy: "workspace",
      groups: [
        group({ key: "w1", label: "Busy" }),
        group({ key: "w2", label: "Idle", measures: emptyMeasures() }),
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(["Busy"]);
  });

  test("private, deleted and folded rows are amounts only, after the named rows", () => {
    const rows = breakdownRows({
      groupBy: "rootSession",
      groups: [
        group({
          key: "private:o1",
          kind: "private",
          label: "Ada",
          measures: { ...emptyMeasures(), calls: 50 },
        }),
        group({ key: "deleted", kind: "deleted", label: "Deleted chats" }),
        group({ key: "s1", label: "Ship it" }),
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(["Ship it", "Private chats", "Deleted chats"]);
    expect(rows[1]?.detail).toBe("Ada");
    expect(rows[1]?.filter).toBeNull();
    expect(rows[1]?.sessionId).toBeUndefined();
    expect(rows[2]?.filter).toBeNull();
    expect(rows[0]?.sessionId).toBe("s1");
  });
});

describe("older Insights endpoint adapter", () => {
  const snapshot = {
    range: "week",
    windowStart: "2026-09-26T00:00:00.000Z",
    windowEnd: "2026-10-03T00:00:00.000Z",
    generatedAt: "2026-10-03T00:00:00.000Z",
    models: [
      {
        id: "m",
        model: "organization-claude-subscription/claude-opus-5-5",
        provider: "organization-claude-subscription",
        billing: "external",
        calls: 10,
        inputTokens: 1_000,
        outputTokens: 100,
        cachedTokens: 600,
        cacheInputTokens: 1_000,
        cacheWriteTokens: 300,
        reasoningTokens: 20,
        totalTokens: 1_100,
        tokenKnownCalls: 10,
        cacheKnownCalls: 10,
        creditUsd: 0,
        estimatedProviderUsd: 2.5,
        estimatedProviderCostKnownCalls: 10,
        equivalentCreditUsd: 2.6,
        equivalentCreditCostKnownCalls: 10,
      },
    ],
    projects: [
      {
        id: "unavailable",
        kind: "unavailable",
        label: "Other people's private chats",
        projects: 0,
        rootSessions: 1,
        calls: 3,
        creditUsd: 0,
        estimatedProviderUsd: 0.5,
        estimatedProviderCostKnownCalls: 3,
        tokens: 300,
        cacheHitPct: null,
      },
    ],
    drivers: [],
    privateChats: [
      {
        ownerKey: "owner-1",
        name: "Ada",
        you: false,
        calls: 3,
        tokens: 300,
        creditUsd: 0,
        estimatedProviderUsd: 0.5,
        estimatedProviderCostKnownCalls: 3,
      },
    ],
    schedules: [],
    series: [],
    recentCalls: [],
    facets: [],
    priorCalls: 0,
    priorTotalTokens: 0,
    priorCreditUsd: 0,
    priorEstimatedProviderUsd: 0,
    priorEstimatedProviderCostKnownCalls: 0,
    driverGroups: 0,
    driversTruncated: false,
    dataThrough: null,
  } as unknown as WorkspaceInsightsSnapshot;
  const scope = { workspaceId: "w", accountId: "a" };

  test("splits input into uncached, cache reads and cache writes", () => {
    const { usage } = workspaceUsageFromSnapshot(
      snapshot,
      { range: "week", groupBy: "model", filters: {} },
      scope,
    );
    expect(usage.totals.tokens).toEqual({
      uncachedInput: 100,
      cacheRead: 600,
      cacheWrite: 300,
      output: 100,
      reasoning: 20,
    });
    expect(usage.totals.byPayer?.subscription?.listMicros).toBe(2_500_000);
    // An empty prior window means no comparison.
    expect(usage.prior).toBeNull();
  });

  test("other people's private chats stay per-person amount rows without session ids", () => {
    const { usage } = workspaceUsageFromSnapshot(
      snapshot,
      { range: "week", groupBy: "rootSession", filters: {} },
      scope,
    );
    expect(usage.groups).toHaveLength(1);
    expect(usage.groups[0]).toMatchObject({
      kind: "private",
      label: "Ada",
      key: "private:owner-1",
    });
    const project = workspaceUsageFromSnapshot(
      snapshot,
      { range: "week", groupBy: "project", filters: {} },
      scope,
    ).usage.groups[0];
    expect(project?.kind).toBe("private");
  });
});
