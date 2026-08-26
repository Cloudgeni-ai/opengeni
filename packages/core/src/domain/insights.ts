import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import {
  WorkspaceInsightsSnapshot,
  type InsightsRange,
  type WorkspaceInsightsResponse,
} from "@opengeni/contracts";
import {
  aggregateSessionDepth,
  aggregateWarmSecondsByGroup,
  countOnlineMachines,
  countScheduledTaskFires,
  countSessionsAttachedToGroups,
  enumerateUtcDays,
  enumerateUtcHours,
  listFloorSessions,
  listLiveWarmLeases,
  listScheduledTasks,
  readWorkspaceInsightsModelBundle,
  requireWorkspace,
  sumUsageQuantityByDay,
  sumUsageQuantityByHour,
  sumUsageQuantityInRange,
  sumUsageQuantitySinceForInsights,
  type Database,
} from "@opengeni/db";

const MACHINE_HEARTBEAT_FRESH_MS = 120_000;

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
  await requireWorkspace(db, input.workspaceId);
  const now = input.now ?? new Date();
  const window = resolveRangeWindow(input.range, now);
  const provider = input.provider?.trim() || null;
  const model = input.model?.trim() || null;
  const modelFilterActive = Boolean(provider || model);
  const filter = { provider, model };
  const sumUsageForSeries =
    input.range === "today" ? sumUsageQuantityByHour : sumUsageQuantityByDay;

  const [
    workspaceCreditMicros,
    priorWorkspaceCreditMicros,
    warmSeconds,
    priorWarmSeconds,
    modelBundle,
    warmDays,
    costDays,
    warmGroups,
    liveWarm,
    tasks,
    depth,
    floorRows,
    machinesOnline,
    billableTokensUsed,
    agentRunsUsed,
  ] = await Promise.all([
    sumUsageQuantityInRange(db, {
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      since: window.since,
      until: window.until,
    }),
    sumUsageQuantityInRange(db, {
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      since: window.priorSince,
      until: window.priorUntil,
    }),
    sumUsageQuantityInRange(db, {
      workspaceId: input.workspaceId,
      eventType: "sandbox.warm_seconds",
      since: window.since,
      until: window.until,
    }),
    sumUsageQuantityInRange(db, {
      workspaceId: input.workspaceId,
      eventType: "sandbox.warm_seconds",
      since: window.priorSince,
      until: window.priorUntil,
    }),
    readWorkspaceInsightsModelBundle(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      priorSince: window.priorSince,
      priorUntil: window.priorUntil,
      granularity: input.range === "today" ? "hour" : "day",
      ...filter,
    }),
    sumUsageForSeries(db, {
      workspaceId: input.workspaceId,
      eventType: "sandbox.warm_seconds",
      since: window.since,
      until: window.until,
    }),
    sumUsageForSeries(db, {
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      since: window.since,
      until: window.until,
    }),
    aggregateWarmSecondsByGroup(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      limit: 24,
    }),
    listLiveWarmLeases(db, input.workspaceId),
    listScheduledTasks(db, input.workspaceId, 100),
    aggregateSessionDepth(db, input.workspaceId),
    listFloorSessions(db, input.workspaceId, 24),
    settings.sandboxSelfhostedEnabled
      ? countOnlineMachines(db, input.workspaceId, MACHINE_HEARTBEAT_FRESH_MS, now)
      : Promise.resolve(0),
    sumUsageQuantitySinceForInsights(db, {
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      since: startOfUtcMonth(now),
    }),
    sumUsageQuantitySinceForInsights(db, {
      workspaceId: input.workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(now),
    }),
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
      : (costDays.get(bucket) ?? facts.costMicros);
    return {
      label: input.range === "today" ? bucket.slice(11) : bucket.slice(5),
      modelCostUsd: microsToUsd(modelCostMicros),
      estimatedProviderUsd: microsToUsd(facts.estimatedProviderCostMicros),
      estimatedProviderCostKnownCalls: facts.estimatedProviderCostKnownCalls,
      warmSeconds: warmDays.get(bucket) ?? 0,
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
