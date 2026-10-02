// Deterministic data for the Insights preview: workspace Insights and the
// organization usage page with all three payers and other people's private
// chats. `?state=` picks data, truncated (private list capped), empty, error
// or loading.
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const accountId = "99999999-9999-4999-8999-999999999999";
const marketingId = "22222222-2222-4222-8222-222222222222";
const productId = "33333333-3333-4333-8333-333333333333";
const opsId = "44444444-4444-4444-8444-444444444444";

const state = new URLSearchParams(location.search).get("state") ?? "data";

const DAYS = ["Sep 24", "Sep 25", "Sep 26", "Sep 27", "Sep 28", "Sep 29", "Sep 30"];
const SHAPE = [0.6, 0.9, 0.75, 0.3, 0.2, 1, 0.85];

function series(scale: number) {
  return DAYS.map((label, index) => {
    const k = SHAPE[index]! * scale;
    const input = Math.round(1_400_000 * k);
    const cached = Math.round(input * 0.62);
    return {
      label,
      modelCostUsd: 8.6 * k,
      estimatedProviderUsd: 13.2 * k,
      estimatedProviderCostKnownCalls: Math.round(100 * k),
      equivalentCreditUsd: 9.1 * k,
      equivalentCreditCostKnownCalls: Math.round(100 * k),
      warmSeconds: 3600 * k,
      inputTokens: input,
      outputTokens: Math.round(input * 0.08),
      cachedTokens: cached,
      cacheInputTokens: input,
      cacheWriteTokens: Math.round(input * 0.05),
      reasoningTokens: 0,
      totalTokens: Math.round(input * 1.08),
      tokenKnownCalls: Math.round(100 * k),
      cacheKnownCalls: Math.round(100 * k),
      cacheHitPct: 62,
      calls: Math.round(100 * k),
    };
  });
}

function model(
  provider: string,
  name: string,
  billing: "opengeni_credits" | "external",
  calls: number,
  totalTokens: number,
  creditUsd: number,
  estimatedProviderUsd: number,
) {
  const inputTokens = Math.round(totalTokens * 0.92);
  return {
    id: `${provider}:${name}:${billing}`,
    model: name,
    provider,
    billing,
    calls,
    inputTokens,
    outputTokens: totalTokens - inputTokens,
    cachedTokens: Math.round(inputTokens * 0.6),
    cacheInputTokens: inputTokens,
    cacheWriteTokens: Math.round(inputTokens * 0.04),
    reasoningTokens: 0,
    totalTokens,
    tokenKnownCalls: calls,
    cacheKnownCalls: calls,
    creditUsd,
    estimatedProviderUsd,
    estimatedProviderCostKnownCalls: calls,
    equivalentCreditUsd: estimatedProviderUsd * 0.9,
    equivalentCreditCostKnownCalls: calls,
  };
}

function driver(id: string, label: string, creditUsd: number, tokens: number, pct: number) {
  return {
    id: `root:${id}`,
    groupBy: "root_session" as const,
    label,
    creditUsd,
    estimatedProviderUsd: creditUsd * 1.3,
    estimatedProviderCostKnownCalls: 40,
    equivalentCreditUsd: creditUsd,
    equivalentCreditCostKnownCalls: 40,
    tokens,
    cacheHitPct: 58,
    pctOfCreditUsd: pct,
    pctOfTokens: pct,
    deltaUsdVsPrior: 1.2,
  };
}

function project(
  id: string,
  kind: "project" | "unfiled" | "unavailable",
  label: string,
  creditUsd: number,
  tokens: number,
) {
  return {
    id,
    kind,
    label,
    projects: kind === "project" ? 1 : 0,
    rootSessions: kind === "unavailable" ? 0 : 4,
    calls: 80,
    creditUsd,
    estimatedProviderUsd: creditUsd * 1.4,
    estimatedProviderCostKnownCalls: 80,
    tokens,
    cacheHitPct: 61,
  };
}

function workspaceSnapshot(empty: boolean): WorkspaceInsightsSnapshot {
  const models = empty
    ? []
    : [
        model("openai", "gpt-5", "opengeni_credits", 412, 18_400_000, 48.2, 41.05),
        model("codex-subscription", "gpt-5-codex", "external", 186, 9_100_000, 0, 22.8),
        model("anthropic", "claude-sonnet-4.5", "external", 96, 3_900_000, 0, 14.1),
      ];
  const calls = models.reduce((sum, row) => sum + row.calls, 0);
  return {
    range: "week",
    rangeLabel: "Last 7 days (UTC)",
    priorLabel: "Prior 7 days",
    seriesLabel: "Token usage / UTC day",
    cacheSeriesLabel: "Cache hit % / UTC day",
    windowStart: "2026-09-24T00:00:00.000Z",
    windowEnd: "2026-10-01T00:00:00.000Z",
    generatedAt: "2026-10-01T00:00:00.000Z",
    timezone: "UTC",
    models,
    facets: models.map((row) => ({ provider: row.provider, model: row.model })),
    series: series(empty ? 0 : 1).map((point) =>
      empty ? { ...point, calls: 0, cacheHitPct: null } : point,
    ),
    depth: [],
    drivers: empty
      ? []
      : [
          driver(
            "aaaaaaaa-0000-4000-8000-000000000001",
            "Q4 launch plan and briefs",
            18.4,
            9_800_000,
            31,
          ),
          driver(
            "aaaaaaaa-0000-4000-8000-000000000002",
            "Refactor the billing ledger",
            12.9,
            7_200_000,
            23,
          ),
          driver(
            "aaaaaaaa-0000-4000-8000-000000000003",
            "Weekly competitor digest",
            6.1,
            3_400_000,
            11,
          ),
        ],
    projects: empty
      ? []
      : [
          project("p1", "project", "Launch", 24.6, 12_800_000),
          project("p2", "project", "Platform", 15.1, 8_100_000),
          project("unfiled", "unfiled", "No project", 6.2, 3_900_000),
          project("unavailable", "unavailable", "Private chats", 14.25, 4_600_000),
        ],
    schedules: [],
    recentCalls: [],
    promptContributions: {
      estimatedTokens: 0,
      utf8Bytes: 0,
      coveredCalls: 0,
      totalCalls: calls,
      sources: [],
    },
    warmSeconds: 0,
    priorWarmSeconds: 0,
    warmGroups: [],
    liveWarm: [],
    floor: [],
    selfhostedEnabled: false,
    machinesOnline: 0,
    workspaceCreditUsd: empty ? 0 : 48.2,
    priorWorkspaceCreditUsd: empty ? 0 : 39.6,
    creditUsd: empty ? 0 : 48.2,
    priorCreditUsd: empty ? 0 : 39.6,
    estimatedProviderUsd: empty ? 0 : 77.95,
    priorEstimatedProviderUsd: empty ? 0 : 61.2,
    estimatedProviderCostKnownCalls: calls,
    priorEstimatedProviderCostKnownCalls: empty ? 0 : 520,
    equivalentCreditUsd: empty ? 0 : 70.1,
    priorEquivalentCreditUsd: empty ? 0 : 55,
    equivalentCreditCostKnownCalls: calls,
    priorEquivalentCreditCostKnownCalls: empty ? 0 : 520,
    modelCalls: calls,
    priorInputTokens: empty ? 0 : 24_000_000,
    priorTotalTokens: empty ? 0 : 26_000_000,
    priorCacheHitPct: empty ? null : 55,
    priorCalls: empty ? 0 : 540,
    goalsActive: 0,
    goalsCompleted: 0,
    sessionsTouched: empty ? 0 : 23,
    rootSessions: empty ? 0 : 14,
    deepestDepth: 0,
    deepestSessionTitle: "",
    avgDepth: 0,
    warmIdleNow: 0,
    billableTokensUsed: 0,
    billableTokenCap: 10_000_000,
    agentRunsUsed: 0,
    agentRunCap: 100,
    modelFilterActive: false,
    dataThrough: "2026-09-30T23:59:00.000Z",
    cacheHitPct: empty ? null : 61,
    scope: { rootSessionId: null, sessionId: null },
    driverGroups: empty ? 0 : 3,
    driversTruncated: false,
    facetsTruncated: false,
    recentCallsTruncated: false,
    privateChats: empty
      ? []
      : [
          {
            ownerKey: "owner-ola",
            name: "Ola Nordmann",
            you: false,
            calls: 41,
            tokens: 2_900_000,
            creditUsd: 12.4,
            estimatedProviderUsd: 10.85,
            estimatedProviderCostKnownCalls: 41,
          },
          {
            ownerKey: "owner-kari",
            name: "Kari Hansen",
            you: false,
            calls: 18,
            tokens: 1_200_000,
            creditUsd: 0,
            estimatedProviderUsd: 3.1,
            estimatedProviderCostKnownCalls: 18,
          },
          {
            ownerKey: "owner-jonas",
            name: "Jonas Berg-Christiansen",
            you: false,
            calls: 7,
            tokens: 500_000,
            creditUsd: 1.85,
            estimatedProviderUsd: 1.6,
            estimatedProviderCostKnownCalls: 7,
          },
        ],
    privateChatsTruncated: state === "truncated",
  } as WorkspaceInsightsSnapshot;
}

const usd = (dollars: number) => String(Math.round(dollars * 1_000_000));
const cost = (dollars: number, runs = 0) => [
  { eventType: "model.cost", unit: "usd_micros", quantity: usd(dollars), eventCount: "10" },
  ...(runs > 0
    ? [{ eventType: "agent.run", unit: "count", quantity: String(runs), eventCount: String(runs) }]
    : []),
];

function organizationSummary(empty: boolean) {
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const k = empty ? 0 : 0.5 + 0.5 * Math.sin(index / 3) ** 2;
    return { bucket: `2026-09-${day}`, totals: cost(4.2 * k, Math.round(30 * k)) };
  });
  return {
    accountId,
    period: "month",
    since: "2026-09-01T00:00:00.000Z",
    until: "2026-10-01T00:00:00.000Z",
    granularity: "day",
    totals: empty ? [] : cost(98.45, 612),
    buckets: empty ? [] : days,
    workspaces: empty
      ? []
      : [
          { workspaceId: marketingId, name: "Marketing", totals: cost(46.1, 280) },
          { workspaceId: productId, name: "Product", totals: cost(31.75, 190) },
          {
            workspaceId: opsId,
            name: "Customer Success Operations (EMEA)",
            totals: cost(12.3, 92),
          },
        ],
    nextWorkspaceCursor: null,
    personalWorkspaces: empty
      ? []
      : [{ membershipId: "55555555-5555-4555-8555-555555555555", totals: cost(8.3, 50) }],
    personalWorkspaceCount: empty ? 0 : 1,
    privateChats: empty
      ? []
      : [
          {
            workspaceId: marketingId,
            membershipId: null,
            name: "Ola Nordmann",
            totals: cost(12.4),
          },
          { workspaceId: opsId, membershipId: null, name: "Kari Hansen", totals: cost(3.1) },
          {
            workspaceId: productId,
            membershipId: null,
            name: "Jonas Berg-Christiansen",
            totals: cost(1.85),
          },
        ],
    privateChatsTruncated: state === "truncated",
  };
}

function totals(
  billingPath: "opengeni_credits" | "external",
  calls: number,
  tokens: number,
  creditUsd: number,
  estimateUsd: number,
) {
  const input = Math.round(tokens * 0.92);
  return {
    billingPath,
    calls: String(calls),
    inputTokens: String(input),
    outputTokens: String(tokens - input),
    cachedTokens: String(Math.round(input * 0.6)),
    cacheInputTokens: String(input),
    cacheWriteTokens: "0",
    totalTokens: String(tokens),
    tokenKnownCalls: String(calls),
    cacheKnownCalls: String(calls),
    creditMicros: usd(creditUsd),
    estimatedProviderMicros: usd(estimateUsd),
    estimatedProviderKnownCalls: String(calls),
  };
}

function organizationModelUsage() {
  const credits = totals("opengeni_credits", 612, 31_000_000, 98.45, 84.2);
  const plan = totals("external", 240, 11_800_000, 0, 29.4);
  const ownKey = totals("external", 130, 5_100_000, 0, 18.75);
  const { billingPath: _a, ...creditPayer } = credits;
  const { billingPath: _b, ...planPayer } = plan;
  const { billingPath: _c, ...keyPayer } = ownKey;
  return {
    accountId,
    period: "month",
    since: "2026-09-01T00:00:00.000Z",
    until: "2026-10-01T00:00:00.000Z",
    billing: [credits, totals("external", 370, 16_900_000, 0, 48.15)],
    models: [
      { provider: "openai", model: "gpt-5", totals: credits },
      { provider: "codex-subscription", model: "gpt-5-codex", totals: plan },
      { provider: "anthropic", model: "claude-sonnet-4.5", totals: ownKey },
    ],
    modelsTruncated: false,
    workspaces: [],
    personal: { workspacesWithUsage: "1", billing: [] },
    nextWorkspaceCursor: null,
    payers: [
      { payer: "opengeni_credits", ...creditPayer },
      { payer: "subscription", ...planPayer },
      { payer: "own_key", ...keyPayer },
    ],
  };
}

function failure(): Error {
  return Object.assign(new Error("OpenGeni API 503: upstream timeout Reference: req_preview."), {
    status: 503,
  });
}

async function respond<T>(value: () => T): Promise<T> {
  if (state === "loading") return new Promise<T>(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (state === "error") throw failure();
  return value();
}

const empty = state === "empty";
const client = {
  getWorkspaceInsights: () => respond(() => ({ snapshot: workspaceSnapshot(empty) })),
  getOrganizationUsageSummary: () => respond(() => organizationSummary(empty)),
  getOrganizationUsageWorkspacePage: () => respond(() => organizationSummary(empty)),
  getOrganizationModelUsage: () =>
    respond(() =>
      empty
        ? { ...organizationModelUsage(), billing: [], models: [], payers: [] }
        : organizationModelUsage(),
    ),
};

const context = {
  workspaces: [
    { id: workspaceId, name: "Marketing" },
    { id: marketingId, name: "Marketing" },
  ],
  accessContext: {
    workspaceGrants: [
      { workspaceId, permissions: ["workspace:admin"] },
      { workspaceId: marketingId, permissions: ["workspace:admin"] },
    ],
  },
  client,
};

export function useAppContext() {
  return context as never;
}
