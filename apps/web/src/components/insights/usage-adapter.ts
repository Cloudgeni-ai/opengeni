/**
 * Builds the Insights usage shape from the older endpoints
 * (`GET /v1/workspaces/:id/insights`, `GET /v1/billing/usage-models`) while the
 * usage query API rolls out. Narrower than the real endpoint: its
 * `capabilities` say which group-bys, filters and ranges it can answer, and the
 * dashboard offers only those. Delete once every deployment serves
 * `.../insights/usage`.
 */
import type {
  InsightsModelUsageRow,
  InsightsRange,
  WorkspaceInsightsSnapshot,
} from "@opengeni/sdk";
import type { OrganizationModelUsage } from "@opengeni/contracts/organization-model-usage";

import {
  addMeasures as add,
  emptyMeasures,
  sumMeasures,
  modelFilterKey,
  parseModelFilterKey,
  type UsageCall,
  type UsageGroup,
  type UsageMeasures,
  type UsagePayerId,
  type UsageQuery,
  type UsageResponse,
  type UsageSeriesPoint,
} from "./usage-contract";
import { usagePayer } from "./payer";

const LEGACY_RANGES: readonly InsightsRange[] = ["today", "week", "month", "ytd"];

export function legacyRange(range: UsageQuery["range"]): InsightsRange {
  return (LEGACY_RANGES as readonly string[]).includes(range)
    ? (range as InsightsRange)
    : range === "30d"
      ? "month"
      : "ytd";
}

const micros = (usd: number | null | undefined) => Math.round((usd ?? 0) * 1_000_000);

/** One model×payer row of the workspace snapshot. */
function modelRowMeasures(row: InsightsModelUsageRow): UsageMeasures {
  const payer = usagePayer(row.billing, row.provider);
  const cacheRead = row.cachedTokens;
  const cacheWrite = row.cacheWriteTokens;
  const chargedMicros = micros(row.creditUsd);
  const listMicros = micros(row.estimatedProviderUsd);
  return {
    calls: row.calls,
    tokenKnownCalls: row.tokenKnownCalls,
    cacheKnownCalls: row.cacheKnownCalls,
    cacheWriteKnownCalls: row.cacheKnownCalls,
    tokens: {
      uncachedInput: Math.max(0, row.inputTokens - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: row.outputTokens,
      reasoning: row.reasoningTokens,
    },
    chargedMicros,
    listMicros,
    listByClassMicros: null,
    listClassKnownCalls: 0,
    listByClassApprox: false,
    pricedCalls: row.estimatedProviderCostKnownCalls,
    byPayer: { [payer]: { calls: row.calls, chargedMicros, listMicros } },
  };
}

/** A row the old API reports only as a token total and amounts. */
function totalsOnlyMeasures(input: {
  calls: number;
  tokens: number | null;
  creditUsd: number | null;
  estimatedProviderUsd: number | null;
  pricedCalls: number | null;
  externalShare: number;
}): UsageMeasures {
  const chargedMicros = micros(input.creditUsd);
  const listMicros = micros(input.estimatedProviderUsd);
  // The older endpoint doesn't split these rows by payer: credits pay for what
  // was charged, and the rest of the list price follows the window's mix.
  const external = chargedMicros > 0 ? 0 : Math.round(listMicros * input.externalShare);
  const externalCalls = external > 0 ? Math.round(input.calls * input.externalShare) : 0;
  return {
    ...emptyMeasures(),
    calls: input.calls,
    tokensTotal: input.tokens ?? 0,
    chargedMicros,
    listMicros,
    pricedCalls: input.pricedCalls ?? 0,
    byPayer: {
      opengeni_credits: {
        calls: input.calls - externalCalls,
        chargedMicros,
        listMicros: listMicros - external,
      },
      ...(external > 0
        ? {
            subscription: {
              calls: Math.max(1, externalCalls),
              chargedMicros: 0,
              listMicros: external,
            },
          }
        : {}),
    },
  };
}

function modelGroups(
  rows: ReadonlyArray<{ provider: string; model: string; measures: UsageMeasures }>,
  groupBy: "model" | "provider" | "payer",
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const payer = Object.keys(row.measures.byPayer ?? {})[0] as UsagePayerId | undefined;
    const key =
      groupBy === "model"
        ? modelFilterKey(row.provider, row.model)
        : groupBy === "provider"
          ? row.provider
          : (payer ?? "opengeni_credits");
    const existing = groups.get(key);
    if (existing) {
      add(existing.measures, row.measures);
      continue;
    }
    groups.set(key, {
      key,
      kind: "item",
      label: key,
      ...(groupBy !== "payer" ? { provider: row.provider } : {}),
      ...(groupBy === "model" ? { model: row.model } : {}),
      ...(groupBy === "payer" && payer ? { payer } : {}),
      measures: add(emptyMeasures(), row.measures),
    });
  }
  return [...groups.values()];
}

function bucketStarts(windowStart: string, count: number, bucket: "hour" | "day"): string[] {
  const start = Date.parse(windowStart);
  const step = bucket === "hour" ? 3_600_000 : 86_400_000;
  return Array.from({ length: count }, (_, index) => new Date(start + index * step).toISOString());
}

export function workspaceUsageFromSnapshot(
  snap: WorkspaceInsightsSnapshot,
  query: UsageQuery,
  scope: { workspaceId: string; accountId: string | null },
): { usage: UsageResponse; calls: UsageCall[] } {
  const rows = snap.models.map((row) => ({
    provider: row.provider,
    model: row.model,
    measures: modelRowMeasures(row),
  }));
  const totals = sumMeasures(rows.map((row) => row.measures));
  const externalShare =
    totals.listMicros > 0
      ? ((totals.byPayer?.subscription?.listMicros ?? 0) +
          (totals.byPayer?.own_key?.listMicros ?? 0)) /
        totals.listMicros
      : 0;

  let groups: UsageGroup[] = [];
  switch (query.groupBy) {
    case "model":
    case "provider":
    case "payer":
      groups = modelGroups(rows, query.groupBy);
      break;
    case "project":
      groups = (snap.projects ?? []).map((row) => ({
        key: row.kind === "project" ? row.id.replace(/^project:/, "") : row.kind,
        kind:
          row.kind === "project"
            ? "item"
            : row.kind === "unavailable"
              ? "private"
              : row.kind === "unfiled"
                ? "unfiled"
                : "other",
        label: row.kind === "unavailable" ? "Private chats" : row.label,
        measures: totalsOnlyMeasures({
          calls: row.calls,
          tokens: row.tokens,
          creditUsd: row.creditUsd,
          estimatedProviderUsd: row.estimatedProviderUsd,
          pricedCalls: row.estimatedProviderCostKnownCalls,
          externalShare,
        }),
      }));
      break;
    case "rootSession": {
      groups = snap.drivers.map((driver) => ({
        key: driver.id.replace(/^root:/, ""),
        kind: "item" as const,
        label: driver.label,
        measures: totalsOnlyMeasures({
          calls: 0,
          tokens: driver.tokens,
          creditUsd: driver.creditUsd,
          estimatedProviderUsd: driver.estimatedProviderUsd,
          pricedCalls: driver.estimatedProviderCostKnownCalls,
          externalShare,
        }),
      }));
      for (const owner of snap.privateChats ?? []) {
        groups.push({
          key: `private:${owner.ownerKey}`,
          kind: "private",
          label: owner.name ?? "Someone",
          you: owner.you,
          measures: totalsOnlyMeasures({
            calls: owner.calls,
            tokens: owner.tokens,
            creditUsd: owner.creditUsd,
            estimatedProviderUsd: owner.estimatedProviderUsd,
            pricedCalls: owner.estimatedProviderCostKnownCalls,
            externalShare,
          }),
        });
      }
      break;
    }
    case "schedule":
      groups = snap.schedules
        .filter((row) => row.fires > 0 || (row.tokens ?? 0) > 0)
        .map((row) => ({
          key: row.id,
          kind: "item" as const,
          label: row.name,
          measures: totalsOnlyMeasures({
            calls: 0,
            tokens: row.tokens,
            creditUsd: row.creditUsd,
            estimatedProviderUsd: row.estimatedProviderUsd,
            pricedCalls: row.estimatedProviderCostKnownCalls,
            externalShare,
          }),
        }));
      break;
    default:
      groups = [];
  }

  const bucket: "hour" | "day" = snap.range === "today" ? "hour" : "day";
  const starts = bucketStarts(snap.windowStart, snap.series.length, bucket);
  const series: UsageSeriesPoint[] = snap.series.map((point, index) => {
    const listMicros = micros(point.estimatedProviderUsd);
    const chargedMicros = micros(point.modelCostUsd);
    const external = Math.round(listMicros * externalShare);
    return {
      start: starts[index]!,
      measures: {
        ...emptyMeasures(),
        calls: point.calls,
        tokenKnownCalls: point.tokenKnownCalls,
        cacheKnownCalls: point.cacheKnownCalls,
        cacheWriteKnownCalls: point.cacheKnownCalls,
        tokens: {
          uncachedInput: Math.max(
            0,
            point.inputTokens - point.cachedTokens - point.cacheWriteTokens,
          ),
          cacheRead: point.cachedTokens,
          cacheWrite: point.cacheWriteTokens,
          output: point.outputTokens,
          reasoning: point.reasoningTokens,
        },
        chargedMicros,
        listMicros,
        pricedCalls: point.estimatedProviderCostKnownCalls,
        byPayer: {
          opengeni_credits: { calls: 0, chargedMicros, listMicros: listMicros - external },
          subscription: { calls: 0, chargedMicros: 0, listMicros: external },
        },
      },
    };
  });

  const hasPrior = snap.priorCalls > 0;
  const prior: UsageMeasures | null = hasPrior
    ? {
        ...emptyMeasures(),
        calls: snap.priorCalls,
        tokensTotal: snap.priorTotalTokens,
        chargedMicros: micros(snap.priorCreditUsd),
        listMicros: micros(snap.priorEstimatedProviderUsd),
        pricedCalls: snap.priorEstimatedProviderCostKnownCalls,
      }
    : null;

  const facets = snap.facets ?? [];
  const usage: UsageResponse = {
    scope: { kind: "workspace", workspaceId: scope.workspaceId, accountId: scope.accountId },
    range: legacyRange(query.range),
    windowStart: snap.windowStart,
    windowEnd: snap.windowEnd,
    priorWindowStart: null,
    priorWindowEnd: null,
    bucket,
    generatedAt: snap.generatedAt,
    dataThrough: snap.dataThrough ?? null,
    totals,
    prior,
    groupBy: query.groupBy,
    groups,
    groupCount: query.groupBy === "rootSession" ? snap.driverGroups : groups.length,
    groupsTruncated: query.groupBy === "rootSession" ? snap.driversTruncated : false,
    series,
    facets: {
      workspaces: [],
      providers: [...new Set(facets.map((facet) => facet.provider))],
      models: facets.map((facet) => ({ provider: facet.provider, model: facet.model })),
      payers: [],
      projects: [],
      people: [],
      schedules: [],
    },
    capabilities: {
      groupBy: ["model", "provider", "payer", "project", "rootSession", "schedule"],
      filters: ["provider", "model", "rootSessionId"],
      ranges: ["today", "week", "month", "ytd"],
      seriesGroups: false,
      multiValue: false,
    },
  };

  const calls: UsageCall[] = snap.recentCalls.map((call) => ({
    id: call.id,
    occurredAt: call.occurredAt,
    workspaceId: scope.workspaceId,
    sessionId: call.sessionId,
    sessionTitle: call.sessionTitle,
    sessionKind: "visible",
    provider: call.provider,
    model: call.model,
    payer: usagePayer(call.billing, call.provider),
    tokens:
      call.inputTokens === null
        ? null
        : {
            uncachedInput: Math.max(
              0,
              (call.inputTokens ?? 0) - (call.cachedTokens ?? 0) - (call.cacheWriteTokens ?? 0),
            ),
            cacheRead: call.cachedTokens ?? 0,
            cacheWrite: call.cacheWriteTokens ?? 0,
            output: call.outputTokens ?? 0,
            reasoning: call.reasoningTokens ?? 0,
          },
    chargedMicros: micros(call.creditUsd),
    listMicros: call.estimatedProviderUsd === null ? null : micros(call.estimatedProviderUsd),
  }));
  return { usage, calls };
}

/** The legacy workspace query for the adapter's supported filters. */
export function legacyWorkspaceFilters(query: UsageQuery): {
  provider?: string;
  model?: string;
  rootSessionId?: string;
} {
  const model = query.filters.model?.[0] ? parseModelFilterKey(query.filters.model[0]) : null;
  const provider = model?.provider ?? query.filters.provider?.[0];
  const root = query.filters.rootSessionId?.[0];
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model: model.model } : {}),
    ...(root ? { rootSessionId: root } : {}),
  };
}

type OrgTotals = OrganizationModelUsage["billing"][number];

function orgMeasures(totals: Omit<OrgTotals, "billingPath">, payer: UsagePayerId): UsageMeasures {
  const number = (value: string) => Number(value);
  const input = number(totals.inputTokens);
  const cacheRead = number(totals.cachedTokens);
  const cacheWrite = number(totals.cacheWriteTokens);
  const chargedMicros = number(totals.creditMicros);
  const listMicros = number(totals.estimatedProviderMicros);
  const calls = number(totals.calls);
  return {
    calls,
    tokenKnownCalls: number(totals.tokenKnownCalls),
    cacheKnownCalls: number(totals.cacheKnownCalls),
    cacheWriteKnownCalls: number(totals.cacheKnownCalls),
    tokens: {
      uncachedInput: Math.max(0, input - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: number(totals.outputTokens),
      reasoning: 0,
    },
    chargedMicros,
    listMicros,
    listByClassMicros: null,
    listClassKnownCalls: 0,
    listByClassApprox: false,
    pricedCalls: number(totals.estimatedProviderKnownCalls),
    byPayer: { [payer]: { calls, chargedMicros, listMicros } },
  };
}

export function organizationUsageFromModelUsage(
  data: OrganizationModelUsage,
  query: UsageQuery,
): UsageResponse {
  const modelRows = data.models.map((row) => ({
    provider: row.provider,
    model: row.model,
    measures: orgMeasures(row.totals, usagePayer(row.totals.billingPath, row.provider)),
  }));
  const payerRows = data.payers.map((row) => orgMeasures(row, row.payer));
  const totals = sumMeasures(payerRows);

  let groups: UsageGroup[] = [];
  if (query.groupBy === "workspace") {
    groups = data.workspaces.map((workspace) => ({
      key: workspace.workspaceId,
      kind: "item" as const,
      label: workspace.name ?? "Workspace",
      workspaceId: workspace.workspaceId,
      measures: sumMeasures(
        workspace.billing.map((row) =>
          orgMeasures(
            row,
            row.billingPath === "opengeni_credits" ? "opengeni_credits" : "subscription",
          ),
        ),
      ),
    }));
    const personal = sumMeasures(
      data.personal.billing.map((row) =>
        orgMeasures(
          row,
          row.billingPath === "opengeni_credits" ? "opengeni_credits" : "subscription",
        ),
      ),
    );
    if (personal.calls > 0) {
      groups.push({
        key: "personal",
        kind: "personal",
        label: "Personal workspaces",
        measures: personal,
      });
    }
  } else if (query.groupBy === "payer") {
    groups = data.payers.map((row) => ({
      key: row.payer,
      kind: "item" as const,
      label: row.payer,
      payer: row.payer,
      measures: orgMeasures(row, row.payer),
    }));
  } else {
    groups = modelGroups(modelRows, query.groupBy === "provider" ? "provider" : "model");
  }

  return {
    scope: { kind: "organization", accountId: data.accountId, workspaceId: null },
    range: legacyRange(query.range),
    windowStart: data.since,
    windowEnd: data.until,
    priorWindowStart: null,
    priorWindowEnd: null,
    bucket: query.range === "today" ? "hour" : "day",
    generatedAt: data.until,
    dataThrough: null,
    totals,
    prior: null,
    groupBy: query.groupBy,
    groups,
    groupCount: groups.length,
    groupsTruncated:
      query.groupBy === "workspace" ? data.nextWorkspaceCursor !== null : data.modelsTruncated,
    series: [],
    facets: {
      workspaces: data.workspaces.map((workspace) => ({
        id: workspace.workspaceId,
        name: workspace.name ?? "Workspace",
        personal: false,
      })),
      providers: [...new Set(data.models.map((row) => row.provider))],
      models: data.models.map((row) => ({ provider: row.provider, model: row.model })),
      payers: data.payers.map((row) => row.payer),
      projects: [],
      people: [],
      schedules: [],
    },
    capabilities: {
      groupBy: ["model", "provider", "payer", "workspace"],
      filters: [],
      ranges: ["today", "week", "month", "ytd"],
      seriesGroups: false,
      multiValue: false,
    },
  };
}
