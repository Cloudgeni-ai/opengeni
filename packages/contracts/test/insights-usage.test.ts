import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  InsightsCall,
  InsightsCallsResponse,
  InsightsUsageMeasures,
  InsightsUsageSource,
  InsightsUsageResponse,
  InsightsUsageSeriesPoint,
  InsightsUsageTokens,
  OrganizationInsightsCallsQuery,
  OrganizationInsightsUsageQuery,
  WorkspaceInsightsCallsQuery,
  WorkspaceInsightsUsageQuery,
  resolveInsightsUsageCustomWindow,
} from "@opengeni/contracts/insights-usage";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const zeroTokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
const zeroPayer = { calls: 0, chargedMicros: 0, listMicros: 0 };

function measures(): InsightsUsageMeasures {
  return {
    calls: 2,
    tokenKnownCalls: 1,
    cacheKnownCalls: 0,
    cacheWriteKnownCalls: 0,
    listClassKnownCalls: 1,
    tokens: { ...zeroTokens, uncachedInput: 10, output: 5 },
    chargedMicros: 5,
    listMicros: 10,
    listByClassMicros: { uncachedInput: 4, cacheRead: 1, cacheWrite: 0, output: 5 },
    listByClassApprox: false,
    pricedCalls: 1,
    byPayer: {
      opengeni_credits: { calls: 1, chargedMicros: 5, listMicros: 10 },
      subscription: { calls: 1, chargedMicros: 0, listMicros: 0 },
      own_key: { ...zeroPayer },
    },
  };
}

function emptyMeasures(): InsightsUsageMeasures {
  return {
    calls: 0,
    tokenKnownCalls: 0,
    cacheKnownCalls: 0,
    cacheWriteKnownCalls: 0,
    listClassKnownCalls: 0,
    tokens: { ...zeroTokens },
    chargedMicros: 0,
    listMicros: 0,
    listByClassMicros: null,
    listByClassApprox: false,
    pricedCalls: 0,
    byPayer: {
      opengeni_credits: { ...zeroPayer },
      subscription: { ...zeroPayer },
      own_key: { ...zeroPayer },
    },
  };
}

function ledgerOnlyMeasures(chargedMicros: number, listMicros: number): InsightsUsageMeasures {
  return {
    ...emptyMeasures(),
    chargedMicros,
    listMicros,
    byPayer: {
      opengeni_credits: { ...zeroPayer, chargedMicros },
      subscription: { ...zeroPayer },
      own_key: { ...zeroPayer, listMicros },
    },
  };
}

function response(): InsightsUsageResponse {
  return {
    scope: { kind: "workspace", accountId: id, workspaceId: secondId },
    range: "week",
    windowStart: "2026-09-28T00:00:00Z",
    windowEnd: "2026-10-03T10:00:00Z",
    priorWindowStart: "2026-09-21T00:00:00Z",
    priorWindowEnd: "2026-09-26T10:00:00Z",
    bucket: "day",
    generatedAt: "2026-10-03T10:00:00Z",
    dataThrough: null,
    totals: measures(),
    prior: null,
    groupBy: "model",
    groups: [{ key: "anthropic/claude", kind: "item", label: "claude", measures: measures() }],
    groupCount: 1,
    groupsTruncated: false,
    series: [{ start: "2026-10-03T00:00:00Z", measures: measures() }],
    facets: {
      workspaces: [],
      providers: [],
      models: [],
      payers: [],
      plans: [],
      sources: [],
      projects: [],
      people: [],
      schedules: [],
    },
  };
}

function call(): InsightsCall {
  return {
    id,
    occurredAt: "2026-10-03T10:00:00Z",
    workspaceId: secondId,
    sessionId: null,
    sessionTitle: null,
    sessionKind: "private",
    personKey: "opaque:member:key",
    provider: "openrouter",
    model: "vendor/model/name",
    payer: "own_key",
    tokens: null,
    chargedMicros: 0,
    listMicros: null,
    listByClassMicros: null,
  };
}

describe("Insights query contracts", () => {
  test("defaults and all presets, with workspace grouping/filtering in both scopes", () => {
    expect(WorkspaceInsightsUsageQuery.parse({})).toEqual({
      range: "week",
      groupBy: "model",
      limit: 50,
    });
    for (const range of ["today", "week", "month", "30d", "90d", "ytd"] as const) {
      expect(WorkspaceInsightsUsageQuery.parse({ range }).range).toBe(range);
    }
    expect(
      OrganizationInsightsUsageQuery.parse({ groupBy: "workspace", workspaceId: id }).workspaceId,
    ).toEqual([id]);
    expect(
      WorkspaceInsightsUsageQuery.parse({ groupBy: "workspace", workspaceId: id }),
    ).toMatchObject({ groupBy: "workspace", workspaceId: [id] });
  });

  test("normalizes single/repeated filters while preserving model slashes", () => {
    const query = OrganizationInsightsUsageQuery.parse({
      workspaceId: [id, secondId],
      provider: ["openrouter", "anthropic"],
      model: ["openrouter/vendor/model/name", "anthropic/claude"],
      payer: ["opengeni_credits", "subscription", "own_key"],
      plan: ["recorded-plan-key", "unknown"],
      source: ["web", "api", "slack", "schedule", "agent", "other"],
      projectId: [id, "unfiled"],
      person: "opaque:member:key",
      rootSessionId: [id, secondId],
      scheduleId: id,
      seriesGroups: "false",
      limit: "200",
    });
    expect(query.workspaceId).toEqual([id, secondId]);
    expect(query.model).toEqual(["openrouter/vendor/model/name", "anthropic/claude"]);
    expect(query.person).toEqual(["opaque:member:key"]);
    expect(query.scheduleId).toEqual([id]);
    expect(query.seriesGroups).toBe(false);
    expect(query.limit).toBe(200);
  });

  test("flattens comma-separated, repeated and mixed values for every filter", () => {
    const values = {
      workspaceId: [id, secondId],
      provider: ["openrouter", "anthropic"],
      model: ["openrouter/vendor/model/name", "anthropic/claude"],
      payer: ["opengeni_credits", "subscription", "own_key"],
      projectId: [id, "unfiled"],
      person: ["opaque:one", "opaque:two"],
      sessionId: [id, secondId],
      rootSessionId: [id, secondId],
      scheduleId: [id, secondId],
    };
    for (const [field, entries] of Object.entries(values)) {
      for (const value of [entries, entries.join(","), [entries.join(","), entries[0]!]]) {
        const expected =
          Array.isArray(value) && value[0]?.includes(",") ? [...entries, entries[0]!] : entries;
        expect(
          OrganizationInsightsUsageQuery.parse({ [field]: value, seriesGroups: "false" }),
        ).toMatchObject({ [field]: expected, seriesGroups: false });
        expect(OrganizationInsightsCallsQuery.parse({ [field]: value })).toMatchObject({
          [field]: expected,
        });
      }
    }
  });

  test("empty filters and comma segments never become an unfiltered request", () => {
    for (const field of [
      "workspaceId",
      "provider",
      "model",
      "payer",
      "plan",
      "source",
      "projectId",
      "person",
      "sessionId",
      "rootSessionId",
      "scheduleId",
    ]) {
      for (const value of [
        "",
        " ",
        ",",
        ",,",
        [""],
        [],
        ["valid", ""],
        "valid,",
        ",valid",
        "valid,,other",
        "valid, ,other",
      ]) {
        expect(OrganizationInsightsUsageQuery.safeParse({ [field]: value }).success).toBe(false);
        expect(OrganizationInsightsCallsQuery.safeParse({ [field]: value }).success).toBe(false);
      }
    }
  });

  test("strict boolean parsing never coerces false to true", () => {
    for (const value of [false, "false"]) {
      expect(WorkspaceInsightsUsageQuery.parse({ seriesGroups: value }).seriesGroups).toBe(false);
    }
    for (const value of [true, "true"]) {
      expect(WorkspaceInsightsUsageQuery.parse({ seriesGroups: value }).seriesGroups).toBe(true);
    }
    for (const value of ["0", "1", "", "FALSE", 0, 1, null, ["false", "true"]]) {
      expect(WorkspaceInsightsUsageQuery.safeParse({ seriesGroups: value }).success).toBe(false);
    }
  });

  test("rejects unsafe, fractional, out-of-bound and coerced numeric query values", () => {
    for (const limit of [
      0,
      -1,
      201,
      1.2,
      Infinity,
      NaN,
      2 ** 53,
      "",
      " ",
      "1.5",
      "1e2",
      "0x32",
      "201",
      true,
      null,
      ["50", "100"],
    ]) {
      expect(WorkspaceInsightsUsageQuery.safeParse({ limit }).success).toBe(false);
    }
    expect(WorkspaceInsightsUsageQuery.parse({ limit: "50" }).limit).toBe(50);
    expect(WorkspaceInsightsCallsQuery.parse({ limit: "100" }).limit).toBe(100);
    expect(WorkspaceInsightsCallsQuery.safeParse({ limit: 101 }).success).toBe(false);
  });

  test("calls accept identical filters and opaque cursor but not usage-only options", () => {
    expect(
      OrganizationInsightsCallsQuery.parse({
        workspaceId: id,
        model: "openrouter/vendor/model",
        cursor: "a+/=?",
      }),
    ).toMatchObject({
      workspaceId: [id],
      model: ["openrouter/vendor/model"],
      cursor: "a+/=?",
      limit: 50,
    });
    for (const options of [{ groupBy: "model" }, { seriesGroups: true }, { cursor: "" }]) {
      expect(WorkspaceInsightsCallsQuery.safeParse(options).success).toBe(false);
    }
  });

  test("rejects invalid IDs, model pairs, payer values, empty lists and unknown fields", () => {
    for (const query of [
      { projectId: "not-a-uuid" },
      { rootSessionId: "not-a-uuid" },
      { sessionId: "not-a-uuid" },
      { scheduleId: "not-a-uuid" },
      { workspaceId: "not-a-uuid" },
      { provider: [] },
      { provider: "" },
      { model: "model-only" },
      { model: "/model" },
      { model: "provider/" },
      { model: "provider/model name" },
      { payer: "external" },
      { source: "unknown" },
      { source: "sdk" },
      { range: "year" },
      { person: "" },
      { bucket: "hour" },
    ]) {
      expect(OrganizationInsightsUsageQuery.safeParse(query).success).toBe(false);
    }
  });

  test("every requested dimension is accepted in both usage scopes and filters in both calls scopes", () => {
    for (const groupBy of [
      "person",
      "workspace",
      "model",
      "provider",
      "payer",
      "plan",
      "project",
      "session",
      "rootSession",
      "schedule",
      "source",
    ] as const) {
      for (const schema of [WorkspaceInsightsUsageQuery, OrganizationInsightsUsageQuery]) {
        expect(schema.parse({ groupBy }).groupBy).toBe(groupBy);
      }
    }
    for (const schema of [
      WorkspaceInsightsUsageQuery,
      OrganizationInsightsUsageQuery,
      WorkspaceInsightsCallsQuery,
      OrganizationInsightsCallsQuery,
    ]) {
      expect(
        schema.parse({
          workspaceId: id,
          sessionId: id,
          rootSessionId: secondId,
          person: "member:opaque",
          source: ["web,api", "other"],
          plan: "recorded,unknown",
        }),
      ).toMatchObject({
        workspaceId: [id],
        sessionId: [id],
        rootSessionId: [secondId],
        person: ["member:opaque"],
        source: ["web", "api", "other"],
        plan: ["recorded", "unknown"],
      });
    }
    expect(InsightsUsageSource.options).toEqual([
      "web",
      "api",
      "slack",
      "schedule",
      "agent",
      "other",
    ]);
  });

  test("custom inclusive UTC dates resolve exclusive end and immediate equal-length prior", () => {
    const dates = { from: "2026-10-01", to: "2026-10-02" };
    for (const schema of [
      WorkspaceInsightsUsageQuery,
      OrganizationInsightsUsageQuery,
      WorkspaceInsightsCallsQuery,
      OrganizationInsightsCallsQuery,
    ]) {
      expect(schema.parse({ range: "custom", ...dates })).toMatchObject({
        range: "custom",
        ...dates,
      });
    }
    expect(resolveInsightsUsageCustomWindow(dates)).toEqual({
      windowStart: "2026-10-01T00:00:00.000Z",
      windowEnd: "2026-10-03T00:00:00.000Z",
      priorWindowStart: "2026-09-29T00:00:00.000Z",
      priorWindowEnd: "2026-10-01T00:00:00.000Z",
      bucket: "hour",
    });
    for (const [from, to, days, bucket] of [
      ["2026-10-01", "2026-10-01", 1, "hour"],
      ["2026-10-01", "2026-10-03", 3, "day"],
      ["2024-02-28", "2024-02-29", 2, "hour"],
      ["2026-03-07", "2026-03-09", 3, "day"],
      ["2026-12-31", "2027-01-01", 2, "hour"],
      ["0099-12-31", "0100-01-01", 2, "hour"],
    ] as const) {
      const window = resolveInsightsUsageCustomWindow({ from, to });
      expect(Date.parse(window.windowEnd) - Date.parse(window.windowStart)).toBe(days * 86_400_000);
      expect(Date.parse(window.priorWindowEnd) - Date.parse(window.priorWindowStart)).toBe(
        days * 86_400_000,
      );
      expect(window.priorWindowEnd).toBe(window.windowStart);
      expect(window.bucket).toBe(bucket);
    }
  });

  test("custom dates and resolved priors require representable AD years, including lower/upper edges", () => {
    for (const dates of [
      { from: "0000-01-02", to: "0000-01-02" },
      { from: "0000-12-31", to: "0001-01-01" },
      { from: "0001-01-01", to: "0001-01-01" },
      { from: "0001-01-02", to: "0001-01-03" },
      { from: "-0001-01-02", to: "-0001-01-02" },
      { from: "9999-12-31", to: "9999-12-31" },
    ]) {
      for (const schema of [
        WorkspaceInsightsUsageQuery,
        OrganizationInsightsUsageQuery,
        WorkspaceInsightsCallsQuery,
        OrganizationInsightsCallsQuery,
      ]) {
        expect(schema.safeParse({ range: "custom", ...dates }).success).toBe(false);
      }
      expect(() => resolveInsightsUsageCustomWindow(dates)).toThrow();
    }
    for (const dates of [
      { from: "0001-01-02", to: "0001-01-02" },
      { from: "0001-01-03", to: "0001-01-04" },
      { from: "9999-12-30", to: "9999-12-30" },
    ]) {
      const window = resolveInsightsUsageCustomWindow(dates);
      for (const schema of [
        WorkspaceInsightsUsageQuery,
        OrganizationInsightsUsageQuery,
        WorkspaceInsightsCallsQuery,
        OrganizationInsightsCallsQuery,
      ]) {
        expect(schema.safeParse({ range: "custom", ...dates }).success).toBe(true);
      }
      expect(
        InsightsUsageResponse.safeParse({ ...response(), range: "custom", ...window }).success,
      ).toBe(true);
      expect(
        Object.values(window)
          .filter((value) => value !== "hour" && value !== "day")
          .every((value) => !value.startsWith("0000-")),
      ).toBe(true);
    }
    expect(
      resolveInsightsUsageCustomWindow({ from: "0001-01-02", to: "0001-01-02" }).priorWindowStart,
    ).toBe("0001-01-01T00:00:00.000Z");
    const yearZeroPrior = {
      ...response(),
      range: "custom",
      bucket: "hour",
      windowStart: "0001-01-01T00:00:00Z",
      windowEnd: "0001-01-02T00:00:00Z",
      priorWindowStart: "0000-12-31T00:00:00Z",
      priorWindowEnd: "0001-01-01T00:00:00Z",
    };
    expect(InsightsUsageResponse.safeParse(yearZeroPrior).success).toBe(false);
  });

  test("custom dates accept exactly 370 days and reject 371 in both query scopes and responses", () => {
    const dates = { from: "2026-01-01", to: "2027-01-05" };
    const window = resolveInsightsUsageCustomWindow(dates);
    expect(Date.parse(window.windowEnd) - Date.parse(window.windowStart)).toBe(370 * 86_400_000);
    expect(window.bucket).toBe("day");
    for (const schema of [
      WorkspaceInsightsUsageQuery,
      OrganizationInsightsUsageQuery,
      WorkspaceInsightsCallsQuery,
      OrganizationInsightsCallsQuery,
    ]) {
      expect(schema.safeParse({ range: "custom", ...dates }).success).toBe(true);
      expect(schema.safeParse({ range: "custom", ...dates, to: "2027-01-06" }).success).toBe(false);
    }
    expect(() => resolveInsightsUsageCustomWindow({ ...dates, to: "2027-01-06" })).toThrow();
    expect(
      InsightsUsageResponse.safeParse({ ...response(), range: "custom", ...window }).success,
    ).toBe(true);
    const duration = 371 * 86_400_000;
    expect(
      InsightsUsageResponse.safeParse({
        ...response(),
        range: "custom",
        ...window,
        windowEnd: new Date(Date.parse(window.windowStart) + duration).toISOString(),
        priorWindowStart: new Date(Date.parse(window.windowStart) - duration).toISOString(),
      }).success,
    ).toBe(false);
  });

  test("custom dates reject incomplete, reversed, unreal, instant, array and unrepresentable windows", () => {
    for (const query of [
      { range: "custom" },
      { range: "custom", from: "2026-10-01" },
      { range: "custom", to: "2026-10-01" },
      { range: "custom", from: "2026-10-02", to: "2026-10-01" },
      { range: "custom", from: "2026-02-29", to: "2026-03-01" },
      { range: "custom", from: "2026-02-30", to: "2026-03-01" },
      { range: "custom", from: "2026-13-01", to: "2026-13-01" },
      { range: "custom", from: "2026-10-01T00:00:00Z", to: "2026-10-01" },
      { range: "custom", from: ["2026-10-01"], to: "2026-10-01" },
      { range: "custom", from: "0000-01-01", to: "0000-01-01" },
      { range: "custom", from: "9999-12-31", to: "9999-12-31" },
      { range: "today", from: "2026-10-01", to: "2026-10-01" },
      { from: "2026-10-01", to: "2026-10-01" },
    ]) {
      for (const schema of [
        WorkspaceInsightsUsageQuery,
        OrganizationInsightsUsageQuery,
        WorkspaceInsightsCallsQuery,
        OrganizationInsightsCallsQuery,
      ]) {
        expect(schema.safeParse(query).success).toBe(false);
      }
    }
  });
});

describe("Insights response contracts", () => {
  test("preserves missing historical knownness and all three explicit payer properties", () => {
    const value = InsightsUsageResponse.parse(response());
    expect(value.totals.cacheKnownCalls).toBe(0);
    expect(value.totals.cacheWriteKnownCalls).toBe(0);
    expect(Object.keys(value.totals.byPayer)).toEqual([
      "opengeni_credits",
      "subscription",
      "own_key",
    ]);
    const missingClasses = { ...measures(), listByClassMicros: null, listClassKnownCalls: 0 };
    expect(InsightsUsageMeasures.parse(missingClasses).listByClassMicros).toBeNull();
    const { own_key: _omitted, ...incomplete } = measures().byPayer;
    expect(InsightsUsageMeasures.safeParse({ ...measures(), byPayer: incomplete }).success).toBe(
      false,
    );
  });

  test("every token and numeric measure must be a nonnegative safe integer, never truncated", () => {
    for (const value of [-1, 0.5, 2 ** 53, Infinity, NaN, "1"]) {
      for (const field of Object.keys(zeroTokens)) {
        expect(InsightsUsageTokens.safeParse({ ...zeroTokens, [field]: value }).success).toBe(
          false,
        );
      }
      for (const field of [
        "calls",
        "tokenKnownCalls",
        "cacheKnownCalls",
        "cacheWriteKnownCalls",
        "listClassKnownCalls",
        "chargedMicros",
        "listMicros",
        "pricedCalls",
      ]) {
        expect(InsightsUsageMeasures.safeParse({ ...measures(), [field]: value }).success).toBe(
          false,
        );
      }
      expect(InsightsUsageResponse.safeParse({ ...response(), groupCount: value }).success).toBe(
        false,
      );
      expect(InsightsCall.safeParse({ ...call(), chargedMicros: value }).success).toBe(false);
    }
    expect(
      InsightsUsageTokens.parse({ ...zeroTokens, output: Number.MAX_SAFE_INTEGER }).output,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("validates exact list totals, complete priced coverage, and payer totals without unsafe summation", () => {
    expect(
      InsightsUsageMeasures.safeParse({
        ...measures(),
        listByClassMicros: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      }).success,
    ).toBe(false);
    expect(InsightsUsageMeasures.safeParse({ ...measures(), listClassKnownCalls: 2 }).success).toBe(
      false,
    );
    expect(InsightsUsageMeasures.safeParse({ ...measures(), tokenKnownCalls: 3 }).success).toBe(
      false,
    );
    expect(
      InsightsUsageMeasures.safeParse({
        ...measures(),
        byPayer: { ...measures().byPayer, own_key: { calls: 0, chargedMicros: 1, listMicros: 0 } },
      }).success,
    ).toBe(false);
    expect(
      InsightsUsageMeasures.safeParse({
        ...measures(),
        listByClassApprox: true,
        listByClassMicros: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      }).success,
    ).toBe(false);
    expect(
      InsightsUsageMeasures.safeParse({
        ...measures(),
        listByClassMicros: {
          uncachedInput: Number.MAX_SAFE_INTEGER,
          cacheRead: 1,
          cacheWrite: 0,
          output: 0,
        },
      }).success,
    ).toBe(false);
  });

  test("historical allocations preserve recorded totals and coverage without being repriced", () => {
    const allocated = InsightsUsageMeasures.parse({ ...measures(), listByClassApprox: true });
    expect(allocated.listByClassApprox).toBe(true);
    expect(allocated.listMicros).toBe(10);
    expect(allocated.listClassKnownCalls).toBe(1);
    expect(allocated.listByClassMicros).toEqual(measures().listByClassMicros);
    // Coverage can be partial when priced calls lack recorded quantities/rates.
    expect(
      InsightsUsageMeasures.safeParse({
        ...measures(),
        pricedCalls: 2,
        listClassKnownCalls: 1,
        listByClassApprox: true,
        listByClassMicros: { uncachedInput: 2, cacheRead: 1, cacheWrite: 0, output: 3 },
      }).success,
    ).toBe(true);
    expect(
      InsightsUsageMeasures.safeParse({
        ...measures(),
        pricedCalls: 2,
        listClassKnownCalls: 1,
        listByClassApprox: true,
        listByClassMicros: { uncachedInput: 20, cacheRead: 0, cacheWrite: 0, output: 0 },
      }).success,
    ).toBe(false);
    const unknown = InsightsUsageMeasures.parse({
      ...measures(),
      listClassKnownCalls: 0,
      listByClassMicros: null,
    });
    expect(unknown.listByClassMicros).toBeNull();
    expect(unknown.listMicros).toBe(10);
    // New write-time snapshots remain exact; the charged ledger is independent.
    const exact = InsightsUsageMeasures.parse(measures());
    expect(exact.listByClassApprox).toBe(false);
    expect(exact.chargedMicros).toBe(5);
    expect(exact.listMicros).toBe(10);
  });

  test("validates UTC/calendar dates, chronological windows, automatic bucket and prior coverage", () => {
    for (const generatedAt of [
      "not-a-date",
      "2026-02-30T00:00:00Z",
      "2026-10-03T10:00:00+02:00",
      "2026-10-03",
    ]) {
      expect(InsightsUsageResponse.safeParse({ ...response(), generatedAt }).success).toBe(false);
    }
    expect(
      InsightsUsageResponse.safeParse({ ...response(), windowEnd: response().windowStart }).success,
    ).toBe(false);
    expect(
      InsightsUsageResponse.safeParse({
        ...response(),
        windowEnd: response().priorWindowStart,
      }).success,
    ).toBe(false);
    expect(
      InsightsUsageResponse.safeParse({
        ...response(),
        priorWindowStart: response().priorWindowEnd,
        priorWindowEnd: response().priorWindowStart,
      }).success,
    ).toBe(false);
    expect(
      InsightsUsageResponse.safeParse({ ...response(), range: "today", bucket: "day" }).success,
    ).toBe(false);
    expect(
      InsightsUsageResponse.safeParse({ ...response(), range: "today", bucket: "hour" }).success,
    ).toBe(true);
    expect(
      InsightsUsageResponse.safeParse({ ...response(), prior: { ...measures(), calls: 0 } })
        .success,
    ).toBe(false);
    expect(InsightsUsageResponse.safeParse({ ...response(), groupBy: "workspace" }).success).toBe(
      true,
    );
    expect(
      InsightsUsageResponse.safeParse({
        ...response(),
        scope: { kind: "organization", accountId: id, workspaceId: null },
        groupBy: "workspace",
      }).success,
    ).toBe(true);
  });

  test("preserves ledger-only prior money without inventing calls or known coverage", () => {
    for (const [chargedMicros, listMicros] of [
      [7, 0],
      [0, 11],
      [7, 11],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const prior = ledgerOnlyMeasures(chargedMicros, listMicros);
      expect(InsightsUsageMeasures.parse(prior)).toEqual(prior);
      const parsed = InsightsUsageResponse.parse({ ...response(), prior });
      expect(parsed.prior).toEqual(prior);
      expect(parsed.prior).toMatchObject({
        calls: 0,
        tokenKnownCalls: 0,
        cacheKnownCalls: 0,
        cacheWriteKnownCalls: 0,
        listClassKnownCalls: 0,
        pricedCalls: 0,
        tokens: zeroTokens,
        chargedMicros,
        listMicros,
        listByClassMicros: null,
        listByClassApprox: false,
      });
    }
  });

  test("custom response preserves money and enforces complete UTC days, prior adjacency and bucket", () => {
    const custom = {
      ...response(),
      range: "custom" as const,
      ...resolveInsightsUsageCustomWindow({ from: "2026-10-01", to: "2026-10-02" }),
      prior: ledgerOnlyMeasures(7, 0),
    };
    expect(InsightsUsageResponse.parse(custom)).toEqual(custom);
    for (const fields of [
      { windowEnd: custom.windowStart },
      { windowStart: "2026-10-01T01:00:00Z" },
      { windowEnd: "2026-10-03T01:00:00Z" },
      { priorWindowEnd: "2026-09-30T00:00:00Z" },
      { priorWindowStart: "2026-09-28T00:00:00Z" },
      { bucket: "day" },
    ])
      expect(InsightsUsageResponse.safeParse({ ...custom, ...fields }).success).toBe(false);
    const longer = {
      ...custom,
      ...resolveInsightsUsageCustomWindow({ from: "2026-10-01", to: "2026-10-03" }),
    };
    expect(InsightsUsageResponse.parse(longer).bucket).toBe("day");
    expect(InsightsUsageResponse.safeParse({ ...longer, bucket: "hour" }).success).toBe(false);
  });

  test("source other category and folded remainder do not collide, and facets remain backward compatible", () => {
    const { calls, tokens, chargedMicros, listMicros, byPayer } = measures();
    const mini = { calls, tokens, chargedMicros, listMicros, byPayer };
    const groups = InsightsUsageSource.options.map((key) => ({
      key,
      kind: "item" as const,
      label: key,
      measures: measures(),
    }));
    const source = {
      ...response(),
      groupBy: "source" as const,
      groups: [
        ...groups,
        {
          key: "other:folded",
          kind: "other" as const,
          label: "Other groups",
          measures: measures(),
        },
      ],
      groupCount: 7,
      series: [
        {
          start: response().windowStart,
          measures: measures(),
          groups: Object.fromEntries(
            [...InsightsUsageSource.options, "other:folded"].map((key) => [key, mini]),
          ),
        },
      ],
      facets: { ...response().facets, sources: ["web", "api", "other"] },
    };
    expect(InsightsUsageResponse.parse(source).series[0]?.groups?.other).toEqual(mini);
    expect(InsightsUsageResponse.parse(source).series[0]?.groups?.["other:folded"]).toEqual(mini);
    expect(
      InsightsUsageResponse.safeParse({ ...source, groups: [{ ...groups[0]!, key: "item:web" }] })
        .success,
    ).toBe(false);
    expect(
      InsightsUsageResponse.safeParse({
        ...source,
        groups: [{ key: "other", kind: "other", label: "folded", measures: measures() }],
      }).success,
    ).toBe(false);
    expect(
      InsightsUsageResponse.safeParse({
        ...source,
        series: [{ ...source.series[0]!, groups: { ...source.series[0]!.groups, seventh: mini } }],
      }).success,
    ).toBe(false);
    const { sources: _sources, plans: _plans, ...legacy } = response().facets;
    expect(InsightsUsageResponse.parse({ ...response(), facets: legacy }).facets).toMatchObject({
      sources: [],
      plans: [],
    });
    expect(
      InsightsUsageResponse.safeParse({
        ...source,
        facets: { ...source.facets, sources: ["unknown"] },
      }).success,
    ).toBe(false);
  });

  test("private project/root groups carry only the authorized owner facet key, not hidden metadata", () => {
    const personKey = "member:opaque";
    const privateGroup = {
      key: "private:opaque",
      kind: "private" as const,
      label: "Member",
      personKey,
      measures: ledgerOnlyMeasures(7, 0),
    };
    for (const groupBy of ["project", "rootSession"] as const) {
      expect(
        InsightsUsageResponse.parse({
          ...response(),
          groupBy,
          groups: [privateGroup],
          facets: { ...response().facets, people: [{ key: personKey, name: null, you: false }] },
        }).groups[0]?.personKey,
      ).toBe(personKey);
      expect(
        InsightsUsageResponse.safeParse({ ...response(), groupBy, groups: [privateGroup] }).success,
      ).toBe(false);
      for (const field of [
        "sessionId",
        "sessionTitle",
        "projectId",
        "rootSessionId",
        "scheduleId",
        "initiatingHumanSubjectId",
      ]) {
        expect(
          InsightsUsageResponse.safeParse({
            ...response(),
            groupBy,
            groups: [{ ...privateGroup, [field]: id }],
          }).success,
        ).toBe(false);
      }
    }
  });

  test("truly empty priors stay null and zero-length priors still reject ledger money", () => {
    const normalPrior = measures();
    expect(InsightsUsageResponse.parse({ ...response(), prior: normalPrior }).prior).toEqual(
      normalPrior,
    );
    expect(InsightsUsageResponse.parse({ ...response(), prior: null }).prior).toBeNull();
    expect(InsightsUsageResponse.safeParse({ ...response(), prior: emptyMeasures() }).success).toBe(
      false,
    );
    for (const prior of [ledgerOnlyMeasures(7, 0), ledgerOnlyMeasures(0, 11)]) {
      expect(
        InsightsUsageResponse.safeParse({
          ...response(),
          priorWindowEnd: response().priorWindowStart,
          prior,
        }).success,
      ).toBe(false);
    }
  });

  test("ledger-only priors cannot bypass safe amounts, payer totals or zero-call coverage", () => {
    const prior = ledgerOnlyMeasures(7, 11);
    for (const field of [
      "tokenKnownCalls",
      "cacheKnownCalls",
      "cacheWriteKnownCalls",
      "listClassKnownCalls",
      "pricedCalls",
    ]) {
      expect(
        InsightsUsageResponse.safeParse({ ...response(), prior: { ...prior, [field]: 1 } }).success,
      ).toBe(false);
    }
    for (const amount of [-1, 0.5, 2 ** 53, Infinity, NaN]) {
      for (const field of ["chargedMicros", "listMicros"]) {
        expect(
          InsightsUsageResponse.safeParse({
            ...response(),
            prior: { ...prior, [field]: amount },
          }).success,
        ).toBe(false);
      }
    }
    expect(
      InsightsUsageResponse.safeParse({
        ...response(),
        prior: {
          ...prior,
          byPayer: {
            ...prior.byPayer,
            opengeni_credits: { ...zeroPayer, chargedMicros: 6 },
          },
        },
      }).success,
    ).toBe(false);
  });

  for (const [range, boundary, priorBoundary] of [
    ["today", "2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z"],
    ["week", "2026-10-05T00:00:00Z", "2026-09-28T00:00:00Z"],
    ["month", "2026-10-01T00:00:00Z", "2026-09-01T00:00:00Z"],
    ["ytd", "2026-01-01T00:00:00Z", "2025-01-01T00:00:00Z"],
  ] as const) {
    test(`accepts canonical empty ${range} windows at their exact UTC boundary`, () => {
      const empty: InsightsUsageResponse = {
        ...response(),
        range,
        bucket: range === "today" ? "hour" : "day",
        windowStart: boundary,
        windowEnd: boundary,
        priorWindowStart: priorBoundary,
        priorWindowEnd: priorBoundary,
        generatedAt: boundary,
        totals: emptyMeasures(),
        prior: null,
        groups: [],
        groupCount: 0,
        groupsTruncated: false,
        series: [],
      };
      expect(InsightsUsageResponse.parse(empty)).toEqual(empty);
    });
  }

  test("zero-length current windows reject calls, costs, tokens, groups and series", () => {
    const empty: InsightsUsageResponse = {
      ...response(),
      windowEnd: response().windowStart,
      totals: emptyMeasures(),
      groups: [],
      groupCount: 0,
      groupsTruncated: false,
      series: [],
    };
    expect(InsightsUsageResponse.safeParse(empty).success).toBe(true);
    for (const totals of [
      measures(),
      {
        ...emptyMeasures(),
        chargedMicros: 1,
        byPayer: {
          ...emptyMeasures().byPayer,
          opengeni_credits: { ...zeroPayer, chargedMicros: 1 },
        },
      },
      {
        ...emptyMeasures(),
        listMicros: 1,
        byPayer: {
          ...emptyMeasures().byPayer,
          own_key: { ...zeroPayer, listMicros: 1 },
        },
      },
      ...Object.keys(zeroTokens).map((field) => ({
        ...emptyMeasures(),
        tokens: { ...zeroTokens, [field]: 1 },
      })),
    ]) {
      expect(InsightsUsageMeasures.safeParse(totals).success).toBe(true);
      expect(InsightsUsageResponse.safeParse({ ...empty, totals }).success).toBe(false);
    }
    for (const fields of [
      { groups: [{ ...response().groups[0]!, measures: emptyMeasures() }] },
      { groupCount: 1 },
      { groupsTruncated: true },
      { series: [{ start: empty.windowStart, measures: emptyMeasures() }] },
    ]) {
      expect(InsightsUsageResponse.safeParse({ ...empty, ...fields }).success).toBe(false);
    }
  });

  test("zero-length prior windows accept only null prior measures", () => {
    const emptyPrior = { ...response(), priorWindowEnd: response().priorWindowStart };
    expect(InsightsUsageResponse.safeParse(emptyPrior).success).toBe(true);
    expect(InsightsUsageResponse.safeParse({ ...emptyPrior, prior: measures() }).success).toBe(
      false,
    );
    expect(InsightsUsageResponse.safeParse({ ...emptyPrior, prior: emptyMeasures() }).success).toBe(
      false,
    );
  });

  test("limits per-bucket groups to top six plus other", () => {
    const group = {
      chargedMicros: 0,
      listMicros: 0,
      calls: 0,
      tokens: zeroTokens,
      byPayer: { opengeni_credits: zeroPayer, subscription: zeroPayer, own_key: zeroPayer },
    };
    const groups = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`g${index}`, group]),
    );
    const point = {
      start: "2026-10-03T00:00:00Z",
      measures: measures(),
      groups: { ...groups, other: group },
    };
    expect(InsightsUsageSeriesPoint.safeParse(point).success).toBe(true);
    expect(
      InsightsUsageSeriesPoint.safeParse({ ...point, groups: { ...point.groups, seventh: group } })
        .success,
    ).toBe(false);
  });

  test("mini-series group values require all payer buckets and coherent totals", () => {
    const { calls, tokens, chargedMicros, listMicros, byPayer } = measures();
    const group = { calls, tokens, chargedMicros, listMicros, byPayer };
    const point = { start: "2026-10-03T00:00:00Z", measures: measures(), groups: { model: group } };
    expect(InsightsUsageSeriesPoint.parse(point).groups?.model?.byPayer).toEqual(byPayer);
    const { byPayer: _omitted, ...missing } = group;
    expect(
      InsightsUsageSeriesPoint.safeParse({ ...point, groups: { model: missing } }).success,
    ).toBe(false);
    expect(
      InsightsUsageSeriesPoint.safeParse({
        ...point,
        groups: {
          model: {
            ...group,
            byPayer: { opengeni_credits: zeroPayer, subscription: zeroPayer, own_key: zeroPayer },
          },
        },
      }).success,
    ).toBe(false);
    const { own_key: _missingKey, ...twoPayers } = byPayer;
    expect(
      InsightsUsageSeriesPoint.safeParse({
        ...point,
        groups: { model: { ...group, byPayer: twoPayers } },
      }).success,
    ).toBe(false);
  });

  test("retains opaque per-person/private and per-membership/personal rows without session fields", () => {
    const groups = (
      ["private", "personal", "deleted", "restricted", "service", "unfiled", "other"] as const
    ).map((kind) => ({
      key: `opaque:${kind}`,
      kind,
      label: kind === "private" ? "Member name" : kind,
      you: false,
      measures: measures(),
    }));
    expect(
      InsightsUsageResponse.parse({ ...response(), groups, groupCount: groups.length }).groups.map(
        (group) => group.kind,
      ),
    ).toEqual(groups.map((group) => group.kind));
    expect(
      InsightsUsageResponse.safeParse({
        ...response(),
        groups: [{ ...groups[0], sessionTitle: "hidden title" }],
      }).success,
    ).toBe(false);
  });

  test("private calls never expose session IDs/titles; deleted stays distinct and missing prices stay null", () => {
    expect(InsightsCall.parse(call()).tokens).toBeNull();
    expect(InsightsCall.safeParse({ ...call(), sessionId: id }).success).toBe(false);
    expect(InsightsCall.safeParse({ ...call(), sessionTitle: "hidden" }).success).toBe(false);
    expect(InsightsCall.parse({ ...call(), sessionKind: "deleted" }).sessionKind).toBe("deleted");
    expect(
      InsightsCallsResponse.parse({ calls: [call()], nextCursor: null }).calls[0]?.listMicros,
    ).toBeNull();
    expect(
      InsightsCallsResponse.safeParse({
        calls: Array.from({ length: 101 }, call),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      InsightsCall.safeParse({
        ...call(),
        listMicros: 1,
        listByClassMicros: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      }).success,
    ).toBe(false);
  });

  test("dedicated subpath bundles without importing the root contracts graph", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.exports["./insights-usage"]).toEqual({
      types: "./src/insights-usage.ts",
      default: "./src/insights-usage.ts",
    });
    expect(await Bun.file(new URL("../tsup.config.ts", import.meta.url)).text()).toContain(
      '"src/insights-usage.ts"',
    );
    const result = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("@opengeni/contracts/insights-usage"))],
      target: "browser",
      minify: true,
    });
    expect(result.success).toBe(true);
    const bundle = await result.outputs[0]!.text();
    expect(bundle).not.toContain("AgentToolCapabilityCatalog");
    expect(bundle).not.toContain("WorkspaceInsightsSnapshot");
    const rootBuild = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("@opengeni/contracts"))],
      target: "browser",
      minify: true,
    });
    expect(rootBuild.success).toBe(true);
    // Zod itself is shared baseline cost; the new subpath must avoid the much
    // larger root contract graph, rather than asserting a library-size guess.
    expect(bundle.length).toBeLessThan((await rootBuild.outputs[0]!.text()).length / 2);
    const root = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(root).not.toContain('from "./insights-usage"');
  });
});
