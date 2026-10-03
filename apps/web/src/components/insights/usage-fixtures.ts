/**
 * Realistic Insights usage responses for tests (and the dev preview). Not
 * imported by production code.
 */
import {
  addMeasures,
  emptyMeasures,
  type UsageGroup,
  type UsageGroupBy,
  type UsageMeasures,
  type UsagePayerId,
  type UsageResponse,
  type UsageScope,
} from "./usage-contract";

type ModelSpec = {
  provider: string;
  model: string;
  payer: UsagePayerId;
  share: number;
  cacheRatio: number;
  writeRatio: number;
  price: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
};

export const FIXTURE_MODELS: readonly ModelSpec[] = [
  {
    provider: "codex-subscription",
    model: "codex/gpt-6.1-sol",
    payer: "subscription",
    share: 0.52,
    cacheRatio: 0.94,
    writeRatio: 0,
    price: { input: 2.5, cacheRead: 0.25, cacheWrite: 0, output: 15 },
  },
  {
    provider: "organization-claude-subscription",
    model: "organization-claude-subscription/claude-opus-5-5",
    payer: "subscription",
    share: 0.16,
    cacheRatio: 0.82,
    writeRatio: 0.12,
    price: { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 },
  },
  {
    provider: "opengeni-gateway",
    model: "anthropic/claude-sonnet-5-5",
    payer: "opengeni_credits",
    share: 0.17,
    cacheRatio: 0.7,
    writeRatio: 0.15,
    price: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5",
    payer: "own_key",
    share: 0.05,
    cacheRatio: 0.4,
    writeRatio: 0.3,
    price: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  },
  {
    provider: "supergrok-subscription",
    model: "grok-4.6",
    payer: "subscription",
    share: 0.1,
    cacheRatio: 0.6,
    writeRatio: 0,
    price: null,
  },
];

function callMeasures(spec: ModelSpec, calls: number, tokensPerCall = 90_000): UsageMeasures {
  const input = calls * tokensPerCall;
  const cacheRead = Math.round(input * spec.cacheRatio);
  const cacheWrite = Math.round(input * spec.writeRatio);
  const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
  const output = calls * 1_400;
  const byClass = spec.price
    ? {
        uncachedInput: Math.round(uncachedInput * spec.price.input),
        cacheRead: Math.round(cacheRead * spec.price.cacheRead),
        cacheWrite: Math.round(cacheWrite * spec.price.cacheWrite),
        output: Math.round(output * spec.price.output),
      }
    : null;
  const listMicros = byClass
    ? byClass.uncachedInput + byClass.cacheRead + byClass.cacheWrite + byClass.output
    : 0;
  const chargedMicros = spec.payer === "opengeni_credits" ? Math.round(listMicros * 1.05) : 0;
  return {
    calls,
    tokenKnownCalls: calls,
    cacheKnownCalls: calls,
    cacheWriteKnownCalls: calls,
    tokens: { uncachedInput, cacheRead, cacheWrite, output, reasoning: Math.round(output * 0.4) },
    chargedMicros,
    listMicros,
    listByClassMicros: byClass,
    listClassKnownCalls: byClass ? calls : 0,
    listByClassApprox: false,
    pricedCalls: spec.price ? calls : 0,
    byPayer: { [spec.payer]: { calls, chargedMicros, listMicros } },
  };
}

function sum(rows: UsageMeasures[]): UsageMeasures {
  return rows.reduce((total, row) => addMeasures(total, row), emptyMeasures());
}

const DAY = 86_400_000;

/** A month of usage at the given scope, grouped by `groupBy`. */
export function fixtureUsage(
  options: {
    scope?: UsageScope;
    groupBy?: UsageGroupBy;
    totalCalls?: number;
    days?: number;
    prior?: boolean;
  } = {},
): UsageResponse {
  const scope: UsageScope = options.scope ?? {
    kind: "workspace",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
  };
  const groupBy = options.groupBy ?? "model";
  const totalCalls = options.totalCalls ?? 4_000;
  const days = options.days ?? 30;
  const end = Date.UTC(2026, 9, 3);
  const perModel = FIXTURE_MODELS.map((spec) => ({
    spec,
    measures: callMeasures(spec, Math.round(totalCalls * spec.share)),
  }));
  const totals = sum(perModel.map((row) => row.measures));

  const groups: UsageGroup[] = (() => {
    switch (groupBy) {
      case "model":
        return perModel.map(({ spec, measures }) => ({
          key: `${spec.provider}/${spec.model}`,
          kind: "item" as const,
          label: spec.model,
          provider: spec.provider,
          model: spec.model,
          measures,
        }));
      case "rootSession":
        return [
          {
            key: "aaaaaaaa-0000-4000-8000-000000000001",
            kind: "item" as const,
            label: "Fix durable workflow wake reconciliation",
            measures: callMeasures(FIXTURE_MODELS[0]!, 900),
          },
          {
            key: "aaaaaaaa-0000-4000-8000-000000000002",
            kind: "item" as const,
            label: "Insights redesign",
            measures: callMeasures(FIXTURE_MODELS[1]!, 400),
          },
          {
            key: "private:owner-1",
            kind: "private" as const,
            label: "Ada Lovelace",
            measures: callMeasures(FIXTURE_MODELS[2]!, 300),
          },
          {
            key: "deleted",
            kind: "deleted" as const,
            label: "Deleted chats",
            measures: callMeasures(FIXTURE_MODELS[0]!, 88),
          },
          {
            key: "other",
            kind: "other" as const,
            label: "48 more sessions",
            measures: callMeasures(FIXTURE_MODELS[0]!, 2_312),
          },
        ];
      case "workspace":
        return [
          {
            key: "33333333-0000-4000-8000-000000000001",
            kind: "item" as const,
            label: "Platform engineering",
            workspaceId: "33333333-0000-4000-8000-000000000001",
            measures: callMeasures(FIXTURE_MODELS[0]!, 2_200),
          },
          {
            key: "33333333-0000-4000-8000-000000000002",
            kind: "item" as const,
            label: "Customer success",
            workspaceId: "33333333-0000-4000-8000-000000000002",
            measures: callMeasures(FIXTURE_MODELS[2]!, 900),
          },
          {
            key: "personal:m1",
            kind: "personal" as const,
            label: "Ada Lovelace",
            measures: callMeasures(FIXTURE_MODELS[1]!, 600),
          },
          {
            key: "personal:m2",
            kind: "personal" as const,
            label: "Grace Hopper",
            measures: callMeasures(FIXTURE_MODELS[3]!, 300),
          },
        ];
      case "payer":
        return (["subscription", "opengeni_credits", "own_key"] as const).map((payer) => ({
          key: payer,
          kind: "item" as const,
          label: payer,
          payer,
          measures: sum(
            perModel.filter((row) => row.spec.payer === payer).map((row) => row.measures),
          ),
        }));
      default:
        return perModel.map(({ spec, measures }) => ({
          key: spec.provider,
          kind: "item" as const,
          label: spec.provider,
          provider: spec.provider,
          measures,
        }));
    }
  })();

  const series = Array.from({ length: days }, (_, index) => {
    const start = new Date(end - (days - 1 - index) * DAY).toISOString();
    const weekday = new Date(start).getUTCDay();
    const weight = (weekday === 0 || weekday === 6 ? 0.3 : 1) * (0.6 + (0.4 * index) / days);
    const pointGroups: Record<string, UsageMeasures> = {};
    const parts = perModel.map(({ spec }) => {
      const calls = Math.max(0, Math.round(((totalCalls * spec.share) / days) * weight * 1.4));
      const measures = callMeasures(spec, calls);
      pointGroups[`${spec.provider}/${spec.model}`] = measures;
      return measures;
    });
    return {
      start,
      measures: sum(parts),
      ...(groupBy === "model" ? { groups: pointGroups } : {}),
    };
  });

  return {
    scope,
    range: "30d",
    windowStart: new Date(end - (days - 1) * DAY).toISOString(),
    windowEnd: new Date(end + DAY / 2).toISOString(),
    priorWindowStart: null,
    priorWindowEnd: null,
    bucket: "day",
    generatedAt: new Date(end + DAY / 2).toISOString(),
    dataThrough: new Date(end + DAY / 2 - 60_000).toISOString(),
    totals,
    prior:
      options.prior === false
        ? null
        : sum(
            perModel.map(({ spec }) =>
              callMeasures(spec, Math.round(totalCalls * spec.share * 0.8)),
            ),
          ),
    groupBy,
    groups,
    groupCount: groups.length,
    groupsTruncated: false,
    series,
    facets: {
      workspaces:
        scope.kind === "organization"
          ? [
              {
                id: "33333333-0000-4000-8000-000000000001",
                name: "Platform engineering",
                personal: false,
              },
              {
                id: "33333333-0000-4000-8000-000000000002",
                name: "Customer success",
                personal: false,
              },
            ]
          : [],
      providers: [...new Set(FIXTURE_MODELS.map((spec) => spec.provider))],
      models: FIXTURE_MODELS.map((spec) => ({ provider: spec.provider, model: spec.model })),
      payers: ["opengeni_credits", "subscription", "own_key"],
      projects: [{ id: "44444444-0000-4000-8000-000000000001", name: "Bugfixes" }],
      people: [
        { key: "person-1", name: "Bendik Hansen", you: true },
        { key: "person-2", name: "Ada Lovelace", you: false },
      ],
      schedules: [{ id: "55555555-0000-4000-8000-000000000001", name: "Nightly triage" }],
    },
    capabilities: {
      groupBy: [
        "model",
        "provider",
        "payer",
        "workspace",
        "project",
        "rootSession",
        "person",
        "schedule",
      ],
      filters: [
        "workspaceId",
        "provider",
        "model",
        "payer",
        "projectId",
        "person",
        "rootSessionId",
        "scheduleId",
      ],
      ranges: ["today", "week", "month", "30d", "90d", "ytd"],
      seriesGroups: true,
    },
  };
}
