import { describe, expect, test } from "bun:test";
import { InsightsUsageGroupBy, InsightsUsageResponse } from "@opengeni/contracts/insights-usage";
import {
  emptyTokens,
  usageResponseForGrouping,
  type UsageGroupBy,
  type UsageResponse,
} from "./usage-contract";
import { GROUP_ORDER } from "./usage-groups";
import { loadUsage } from "./usage-source";

function response(groupBy: InsightsUsageGroupBy): InsightsUsageResponse {
  const zeroPayer = { calls: 0, chargedMicros: 0, listMicros: 0 };
  const measures = {
    calls: 1,
    tokenKnownCalls: 0,
    cacheKnownCalls: 0,
    cacheWriteKnownCalls: 0,
    listClassKnownCalls: 0,
    tokens: emptyTokens(),
    chargedMicros: 7,
    listMicros: 11,
    listByClassMicros: null,
    listByClassApprox: false,
    pricedCalls: 1,
    byPayer: {
      opengeni_credits: { calls: 1, chargedMicros: 7, listMicros: 11 },
      subscription: { ...zeroPayer },
      own_key: { ...zeroPayer },
    },
  };
  return InsightsUsageResponse.parse({
    scope: {
      kind: "workspace",
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    },
    range: "week",
    windowStart: "2026-09-28T00:00:00Z",
    windowEnd: "2026-10-03T10:00:00Z",
    priorWindowStart: "2026-09-21T00:00:00Z",
    priorWindowEnd: "2026-09-26T10:00:00Z",
    bucket: "day",
    generatedAt: "2026-10-03T10:00:00Z",
    dataThrough: null,
    totals: measures,
    prior: null,
    groupBy,
    groups: [{ key: "private:member", kind: "private", label: "Private chats", measures }],
    groupCount: 1,
    groupsTruncated: false,
    series: [{ start: "2026-10-03T00:00:00Z", measures }],
    facets: {
      workspaces: [],
      providers: [],
      models: [],
      payers: [],
      plans: ["recorded-plan"],
      sources: ["api"],
      projects: [],
      people: [],
      schedules: [],
    },
  });
}

function capabilities(groupBy: UsageGroupBy): UsageResponse["capabilities"] {
  return { groupBy: [groupBy], filters: [], ranges: ["week"], seriesGroups: true };
}

describe("dashboard usage response projection", () => {
  test.each([...GROUP_ORDER])(
    "preserves all shared response fields for requested %s grouping",
    (groupBy) => {
      const native = response(groupBy);
      const supported = capabilities(groupBy);
      const projected = usageResponseForGrouping(native, groupBy, supported);
      expect(projected).toEqual({ ...native, groupBy, capabilities: supported });
      expect(projected.scope).toBe(native.scope);
      expect(projected.groups).toBe(native.groups);
      expect(projected.totals).toBe(native.totals);
      expect(projected.facets).toBe(native.facets);
      expect(projected.capabilities).toBe(supported);
    },
  );

  test("rejects a response grouped differently from the supported request", () => {
    expect(() =>
      usageResponseForGrouping(response("provider"), "model", capabilities("model")),
    ).toThrow("Usage response grouping does not match the request");
  });

  test("the native loader projects the shared response without changing its measures or facets", async () => {
    const query = { range: "week", groupBy: "model", filters: {} } as const;
    const native = response(query.groupBy);
    const client = { requestJson: async () => native } as unknown as Parameters<
      typeof loadUsage
    >[0];
    const loaded = await loadUsage(client, native.scope, query, new AbortController().signal);
    expect(loaded.source).toBe("usage");
    expect(loaded.usage.groupBy).toBe(query.groupBy);
    expect(loaded.usage.totals).toBe(native.totals);
    expect(loaded.usage.facets).toBe(native.facets);
  });

  test("the native loader rejects a grouping mismatch rather than falling back or relabelling", async () => {
    const native = response("provider");
    const client = { requestJson: async () => native } as unknown as Parameters<
      typeof loadUsage
    >[0];
    await expect(
      loadUsage(
        client,
        native.scope,
        { range: "week", groupBy: "model", filters: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Usage response grouping does not match the request");
  });

  const supported = new Set<string>(GROUP_ORDER);
  for (const groupBy of InsightsUsageGroupBy.options.filter((group) => !supported.has(group))) {
    test(`rejects API-only ${groupBy} grouping instead of mislabelling it`, () => {
      expect(() =>
        usageResponseForGrouping(response(groupBy), "model", capabilities("model")),
      ).toThrow("Usage response grouping does not match the request");
    });
  }
});
