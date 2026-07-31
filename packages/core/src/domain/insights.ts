import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import {
  WorkspaceInsightsSnapshot,
  type InsightsRange,
  type WorkspaceInsightsResponse,
} from "@opengeni/contracts";
import {
  aggregateModelCallFacts,
  aggregateModelCallFactsByDay,
  aggregateRootSessionDrivers,
  aggregateScheduleFacts,
  aggregateSessionDepth,
  aggregateWarmSecondsByGroup,
  countOnlineMachines,
  countScheduledTaskFires,
  countSessionsAttachedToGroups,
  enumerateUtcDays,
  listFloorSessions,
  listLiveWarmLeases,
  listModelCallFacets,
  listScheduledTasks,
  requireWorkspace,
  sumUsageQuantity,
  sumUsageQuantityByDay,
  sumUsageQuantityInRange,
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
  return Math.round((micros / 1_000_000) * 100) / 100;
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
      seriesLabel = "Credit $ (UTC day)";
      cacheSeriesLabel = "Cache hit %";
      break;
    case "week":
      since = new Date(startOfUtcDay(now).getTime() - 6 * 24 * 60 * 60 * 1000);
      rangeLabel = "Last 7 days (UTC)";
      priorLabel = "Prior 7 days";
      seriesLabel = "Credit $ / day";
      cacheSeriesLabel = "Cache hit % / day";
      break;
    case "month":
      since = startOfUtcMonth(now);
      rangeLabel = "This month (UTC)";
      priorLabel = "Prior equal window";
      seriesLabel = "Credit $ / day";
      cacheSeriesLabel = "Cache hit % / day";
      break;
    case "ytd":
      since = startOfUtcYear(now);
      rangeLabel = "Year to date (UTC)";
      priorLabel = "Prior equal window";
      seriesLabel = "Credit $ / day";
      cacheSeriesLabel = "Cache hit % / day";
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

  const [
    workspaceCreditMicros,
    priorWorkspaceCreditMicros,
    warmSeconds,
    priorWarmSeconds,
    modelRows,
    priorModelRows,
    factDays,
    warmDays,
    costDays,
    warmGroups,
    liveWarm,
    rootDrivers,
    priorRootDrivers,
    scheduleFacts,
    tasks,
    depth,
    floorRows,
    machinesOnline,
    billableTokensUsed,
    agentRunsUsed,
    facets,
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
    aggregateModelCallFacts(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      ...filter,
    }),
    aggregateModelCallFacts(db, {
      workspaceId: input.workspaceId,
      since: window.priorSince,
      until: window.priorUntil,
      ...filter,
    }),
    aggregateModelCallFactsByDay(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      ...filter,
    }),
    sumUsageQuantityByDay(db, {
      workspaceId: input.workspaceId,
      eventType: "sandbox.warm_seconds",
      since: window.since,
      until: window.until,
    }),
    sumUsageQuantityByDay(db, {
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
    aggregateRootSessionDrivers(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      ...filter,
      limit: 8,
    }),
    aggregateRootSessionDrivers(db, {
      workspaceId: input.workspaceId,
      since: window.priorSince,
      until: window.priorUntil,
      ...filter,
      limit: 32,
    }),
    aggregateScheduleFacts(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
      ...filter,
    }),
    listScheduledTasks(db, input.workspaceId, 100),
    aggregateSessionDepth(db, input.workspaceId),
    listFloorSessions(db, input.workspaceId, 24),
    settings.sandboxSelfhostedEnabled
      ? countOnlineMachines(db, input.workspaceId, MACHINE_HEARTBEAT_FRESH_MS)
      : Promise.resolve(0),
    sumUsageQuantity(db, {
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      since: startOfUtcMonth(now),
    }),
    sumUsageQuantity(db, {
      workspaceId: input.workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(now),
    }),
    listModelCallFacets(db, {
      workspaceId: input.workspaceId,
      since: window.since,
      until: window.until,
    }),
  ]);

  const attached = await countSessionsAttachedToGroups(
    db,
    input.workspaceId,
    warmGroups.map((group) => group.groupId),
  );
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
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      creditUsd: microsToUsd(row.pricedCostMicros),
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens);

  const creditMicros = modelRows.reduce((sum, row) => sum + row.pricedCostMicros, 0);
  const priorCreditMicros = priorModelRows.reduce((sum, row) => sum + row.pricedCostMicros, 0);
  const inputTokens = modelRows.reduce((sum, row) => sum + row.inputTokens, 0);
  const cachedTokens = modelRows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const priorInputTokens = priorModelRows.reduce((sum, row) => sum + row.inputTokens, 0);
  const priorCachedTokens = priorModelRows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const priorCalls = priorModelRows.reduce((sum, row) => sum + row.calls, 0);

  const days = enumerateUtcDays(window.since, window.until);
  const series = days.map((day) => {
    const facts = factDays.get(day) ?? {
      costMicros: 0,
      inputTokens: 0,
      cachedTokens: 0,
      calls: 0,
    };
    const modelCostMicros = modelFilterActive
      ? facts.costMicros
      : (costDays.get(day) ?? facts.costMicros);
    return {
      label: day.slice(5),
      modelCostUsd: microsToUsd(modelCostMicros),
      warmSeconds: warmDays.get(day) ?? 0,
      inputTokens: facts.inputTokens,
      cachedTokens: facts.cachedTokens,
      cacheHitPct: cacheHitPct(facts.cachedTokens, facts.inputTokens),
      calls: facts.calls,
    };
  });

  const priorDriverByRoot = new Map(
    priorRootDrivers.map((row) => [row.rootSessionId, row.pricedCostMicros]),
  );
  const creditUsdForPct = Math.max(microsToUsd(creditMicros), 0.01);
  const drivers = rootDrivers.map((row) => {
    const creditUsd = microsToUsd(row.pricedCostMicros);
    const priorUsd = microsToUsd(priorDriverByRoot.get(row.rootSessionId) ?? 0);
    return {
      id: `root:${row.rootSessionId}`,
      groupBy: "root_session" as const,
      label: row.title?.trim() || row.rootSessionId.slice(0, 8),
      creditUsd,
      tokens: row.inputTokens,
      cacheHitPct: cacheHitPct(row.cachedTokens, row.inputTokens),
      pctOfCreditUsd: Math.min(100, Math.round((creditUsd / creditUsdForPct) * 100)),
      deltaUsdVsPrior: Math.round((creditUsd - priorUsd) * 100) / 100,
    };
  });

  const fireCounts = await countScheduledTaskFires(db, {
    workspaceId: input.workspaceId,
    since: window.since,
    until: window.until,
    taskIds: tasks.map((task) => task.id),
  });
  const scheduleFactById = new Map(
    scheduleFacts.map((row) => [row.scheduledTaskId, row] as const),
  );
  const schedules = tasks.map((task) => {
    const fact = scheduleFactById.get(task.id);
    return {
      id: task.id,
      name: task.name,
      fires: fireCounts.get(task.id) ?? 0,
      creditUsd: fact ? microsToUsd(fact.pricedCostMicros) : null,
      tokens: fact ? fact.inputTokens : null,
      cacheHitPct: fact ? cacheHitPct(fact.cachedTokens, fact.inputTokens) : null,
      billing: fact ? billingPathOf(fact.billingPath) : null,
    };
  });

  const limits = configuredStaticUsageLimits(settings);
  const floor = floorRows
    .filter((row) => {
      if (!modelFilterActive) return true;
      if (model && row.model !== model) return false;
      return true;
    })
    .map((row) => ({
      id: row.id,
      title: row.title?.trim() || "Untitled session",
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
    priorInputTokens,
    priorCacheHitPct: cacheHitPct(priorCachedTokens, priorInputTokens),
    priorCalls,
    goalsActive: depth.goalsActive,
    goalsCompleted: depth.goalsCompleted,
    sessionsTouched: depth.sessionsTouched,
    rootSessions: depth.rootSessions,
    deepestDepth: depth.deepestDepth,
    deepestSessionTitle: depth.deepestSessionTitle || "",
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
