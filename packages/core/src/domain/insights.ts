import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import {
  WorkspaceInsightsSnapshot,
  type InsightsRange,
  type WorkspaceInsightsResponse,
} from "@opengeni/contracts";
import {
  aggregateSessionDepth,
  countOnlineMachines,
  countScheduledTaskFires,
  countSessionsAttachedToGroups,
  enumerateUtcDays,
  enumerateUtcHours,
  listFloorSessions,
  listLiveWarmLeases,
  listScheduledTasks,
  readWorkspaceInsightsModelBundle,
  readWorkspaceInsightsUsageBundle,
  requireWorkspace,
  type Database,
} from "@opengeni/db";

const MACHINE_HEARTBEAT_FRESH_MS = 120_000;
export const WORKSPACE_INSIGHTS_PROVIDER_FILTER_MAX_UTF8_BYTES = 256;
export const WORKSPACE_INSIGHTS_MODEL_FILTER_MAX_UTF8_BYTES = 512;

export type WorkspaceInsightsFilterField = "provider" | "model";

export class WorkspaceInsightsFilterValidationError extends Error {
  readonly field: WorkspaceInsightsFilterField;
  readonly maxUtf8Bytes: number;

  constructor(field: WorkspaceInsightsFilterField, maxUtf8Bytes: number) {
    super(`${field} must be at most ${maxUtf8Bytes} UTF-8 bytes`);
    this.name = "WorkspaceInsightsFilterValidationError";
    this.field = field;
    this.maxUtf8Bytes = maxUtf8Bytes;
  }
}

/** Normalize the public filter sentinel and enforce the database authority envelope. */
export function normalizeWorkspaceInsightsFilter(
  value: string | null | undefined,
  field: WorkspaceInsightsFilterField,
): string | null {
  const normalized = value?.trim() || null;
  if (normalized === null || normalized === "all") return null;
  const maxUtf8Bytes =
    field === "provider"
      ? WORKSPACE_INSIGHTS_PROVIDER_FILTER_MAX_UTF8_BYTES
      : WORKSPACE_INSIGHTS_MODEL_FILTER_MAX_UTF8_BYTES;
  if (new TextEncoder().encode(normalized).byteLength > maxUtf8Bytes) {
    throw new WorkspaceInsightsFilterValidationError(field, maxUtf8Bytes);
  }
  return normalized;
}

export type GetWorkspaceInsightsInput = {
  workspaceId: string;
  range: InsightsRange;
  provider?: string | null;
  model?: string | null;
  now?: Date;
};

function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

function cacheHitPct(cached: number, input: number): number {
  if (input <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((cached / input) * 100)));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfUtcYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function resolveRangeWindow(
  range: InsightsRange,
  now: Date,
): {
  since: Date;
  until: Date;
  priorSince: Date;
  priorUntil: Date;
  rangeLabel: string;
  priorLabel: string;
  seriesLabel: string;
  cacheSeriesLabel: string;
} {
  const until = now;
  let since: Date;
  let rangeLabel: string;
  let priorLabel: string;
  let seriesLabel: string;
  let cacheSeriesLabel: string;
  switch (range) {
    case "today":
      since = startOfUtcDay(now);
      rangeLabel = "Today (UTC)";
      priorLabel = "Prior equal window";
      seriesLabel = "Credit $ / UTC hour";
      cacheSeriesLabel = "Cache hit % / UTC hour";
      break;
    case "week":
      since = new Date(startOfUtcDay(now).getTime() - 6 * 24 * 60 * 60 * 1000);
      rangeLabel = "Last 7 days (UTC)";
      priorLabel = "Prior 7 days";
      seriesLabel = "Credit $ / UTC day";
      cacheSeriesLabel = "Cache hit % / UTC day";
      break;
    case "month":
      since = startOfUtcMonth(now);
      rangeLabel = "This month (UTC)";
      priorLabel = "Prior equal window";
      seriesLabel = "Credit $ / UTC day";
      cacheSeriesLabel = "Cache hit % / UTC day";
      break;
    case "ytd":
      since = startOfUtcYear(now);
      rangeLabel = "Year to date (UTC)";
      priorLabel = "Prior equal window";
      seriesLabel = "Credit $ / UTC day";
      cacheSeriesLabel = "Cache hit % / UTC day";
      break;
    default: {
      const _exhaustive: never = range;
      throw new Error(`Unknown insights range: ${_exhaustive}`);
    }
  }
  const durationMs = until.getTime() - since.getTime();
  const priorUntil = since;
  const priorSince = new Date(priorUntil.getTime() - Math.max(durationMs, 1));
  return {
    since,
    until,
    priorSince,
    priorUntil,
    rangeLabel,
    priorLabel,
    seriesLabel,
    cacheSeriesLabel,
  };
}

function ageLabel(updatedAt: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - updatedAt.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function floorState(input: {
  status: string;
  directControlState: string;
}): "running" | "paused" | "failed" | "idle" | "compacting" | "waiting" {
  if (input.directControlState === "paused") return "paused";
  switch (input.status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "requires_action":
    case "waiting":
      return "waiting";
    case "compacting":
      return "compacting";
    case "completed":
    case "idle":
    case "queued":
      return "idle";
    default:
      return "idle";
  }
}

function billingPathOf(value: string): "opengeni_credits" | "external" {
  return value === "external" ? "external" : "opengeni_credits";
}

function pricingSourceOf(
  value: string | null,
): "configured_list_price" | "gateway_reported" | null {
  return value === "configured_list_price" || value === "gateway_reported" ? value : null;
}

export function insightsSessionLabel(input: {
  id: string;
  title: string | null;
  depth?: number | null;
}): string {
  const title = input.title?.trim();
  if (title) return title;
  return `${(input.depth ?? 0) > 0 ? "Agent" : "Session"} ${input.id.slice(0, 8)}`;
}

export async function getWorkspaceInsights(
  db: Database,
  settings: Settings,
  input: GetWorkspaceInsightsInput,
): Promise<WorkspaceInsightsResponse> {
  const provider = normalizeWorkspaceInsightsFilter(input.provider, "provider");
  const model = normalizeWorkspaceInsightsFilter(input.model, "model");
  await requireWorkspace(db, input.workspaceId);
  const now = input.now ?? new Date();
  const window = resolveRangeWindow(input.range, now);
  const modelFilterActive = Boolean(provider || model);
  const filter = { provider, model };

  const [modelBundle, usageBundle, liveWarm, tasks, depth, floorRows, machinesOnline] =
    await Promise.all([
      readWorkspaceInsightsModelBundle(db, {
        workspaceId: input.workspaceId,
        since: window.since,
        until: window.until,
        priorSince: window.priorSince,
        priorUntil: window.priorUntil,
        granularity: input.range === "today" ? "hour" : "day",
        ...filter,
      }),
      readWorkspaceInsightsUsageBundle(db, {
        workspaceId: input.workspaceId,
        since: window.since,
        until: window.until,
        priorSince: window.priorSince,
        priorUntil: window.priorUntil,
        monthSince: startOfUtcMonth(now),
        granularity: input.range === "today" ? "hour" : "day",
        warmGroupLimit: 24,
      }),
      listLiveWarmLeases(db, input.workspaceId),
      listScheduledTasks(db, input.workspaceId, 100),
      aggregateSessionDepth(db, input.workspaceId),
      listFloorSessions(db, input.workspaceId, 24),
      settings.sandboxSelfhostedEnabled
        ? countOnlineMachines(db, input.workspaceId, MACHINE_HEARTBEAT_FRESH_MS, now)
        : Promise.resolve(0),
    ]);

  const {
    modelRows,
    priorModelRows,
    factBuckets: factDays,
    rootDrivers,
    priorRootDrivers,
    scheduleFacts,
    facets,
    recentCalls,
    promptContributions,
  } = modelBundle;
  const {
    workspaceCreditMicros,
    priorWorkspaceCreditMicros,
    warmSeconds,
    priorWarmSeconds,
    buckets: usageBuckets,
    warmGroups,
    billableTokensUsed,
    agentRunsUsed,
  } = usageBundle;
  const [attached, fireCounts] = await Promise.all([
    countSessionsAttachedToGroups(
      db,
      input.workspaceId,
      warmGroups.map((group) => group.groupId),
    ),
    countScheduledTaskFires(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      taskIds: tasks.map((task) => task.id),
    }),
  ]);
  const backendByGroup = new Map(liveWarm.map((lease) => [lease.groupId, lease.backend]));
  const warmSecondsByGroup = new Map(warmGroups.map((group) => [group.groupId, group.warmSeconds]));

  const models = modelRows
    .map((row) => ({
      id: `${row.provider}:${row.model}:${row.billingPath}`,
      model: row.model,
      provider: row.provider,
      billing: billingPathOf(row.billingPath),
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      cacheInputTokens: row.cacheInputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      totalTokens: row.totalTokens,
      tokenKnownCalls: row.tokenKnownCalls,
      cacheKnownCalls: row.cacheKnownCalls,
      creditUsd: microsToUsd(row.pricedCostMicros),
      estimatedProviderUsd: microsToUsd(row.estimatedProviderCostMicros),
      estimatedProviderCostKnownCalls: row.estimatedProviderCostKnownCalls,
      equivalentCreditUsd: microsToUsd(row.equivalentCreditCostMicros),
      equivalentCreditCostKnownCalls: row.equivalentCreditCostKnownCalls,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const creditMicros = modelRows.reduce((sum, row) => sum + row.pricedCostMicros, 0);
  const priorCreditMicros = priorModelRows.reduce((sum, row) => sum + row.pricedCostMicros, 0);
  const estimatedProviderCostMicros = modelRows.reduce(
    (sum, row) => sum + row.estimatedProviderCostMicros,
    0,
  );
  const priorEstimatedProviderCostMicros = priorModelRows.reduce(
    (sum, row) => sum + row.estimatedProviderCostMicros,
    0,
  );
  const estimatedProviderCostKnownCalls = modelRows.reduce(
    (sum, row) => sum + row.estimatedProviderCostKnownCalls,
    0,
  );
  const priorEstimatedProviderCostKnownCalls = priorModelRows.reduce(
    (sum, row) => sum + row.estimatedProviderCostKnownCalls,
    0,
  );
  const equivalentCreditCostMicros = modelRows.reduce(
    (sum, row) => sum + row.equivalentCreditCostMicros,
    0,
  );
  const priorEquivalentCreditCostMicros = priorModelRows.reduce(
    (sum, row) => sum + row.equivalentCreditCostMicros,
    0,
  );
  const equivalentCreditCostKnownCalls = modelRows.reduce(
    (sum, row) => sum + row.equivalentCreditCostKnownCalls,
    0,
  );
  const priorEquivalentCreditCostKnownCalls = priorModelRows.reduce(
    (sum, row) => sum + row.equivalentCreditCostKnownCalls,
    0,
  );
  const modelCalls = modelRows.reduce((sum, row) => sum + row.calls, 0);
  const priorInputTokens = priorModelRows.reduce((sum, row) => sum + row.inputTokens, 0);
  const priorTotalTokens = priorModelRows.reduce((sum, row) => sum + row.totalTokens, 0);
  const priorCachedTokens = priorModelRows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const priorCacheInputTokens = priorModelRows.reduce((sum, row) => sum + row.cacheInputTokens, 0);
  const priorCalls = priorModelRows.reduce((sum, row) => sum + row.calls, 0);

  const buckets =
    input.range === "today"
      ? enumerateUtcHours(window.since, window.until)
      : enumerateUtcDays(window.since, window.until);
  const series = buckets.map((bucket) => {
    const facts = factDays.get(bucket) ?? {
      costMicros: 0,
      estimatedProviderCostMicros: 0,
      estimatedProviderCostKnownCalls: 0,
      equivalentCreditCostMicros: 0,
      equivalentCreditCostKnownCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      tokenKnownCalls: 0,
      cacheKnownCalls: 0,
      calls: 0,
    };
    const modelCostMicros = modelFilterActive
      ? facts.costMicros
      : (usageBuckets.get(bucket)?.costMicros ?? facts.costMicros);
    return {
      label: input.range === "today" ? bucket.slice(11) : bucket.slice(5),
      modelCostUsd: microsToUsd(modelCostMicros),
      estimatedProviderUsd: microsToUsd(facts.estimatedProviderCostMicros),
      estimatedProviderCostKnownCalls: facts.estimatedProviderCostKnownCalls,
      equivalentCreditUsd: microsToUsd(facts.equivalentCreditCostMicros),
      equivalentCreditCostKnownCalls: facts.equivalentCreditCostKnownCalls,
      warmSeconds: usageBuckets.get(bucket)?.warmSeconds ?? 0,
      inputTokens: facts.inputTokens,
      outputTokens: facts.outputTokens,
      cachedTokens: facts.cachedTokens,
      cacheInputTokens: facts.cacheInputTokens,
      cacheWriteTokens: facts.cacheWriteTokens,
      reasoningTokens: facts.reasoningTokens,
      totalTokens: facts.totalTokens,
      tokenKnownCalls: facts.tokenKnownCalls,
      cacheKnownCalls: facts.cacheKnownCalls,
      cacheHitPct: cacheHitPct(facts.cachedTokens, facts.cacheInputTokens),
      calls: facts.calls,
    };
  });

  const priorDriverByRoot = new Map(
    priorRootDrivers.map((row) => [row.rootSessionId, row.pricedCostMicros]),
  );
  const totalTokensForPct = Math.max(
    rootDrivers.reduce((sum, row) => sum + row.totalTokens, 0),
    1,
  );
  const drivers = rootDrivers.map((row) => {
    const creditUsd = microsToUsd(row.pricedCostMicros);
    const priorUsd = microsToUsd(priorDriverByRoot.get(row.rootSessionId) ?? 0);
    return {
      id: `root:${row.rootSessionId}`,
      groupBy: "root_session" as const,
      label: insightsSessionLabel({ id: row.rootSessionId, title: row.title, depth: 0 }),
      creditUsd,
      estimatedProviderUsd: microsToUsd(row.estimatedProviderCostMicros),
      estimatedProviderCostKnownCalls: row.estimatedProviderCostKnownCalls,
      equivalentCreditUsd: microsToUsd(row.equivalentCreditCostMicros),
      equivalentCreditCostKnownCalls: row.equivalentCreditCostKnownCalls,
      tokens: row.totalTokens,
      cacheHitPct: cacheHitPct(row.cachedTokens, row.cacheInputTokens),
      pctOfCreditUsd:
        creditMicros > 0
          ? Math.min(100, Math.round((row.pricedCostMicros / creditMicros) * 100))
          : 0,
      pctOfTokens: Math.min(100, Math.round((row.totalTokens / totalTokensForPct) * 100)),
      deltaUsdVsPrior: creditUsd - priorUsd,
    };
  });

  const scheduleFactById = new Map(scheduleFacts.map((row) => [row.scheduledTaskId, row] as const));
  const schedules = tasks.map((task) => {
    const fact = scheduleFactById.get(task.id);
    return {
      id: task.id,
      name: task.name,
      fires: fireCounts.get(task.id) ?? 0,
      creditUsd: fact ? microsToUsd(fact.pricedCostMicros) : null,
      estimatedProviderUsd: fact ? microsToUsd(fact.estimatedProviderCostMicros) : null,
      estimatedProviderCostKnownCalls: fact ? fact.estimatedProviderCostKnownCalls : null,
      equivalentCreditUsd: fact ? microsToUsd(fact.equivalentCreditCostMicros) : null,
      equivalentCreditCostKnownCalls: fact ? fact.equivalentCreditCostKnownCalls : null,
      tokens: fact ? fact.totalTokens : null,
      cacheHitPct: fact ? cacheHitPct(fact.cachedTokens, fact.cacheInputTokens) : null,
      billing: fact ? billingPathOf(fact.billingPath) : null,
    };
  });

  const limits = configuredStaticUsageLimits(settings);
  // Floor sessions only carry product model, not provider. Filter when an exact
  // model is selected; otherwise leave the list workspace-wide (captioned in UI).
  const floor = floorRows
    .filter((row) => {
      if (!model) return true;
      return row.model === model;
    })
    .map((row) => ({
      id: row.id,
      title: insightsSessionLabel({
        id: row.id,
        title: row.title,
        depth: row.nestedAgentDepth,
      }),
      state: floorState(row),
      depth: row.nestedAgentDepth,
      model: row.model,
      provider: null,
      ageLabel: ageLabel(row.updatedAt, now),
      cacheHitPct: null,
      route: row.sandboxBackend,
    }));

  const snapshot = WorkspaceInsightsSnapshot.parse({
    range: input.range,
    rangeLabel: window.rangeLabel,
    priorLabel: window.priorLabel,
    seriesLabel: window.seriesLabel,
    cacheSeriesLabel: window.cacheSeriesLabel,
    windowStart: window.since.toISOString(),
    windowEnd: window.until.toISOString(),
    generatedAt: now.toISOString(),
    timezone: "UTC",
    models,
    facets,
    series,
    depth: depth.buckets.map((bucket) => ({
      depth: bucket.depth,
      sessions: bucket.sessions,
    })),
    drivers,
    schedules,
    recentCalls: recentCalls.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      recordedAt: row.recordedAt.toISOString(),
      sessionId: row.sessionId,
      sessionTitle: insightsSessionLabel({
        id: row.sessionId,
        title: row.sessionTitle,
        depth: row.sessionDepth,
      }),
      turnId: row.turnId,
      provider: row.provider,
      providerApi: row.providerApi,
      model: row.model,
      billing: billingPathOf(row.billingPath),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      totalTokens: row.totalTokens,
      creditUsd: microsToUsd(row.pricedCostMicros),
      estimatedProviderUsd:
        row.estimatedProviderCostMicros == null
          ? null
          : microsToUsd(row.estimatedProviderCostMicros),
      equivalentCreditUsd:
        row.equivalentCreditCostMicros == null ? null : microsToUsd(row.equivalentCreditCostMicros),
      pricingSource: pricingSourceOf(row.pricingSource),
    })),
    promptContributions,
    warmSeconds,
    priorWarmSeconds,
    warmGroups: warmGroups.map((group) => ({
      id: group.groupId,
      groupId: group.groupId,
      label: group.groupId.slice(0, 8),
      backend: backendByGroup.get(group.groupId) ?? null,
      warmSeconds: group.warmSeconds,
      sessionsAttached: attached.get(group.groupId) ?? 0,
    })),
    liveWarm: liveWarm.map((lease) => ({
      id: lease.id,
      groupId: lease.groupId,
      backend: lease.backend,
      turnHolders: lease.turnHolders,
      viewerHolders: lease.viewerHolders,
      warmForLabel: lease.turnHolders > 0 ? "in use" : "idle warm",
      warmSeconds: warmSecondsByGroup.get(lease.groupId) ?? 0,
    })),
    floor,
    selfhostedEnabled: settings.sandboxSelfhostedEnabled,
    machinesOnline,
    workspaceCreditUsd: microsToUsd(workspaceCreditMicros),
    priorWorkspaceCreditUsd: microsToUsd(priorWorkspaceCreditMicros),
    creditUsd: microsToUsd(creditMicros),
    priorCreditUsd: microsToUsd(priorCreditMicros),
    estimatedProviderUsd: microsToUsd(estimatedProviderCostMicros),
    priorEstimatedProviderUsd: microsToUsd(priorEstimatedProviderCostMicros),
    estimatedProviderCostKnownCalls,
    priorEstimatedProviderCostKnownCalls,
    equivalentCreditUsd: microsToUsd(equivalentCreditCostMicros),
    priorEquivalentCreditUsd: microsToUsd(priorEquivalentCreditCostMicros),
    equivalentCreditCostKnownCalls,
    priorEquivalentCreditCostKnownCalls,
    modelCalls,
    priorInputTokens,
    priorTotalTokens,
    priorCacheHitPct: cacheHitPct(priorCachedTokens, priorCacheInputTokens),
    priorCalls,
    goalsActive: depth.goalsActive,
    goalsCompleted: depth.goalsCompleted,
    sessionsTouched: depth.sessionsTouched,
    rootSessions: depth.rootSessions,
    deepestDepth: depth.deepestDepth,
    deepestSessionTitle: depth.deepestSessionId
      ? insightsSessionLabel({
          id: depth.deepestSessionId,
          title: depth.deepestSessionTitle,
          depth: depth.deepestDepth,
        })
      : "",
    avgDepth: Math.round(depth.avgDepth * 10) / 10,
    warmIdleNow: liveWarm.filter((lease) => lease.turnHolders === 0).length,
    billableTokensUsed,
    billableTokenCap: limits.maxMonthlyTokensPerWorkspace ?? null,
    agentRunsUsed,
    agentRunCap: limits.maxMonthlyAgentRunsPerWorkspace ?? null,
    modelFilterActive,
  });

  return { snapshot };
}
