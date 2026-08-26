import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./database";
import { rlsContextForWorkspace, withRlsContext } from "./database";
import * as schema from "./schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InsightsTimeWindow = {
  since: Date;
  until: Date;
};

export type ModelCallFactAggregateRow = {
  provider: string;
  model: string;
  billingPath: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  tokenKnownCalls: number;
  cacheKnownCalls: number;
  pricedCostMicros: number;
  estimatedProviderCostMicros: number;
  estimatedProviderCostKnownCalls: number;
};

export type InsightsDayBucket = {
  day: string;
  modelCostMicros: number;
  warmSeconds: number;
  inputTokens: number;
  cachedTokens: number;
  calls: number;
};

export type WarmGroupAggregate = {
  groupId: string;
  warmSeconds: number;
};

export type LiveWarmLeaseRow = {
  id: string;
  groupId: string;
  backend: string;
  turnHolders: number;
  viewerHolders: number;
  lastMeterAt: Date | null;
};

export type RootSessionDriverRow = {
  rootSessionId: string;
  title: string | null;
  pricedCostMicros: number;
  estimatedProviderCostMicros: number;
  estimatedProviderCostKnownCalls: number;
  totalTokens: number;
  cachedTokens: number;
  cacheInputTokens: number;
};

export type ScheduleFactAggregate = {
  scheduledTaskId: string;
  pricedCostMicros: number;
  estimatedProviderCostMicros: number;
  estimatedProviderCostKnownCalls: number;
  totalTokens: number;
  cachedTokens: number;
  cacheInputTokens: number;
  calls: number;
  /** Prefer credits whenever any credits-path call exists in the window. */
  billingPath: string;
};

export type ModelCallFacetRow = {
  provider: string;
  model: string;
};

export type ModelContextContributionAggregate = {
  estimatedTokens: number;
  utf8Bytes: number;
  coveredCalls: number;
  totalCalls: number;
  sources: Array<{
    source: string;
    items: number;
    utf8Bytes: number;
    estimatedTokens: number;
    calls: number;
  }>;
};

export type SessionDepthAggregate = {
  depth: number;
  sessions: number;
};

export type FloorSessionRow = {
  id: string;
  title: string | null;
  status: string;
  directControlState: string;
  nestedAgentDepth: number;
  model: string;
  sandboxBackend: string;
  updatedAt: Date;
  createdAt: Date;
};

export type RecentModelCallRow = {
  id: string;
  occurredAt: Date;
  recordedAt: Date;
  sessionId: string;
  sessionTitle: string | null;
  sessionDepth: number | null;
  turnId: string;
  provider: string;
  providerApi: string;
  model: string;
  billingPath: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  pricedCostMicros: number;
  estimatedProviderCostMicros: number | null;
  pricingSource: string | null;
};

function dayKeyUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function hourKeyUtc(value: Date): string {
  return `${value.toISOString().slice(0, 13)}:00`;
}

export async function sumUsageQuantityInRange(
  db: Database,
  input: {
    workspaceId: string;
    eventType: string;
    since: Date;
    until: Date;
  },
): Promise<number> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const [{ total } = { total: 0 }] = await scopedDb
      .select({
        total: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.workspaceId, input.workspaceId),
          eq(schema.usageEvents.eventType, input.eventType),
          gte(schema.usageEvents.occurredAt, input.since),
          lt(schema.usageEvents.occurredAt, input.until),
        ),
      );
    return Number(total);
  });
}

async function sumUsageQuantityByBucket(
  db: Database,
  input: {
    workspaceId: string;
    eventType: string;
    since: Date;
    until: Date;
  },
  granularity: "day" | "hour",
): Promise<Map<string, number>> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const bucket =
      granularity === "hour"
        ? sql<string>`to_char(date_trunc('hour', ${schema.usageEvents.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00')`
        : sql<string>`to_char(date_trunc('day', ${schema.usageEvents.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const bucketGroup =
      granularity === "hour"
        ? sql`date_trunc('hour', ${schema.usageEvents.occurredAt} at time zone 'UTC')`
        : sql`date_trunc('day', ${schema.usageEvents.occurredAt} at time zone 'UTC')`;
    const rows = await scopedDb
      .select({
        bucket,
        total: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.workspaceId, input.workspaceId),
          eq(schema.usageEvents.eventType, input.eventType),
          gte(schema.usageEvents.occurredAt, input.since),
          lt(schema.usageEvents.occurredAt, input.until),
        ),
      )
      .groupBy(bucketGroup);
    return new Map(rows.map((row) => [row.bucket, Number(row.total)]));
  });
}

export async function sumUsageQuantityByDay(
  db: Database,
  input: {
    workspaceId: string;
    eventType: string;
    since: Date;
    until: Date;
  },
): Promise<Map<string, number>> {
  return await sumUsageQuantityByBucket(db, input, "day");
}

export async function sumUsageQuantityByHour(
  db: Database,
  input: {
    workspaceId: string;
    eventType: string;
    since: Date;
    until: Date;
  },
): Promise<Map<string, number>> {
  return await sumUsageQuantityByBucket(db, input, "hour");
}

export async function aggregateModelCallFacts(
  db: Database,
  input: {
    workspaceId: string;
    since: Date;
    until: Date;
    provider?: string | null;
    model?: string | null;
  },
): Promise<ModelCallFactAggregateRow[]> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.modelCallFacts.workspaceId, input.workspaceId),
      gte(schema.modelCallFacts.occurredAt, input.since),
      lt(schema.modelCallFacts.occurredAt, input.until),
      ...(input.provider ? [eq(schema.modelCallFacts.provider, input.provider)] : []),
      ...(input.model ? [eq(schema.modelCallFacts.model, input.model)] : []),
    ];
    const rows = await scopedDb
      .select({
        provider: schema.modelCallFacts.provider,
        model: schema.modelCallFacts.model,
        billingPath: schema.modelCallFacts.billingPath,
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.outputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.cachedTokens}), 0)`,
        cacheInputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.inputTokens}) filter (where ${schema.modelCallFacts.cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.cacheWriteTokens}), 0)`,
        reasoningTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.reasoningTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.totalTokens}), 0)`,
        tokenKnownCalls: sql<number>`count(${schema.modelCallFacts.totalTokens})::int`,
        cacheKnownCalls: sql<number>`count(*) filter (where ${schema.modelCallFacts.cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null)::int`,
        pricedCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.pricedCostMicros}) filter (where ${schema.modelCallFacts.billingPath} = 'opengeni_credits'), 0)`,
        estimatedProviderCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.estimatedProviderCostMicros}), 0)`,
        estimatedProviderCostKnownCalls: sql<number>`count(${schema.modelCallFacts.estimatedProviderCostMicros})::int`,
      })
      .from(schema.modelCallFacts)
      .where(and(...clauses))
      .groupBy(
        schema.modelCallFacts.provider,
        schema.modelCallFacts.model,
        schema.modelCallFacts.billingPath,
      );
    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      billingPath: row.billingPath,
      calls: Number(row.calls),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cachedTokens: Number(row.cachedTokens),
      cacheInputTokens: Number(row.cacheInputTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
      reasoningTokens: Number(row.reasoningTokens),
      totalTokens: Number(row.totalTokens),
      tokenKnownCalls: Number(row.tokenKnownCalls),
      cacheKnownCalls: Number(row.cacheKnownCalls),
      pricedCostMicros: Number(row.pricedCostMicros),
      estimatedProviderCostMicros: Number(row.estimatedProviderCostMicros),
      estimatedProviderCostKnownCalls: Number(row.estimatedProviderCostKnownCalls),
    }));
  });
}

type ModelCallFactSeriesAggregate = {
  costMicros: number;
  estimatedProviderCostMicros: number;
  estimatedProviderCostKnownCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  tokenKnownCalls: number;
  cacheKnownCalls: number;
  calls: number;
};

async function aggregateModelCallFactsByBucket(
  db: Database,
  input: {
    workspaceId: string;
    since: Date;
    until: Date;
    provider?: string | null;
    model?: string | null;
  },
  granularity: "day" | "hour",
): Promise<Map<string, ModelCallFactSeriesAggregate>> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.modelCallFacts.workspaceId, input.workspaceId),
      gte(schema.modelCallFacts.occurredAt, input.since),
      lt(schema.modelCallFacts.occurredAt, input.until),
      ...(input.provider ? [eq(schema.modelCallFacts.provider, input.provider)] : []),
      ...(input.model ? [eq(schema.modelCallFacts.model, input.model)] : []),
    ];
    const bucket =
      granularity === "hour"
        ? sql<string>`to_char(date_trunc('hour', ${schema.modelCallFacts.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00')`
        : sql<string>`to_char(date_trunc('day', ${schema.modelCallFacts.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const bucketGroup =
      granularity === "hour"
        ? sql`date_trunc('hour', ${schema.modelCallFacts.occurredAt} at time zone 'UTC')`
        : sql`date_trunc('day', ${schema.modelCallFacts.occurredAt} at time zone 'UTC')`;
    const rows = await scopedDb
      .select({
        bucket,
        costMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.pricedCostMicros}) filter (where ${schema.modelCallFacts.billingPath} = 'opengeni_credits'), 0)`,
        estimatedProviderCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.estimatedProviderCostMicros}), 0)`,
        estimatedProviderCostKnownCalls: sql<number>`count(${schema.modelCallFacts.estimatedProviderCostMicros})::int`,
        inputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.outputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.cachedTokens}), 0)`,
        cacheInputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.inputTokens}) filter (where ${schema.modelCallFacts.cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.cacheWriteTokens}), 0)`,
        reasoningTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.reasoningTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.totalTokens}), 0)`,
        tokenKnownCalls: sql<number>`count(${schema.modelCallFacts.totalTokens})::int`,
        cacheKnownCalls: sql<number>`count(*) filter (where ${schema.modelCallFacts.cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(schema.modelCallFacts)
      .where(and(...clauses))
      .groupBy(bucketGroup);
    return new Map(
      rows.map((row) => [
        row.bucket,
        {
          costMicros: Number(row.costMicros),
          estimatedProviderCostMicros: Number(row.estimatedProviderCostMicros),
          estimatedProviderCostKnownCalls: Number(row.estimatedProviderCostKnownCalls),
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
          cachedTokens: Number(row.cachedTokens),
          cacheInputTokens: Number(row.cacheInputTokens),
          cacheWriteTokens: Number(row.cacheWriteTokens),
          reasoningTokens: Number(row.reasoningTokens),
          totalTokens: Number(row.totalTokens),
          tokenKnownCalls: Number(row.tokenKnownCalls),
          cacheKnownCalls: Number(row.cacheKnownCalls),
          calls: Number(row.calls),
        },
      ]),
    );
  });
}

export async function aggregateModelCallFactsByDay(
  db: Database,
  input: {
    workspaceId: string;
    since: Date;
    until: Date;
    provider?: string | null;
    model?: string | null;
  },
): Promise<Map<string, ModelCallFactSeriesAggregate>> {
  return await aggregateModelCallFactsByBucket(db, input, "day");
}

export async function aggregateModelCallFactsByHour(
  db: Database,
  input: {
    workspaceId: string;
    since: Date;
    until: Date;
    provider?: string | null;
    model?: string | null;
  },
): Promise<Map<string, ModelCallFactSeriesAggregate>> {
  return await aggregateModelCallFactsByBucket(db, input, "hour");
}

export async function aggregateWarmSecondsByGroup(
  db: Database,
  input: InsightsTimeWindow & { workspaceId: string; limit?: number },
): Promise<WarmGroupAggregate[]> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  const limit = input.limit ?? 24;
  return await withRlsContext(db, context, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        groupId: sql<string>`split_part(${schema.usageEvents.sourceResourceId}, ':', 1)`,
        warmSeconds: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.workspaceId, input.workspaceId),
          eq(schema.usageEvents.eventType, "sandbox.warm_seconds"),
          gte(schema.usageEvents.occurredAt, input.since),
          lt(schema.usageEvents.occurredAt, input.until),
          sql`${schema.usageEvents.sourceResourceId} is not null`,
        ),
      )
      .groupBy(sql`split_part(${schema.usageEvents.sourceResourceId}, ':', 1)`)
      .orderBy(sql`coalesce(sum(${schema.usageEvents.quantity}), 0) desc`)
      .limit(Math.max(limit * 4, limit));
    return rows
      .filter((row) => UUID_RE.test(row.groupId))
      .slice(0, limit)
      .map((row) => ({
        groupId: row.groupId,
        warmSeconds: Number(row.warmSeconds),
      }));
  });
}

export async function listLiveWarmLeases(
  db: Database,
  workspaceId: string,
): Promise<LiveWarmLeaseRow[]> {
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        id: schema.sandboxLeases.id,
        groupId: schema.sandboxLeases.sandboxGroupId,
        backend: schema.sandboxLeases.backend,
        turnHolders: schema.sandboxLeases.turnHolders,
        viewerHolders: schema.sandboxLeases.viewerHolders,
        lastMeterAt: schema.sandboxLeases.lastMeterAt,
      })
      .from(schema.sandboxLeases)
      .where(
        and(
          eq(schema.sandboxLeases.workspaceId, workspaceId),
          // Only ready warm boxes — warming leases are not yet idle/usable compute.
          eq(schema.sandboxLeases.liveness, "warm"),
        ),
      )
      .orderBy(desc(schema.sandboxLeases.updatedAt));
    return rows.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      backend: row.backend,
      turnHolders: row.turnHolders,
      viewerHolders: row.viewerHolders,
      lastMeterAt: row.lastMeterAt,
    }));
  });
}

export async function countSessionsAttachedToGroups(
  db: Database,
  workspaceId: string,
  groupIds: string[],
): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        groupId: schema.sessions.sandboxGroupId,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          inArray(schema.sessions.sandboxGroupId, groupIds),
        ),
      )
      .groupBy(schema.sessions.sandboxGroupId);
    return new Map(
      rows
        .filter((row): row is { groupId: string; n: number } => typeof row.groupId === "string")
        .map((row) => [row.groupId, Number(row.n)]),
    );
  });
}

export async function aggregateRootSessionDrivers(
  db: Database,
  input: InsightsTimeWindow & {
    workspaceId: string;
    provider?: string | null;
    model?: string | null;
    rootSessionIds?: string[];
    limit?: number;
  },
): Promise<RootSessionDriverRow[]> {
  if (input.rootSessionIds && input.rootSessionIds.length === 0) return [];
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  const childSessions = alias(schema.sessions, "insight_child_sessions");
  const rootSessions = alias(schema.sessions, "insight_root_sessions");
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.modelCallFacts.workspaceId, input.workspaceId),
      gte(schema.modelCallFacts.occurredAt, input.since),
      lt(schema.modelCallFacts.occurredAt, input.until),
      ...(input.provider ? [eq(schema.modelCallFacts.provider, input.provider)] : []),
      ...(input.model ? [eq(schema.modelCallFacts.model, input.model)] : []),
      ...(input.rootSessionIds ? [inArray(childSessions.rootSessionId, input.rootSessionIds)] : []),
    ];
    const query = scopedDb
      .select({
        rootSessionId: childSessions.rootSessionId,
        title: rootSessions.title,
        pricedCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.pricedCostMicros}) filter (where ${schema.modelCallFacts.billingPath} = 'opengeni_credits'), 0)`,
        estimatedProviderCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.estimatedProviderCostMicros}), 0)`,
        estimatedProviderCostKnownCalls: sql<number>`count(${schema.modelCallFacts.estimatedProviderCostMicros})::int`,
        totalTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.totalTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.cachedTokens}), 0)`,
        cacheInputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.inputTokens}) filter (where ${schema.modelCallFacts.cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null), 0)`,
      })
      .from(schema.modelCallFacts)
      .innerJoin(
        childSessions,
        and(
          eq(childSessions.workspaceId, schema.modelCallFacts.workspaceId),
          eq(childSessions.id, schema.modelCallFacts.sessionId),
        ),
      )
      .leftJoin(
        rootSessions,
        and(
          eq(rootSessions.workspaceId, childSessions.workspaceId),
          eq(rootSessions.id, childSessions.rootSessionId),
        ),
      )
      .where(and(...clauses))
      .groupBy(childSessions.rootSessionId, rootSessions.title)
      .orderBy(sql`coalesce(sum(${schema.modelCallFacts.totalTokens}), 0) desc`);
    const rows = input.rootSessionIds ? await query : await query.limit(input.limit ?? 8);
    return rows.map((row) => ({
      rootSessionId: row.rootSessionId,
      title: row.title,
      pricedCostMicros: Number(row.pricedCostMicros),
      estimatedProviderCostMicros: Number(row.estimatedProviderCostMicros),
      estimatedProviderCostKnownCalls: Number(row.estimatedProviderCostKnownCalls),
      totalTokens: Number(row.totalTokens),
      cachedTokens: Number(row.cachedTokens),
      cacheInputTokens: Number(row.cacheInputTokens),
    }));
  });
}

export async function listModelCallFacets(
  db: Database,
  input: InsightsTimeWindow & { workspaceId: string },
): Promise<ModelCallFacetRow[]> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const rows = await scopedDb
      .selectDistinct({
        provider: schema.modelCallFacts.provider,
        model: schema.modelCallFacts.model,
      })
      .from(schema.modelCallFacts)
      .where(
        and(
          eq(schema.modelCallFacts.workspaceId, input.workspaceId),
          gte(schema.modelCallFacts.occurredAt, input.since),
          lt(schema.modelCallFacts.occurredAt, input.until),
        ),
      )
      .orderBy(schema.modelCallFacts.provider, schema.modelCallFacts.model)
      .limit(500);
    return rows;
  });
}

export async function listRecentModelCalls(
  db: Database,
  input: InsightsTimeWindow & {
    workspaceId: string;
    provider?: string | null;
    model?: string | null;
    limit?: number;
  },
): Promise<RecentModelCallRow[]> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  const factSessions = alias(schema.sessions, "insight_recent_fact_sessions");
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.modelCallFacts.workspaceId, input.workspaceId),
      gte(schema.modelCallFacts.occurredAt, input.since),
      lt(schema.modelCallFacts.occurredAt, input.until),
      ...(input.provider ? [eq(schema.modelCallFacts.provider, input.provider)] : []),
      ...(input.model ? [eq(schema.modelCallFacts.model, input.model)] : []),
    ];
    const rows = await scopedDb
      .select({
        id: schema.modelCallFacts.id,
        occurredAt: schema.modelCallFacts.occurredAt,
        recordedAt: schema.modelCallFacts.recordedAt,
        sessionId: schema.modelCallFacts.sessionId,
        sessionTitle: factSessions.title,
        sessionDepth: factSessions.nestedAgentDepth,
        turnId: schema.modelCallFacts.turnId,
        provider: schema.modelCallFacts.provider,
        providerApi: schema.modelCallFacts.providerApi,
        model: schema.modelCallFacts.model,
        billingPath: schema.modelCallFacts.billingPath,
        inputTokens: schema.modelCallFacts.inputTokens,
        outputTokens: schema.modelCallFacts.outputTokens,
        cachedTokens: schema.modelCallFacts.cachedTokens,
        cacheWriteTokens: schema.modelCallFacts.cacheWriteTokens,
        reasoningTokens: schema.modelCallFacts.reasoningTokens,
        totalTokens: schema.modelCallFacts.totalTokens,
        pricedCostMicros: schema.modelCallFacts.pricedCostMicros,
        estimatedProviderCostMicros: schema.modelCallFacts.estimatedProviderCostMicros,
        pricingSource: schema.modelCallFacts.pricingSource,
      })
      .from(schema.modelCallFacts)
      .leftJoin(
        factSessions,
        and(
          eq(factSessions.workspaceId, schema.modelCallFacts.workspaceId),
          eq(factSessions.id, schema.modelCallFacts.sessionId),
        ),
      )
      .where(and(...clauses))
      .orderBy(desc(schema.modelCallFacts.occurredAt), desc(schema.modelCallFacts.id))
      .limit(Math.max(1, Math.min(input.limit ?? 50, 100)));
    return rows;
  });
}

export async function aggregateModelContextContributions(
  db: Database,
  input: InsightsTimeWindow & {
    workspaceId: string;
    provider?: string | null;
    model?: string | null;
  },
): Promise<ModelContextContributionAggregate> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.modelCallFacts.workspaceId, input.workspaceId),
      gte(schema.modelCallFacts.occurredAt, input.since),
      lt(schema.modelCallFacts.occurredAt, input.until),
      ...(input.provider ? [eq(schema.modelCallFacts.provider, input.provider)] : []),
      ...(input.model ? [eq(schema.modelCallFacts.model, input.model)] : []),
    ];
    type ContributionRow = {
      total_calls: number | string;
      covered_calls: number | string;
      source: string | null;
      items: number | string | null;
      utf8_bytes: number | string | null;
      estimated_tokens: number | string | null;
      calls: number | string | null;
    };
    const rows = (await scopedDb.execute(sql<ContributionRow>`
      with filtered as (
        select
          ${schema.modelCallFacts.id} as id,
          ${schema.modelCallFacts.contextContributions} as context_contributions
        from ${schema.modelCallFacts}
        where ${and(...clauses)}
      ), coverage as (
        select
          count(*)::bigint as total_calls,
          count(context_contributions)::bigint as covered_calls
        from filtered
      ), source_rows as (
        select
          filtered.id,
          contribution->>'source' as source,
          (contribution->>'items')::bigint as items,
          (contribution->>'utf8Bytes')::bigint as utf8_bytes,
          (contribution->>'estimatedTokens')::bigint as estimated_tokens
        from filtered
        cross join lateral jsonb_array_elements(filtered.context_contributions) contribution
      ), source_totals as (
        select
          source,
          sum(items)::bigint as items,
          sum(utf8_bytes)::bigint as utf8_bytes,
          sum(estimated_tokens)::bigint as estimated_tokens,
          count(distinct id)::bigint as calls
        from source_rows
        group by source
      )
      select
        coverage.total_calls,
        coverage.covered_calls,
        source_totals.source,
        source_totals.items,
        source_totals.utf8_bytes,
        source_totals.estimated_tokens,
        source_totals.calls
      from coverage
      left join source_totals on true
      order by source_totals.estimated_tokens desc nulls last, source_totals.source
    `)) as ContributionRow[];
    const first = rows[0];
    const sources = rows.flatMap((row) =>
      row.source
        ? [
            {
              source: row.source,
              items: Number(row.items ?? 0),
              utf8Bytes: Number(row.utf8_bytes ?? 0),
              estimatedTokens: Number(row.estimated_tokens ?? 0),
              calls: Number(row.calls ?? 0),
            },
          ]
        : [],
    );
    return {
      estimatedTokens: sources.reduce((sum, row) => sum + row.estimatedTokens, 0),
      utf8Bytes: sources.reduce((sum, row) => sum + row.utf8Bytes, 0),
      coveredCalls: Number(first?.covered_calls ?? 0),
      totalCalls: Number(first?.total_calls ?? 0),
      sources,
    };
  });
}

export async function aggregateScheduleFacts(
  db: Database,
  input: InsightsTimeWindow & {
    workspaceId: string;
    provider?: string | null;
    model?: string | null;
  },
): Promise<ScheduleFactAggregate[]> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.modelCallFacts.workspaceId, input.workspaceId),
      gte(schema.modelCallFacts.occurredAt, input.since),
      lt(schema.modelCallFacts.occurredAt, input.until),
      sql`${schema.modelCallFacts.scheduledTaskId} is not null`,
      ...(input.provider ? [eq(schema.modelCallFacts.provider, input.provider)] : []),
      ...(input.model ? [eq(schema.modelCallFacts.model, input.model)] : []),
    ];
    const rows = await scopedDb
      .select({
        scheduledTaskId: schema.modelCallFacts.scheduledTaskId,
        pricedCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.pricedCostMicros}) filter (where ${schema.modelCallFacts.billingPath} = 'opengeni_credits'), 0)`,
        estimatedProviderCostMicros: sql<number>`coalesce(sum(${schema.modelCallFacts.estimatedProviderCostMicros}), 0)`,
        estimatedProviderCostKnownCalls: sql<number>`count(${schema.modelCallFacts.estimatedProviderCostMicros})::int`,
        totalTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.totalTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.cachedTokens}), 0)`,
        cacheInputTokens: sql<number>`coalesce(sum(${schema.modelCallFacts.inputTokens}) filter (where ${schema.modelCallFacts.cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null), 0)`,
        calls: sql<number>`count(*)::int`,
        billingPath: sql<string>`case
          when bool_or(${schema.modelCallFacts.billingPath} = 'opengeni_credits')
          then 'opengeni_credits'
          else 'external'
        end`,
      })
      .from(schema.modelCallFacts)
      .where(and(...clauses))
      .groupBy(schema.modelCallFacts.scheduledTaskId);
    return rows
      .filter((row): row is typeof row & { scheduledTaskId: string } => row.scheduledTaskId != null)
      .map((row) => ({
        scheduledTaskId: row.scheduledTaskId,
        pricedCostMicros: Number(row.pricedCostMicros),
        estimatedProviderCostMicros: Number(row.estimatedProviderCostMicros),
        estimatedProviderCostKnownCalls: Number(row.estimatedProviderCostKnownCalls),
        totalTokens: Number(row.totalTokens),
        cachedTokens: Number(row.cachedTokens),
        cacheInputTokens: Number(row.cacheInputTokens),
        calls: Number(row.calls),
        billingPath: row.billingPath,
      }));
  });
}

export async function countScheduledTaskFires(
  db: Database,
  input: InsightsTimeWindow & { workspaceId: string; taskIds: string[] },
): Promise<Map<string, number>> {
  if (input.taskIds.length === 0) return new Map();
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        taskId: schema.scheduledTaskRuns.taskId,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.scheduledTaskRuns)
      .where(
        and(
          eq(schema.scheduledTaskRuns.workspaceId, input.workspaceId),
          inArray(schema.scheduledTaskRuns.taskId, input.taskIds),
          gte(schema.scheduledTaskRuns.createdAt, input.since),
          lt(schema.scheduledTaskRuns.createdAt, input.until),
        ),
      )
      .groupBy(schema.scheduledTaskRuns.taskId);
    return new Map(rows.map((row) => [row.taskId, Number(row.n)]));
  });
}

export async function aggregateSessionDepth(
  db: Database,
  workspaceId: string,
): Promise<{
  buckets: SessionDepthAggregate[];
  sessionsTouched: number;
  rootSessions: number;
  deepestDepth: number;
  deepestSessionId: string | null;
  deepestSessionTitle: string;
  avgDepth: number;
  goalsActive: number;
  goalsCompleted: number;
}> {
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const buckets = await scopedDb
      .select({
        depth: schema.sessions.nestedAgentDepth,
        sessions: sql<number>`count(*)::int`,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, workspaceId))
      .groupBy(schema.sessions.nestedAgentDepth)
      .orderBy(schema.sessions.nestedAgentDepth);
    const [stats] = await scopedDb
      .select({
        sessionsTouched: sql<number>`count(*)::int`,
        rootSessions: sql<number>`count(*) filter (where ${schema.sessions.nestedAgentDepth} = 0)::int`,
        deepestDepth: sql<number>`coalesce(max(${schema.sessions.nestedAgentDepth}), 0)`,
        avgDepth: sql<number>`coalesce(avg(${schema.sessions.nestedAgentDepth}), 0)`,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, workspaceId));
    const [deepest] = await scopedDb
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        depth: schema.sessions.nestedAgentDepth,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, workspaceId))
      .orderBy(desc(schema.sessions.nestedAgentDepth), desc(schema.sessions.updatedAt))
      .limit(1);
    const [goals] = await scopedDb
      .select({
        active: sql<number>`count(*) filter (where ${schema.sessionGoals.status} = 'active')::int`,
        completed: sql<number>`count(*) filter (where ${schema.sessionGoals.status} = 'completed')::int`,
      })
      .from(schema.sessionGoals)
      .where(eq(schema.sessionGoals.workspaceId, workspaceId));
    return {
      buckets: buckets.map((row) => ({
        depth: row.depth,
        sessions: Number(row.sessions),
      })),
      sessionsTouched: Number(stats?.sessionsTouched ?? 0),
      rootSessions: Number(stats?.rootSessions ?? 0),
      deepestDepth: Number(stats?.deepestDepth ?? 0),
      deepestSessionId: deepest?.id ?? null,
      deepestSessionTitle: deepest?.title?.trim() || "",
      avgDepth: Number(stats?.avgDepth ?? 0),
      goalsActive: Number(goals?.active ?? 0),
      goalsCompleted: Number(goals?.completed ?? 0),
    };
  });
}

export async function listFloorSessions(
  db: Database,
  workspaceId: string,
  limit = 24,
): Promise<FloorSessionRow[]> {
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        status: schema.sessions.status,
        directControlState: schema.sessions.directControlState,
        nestedAgentDepth: schema.sessions.nestedAgentDepth,
        model: schema.sessions.model,
        sandboxBackend: schema.sessions.sandboxBackend,
        updatedAt: schema.sessions.updatedAt,
        createdAt: schema.sessions.createdAt,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, workspaceId))
      .orderBy(desc(schema.sessions.updatedAt))
      .limit(limit);
    return rows;
  });
}

export async function countOnlineMachines(
  db: Database,
  workspaceId: string,
  heartbeatFreshMs: number,
  now = new Date(),
): Promise<number> {
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    const cutoff = new Date(now.getTime() - heartbeatFreshMs);
    const [{ n } = { n: 0 }] = await scopedDb
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.workspaceId, workspaceId),
          eq(schema.enrollments.status, "active"),
          gte(schema.enrollments.lastSeenAt, cutoff),
        ),
      );
    return Number(n);
  });
}

export function enumerateUtcDays(since: Date, until: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  );
  const end = until.getTime();
  while (cursor.getTime() < end) {
    days.push(dayKeyUtc(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function enumerateUtcHours(since: Date, until: Date): string[] {
  const hours: string[] = [];
  const cursor = new Date(since);
  cursor.setUTCMinutes(0, 0, 0);
  const end = until.getTime();
  while (cursor.getTime() < end) {
    hours.push(hourKeyUtc(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return hours;
}

/**
 * Idempotent YTD backfill from authoritative agent.model.usage into model_call_facts.
 * Never rewrites billing rows or existing live facts (onConflictDoNothing).
 * Commits in bounded batches so a long YTD run cannot pin one multi-hour txn.
 */
export async function backfillModelCallFactsFromSessionEvents(
  db: Database,
  input: {
    workspaceId: string;
    since: Date;
    until?: Date;
    limit?: number;
    batchSize?: number;
  },
): Promise<{ considered: number; upserted: number }> {
  const until = input.until ?? new Date();
  const limit = input.limit ?? 50_000;
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, limit));
  const context = await rlsContextForWorkspace(db, input.workspaceId);

  let considered = 0;
  let upserted = 0;
  let cursorOccurredAt = input.since;
  let cursorId = "00000000-0000-0000-0000-000000000000";

  while (considered < limit) {
    const remaining = limit - considered;
    const page = await withRlsContext(db, context, async (scopedDb) => {
      return await scopedDb
        .select({
          id: schema.sessionEvents.id,
          accountId: schema.sessionEvents.accountId,
          workspaceId: schema.sessionEvents.workspaceId,
          sessionId: schema.sessionEvents.sessionId,
          turnId: schema.sessionEvents.turnId,
          turnAttemptId: schema.sessionEvents.turnAttemptId,
          payload: schema.sessionEvents.payload,
          occurredAt: schema.sessionEvents.occurredAt,
        })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.type, "agent.model.usage"),
            eq(schema.sessionEvents.turnAssociation, "current"),
            lt(schema.sessionEvents.occurredAt, until),
            sql`${schema.sessionEvents.turnId} is not null`,
            // Keyset on (occurred_at, id) so same-millisecond bursts cannot be skipped.
            sql`(${schema.sessionEvents.occurredAt}, ${schema.sessionEvents.id}) > (${cursorOccurredAt}, ${cursorId}::uuid)`,
          ),
        )
        .orderBy(schema.sessionEvents.occurredAt, schema.sessionEvents.id)
        .limit(Math.min(batchSize, remaining));
    });
    if (page.length === 0) break;
    considered += page.length;
    const last = page[page.length - 1]!;
    cursorOccurredAt = last.occurredAt;
    cursorId = last.id;

    const batchUpserted = await withRlsContext(db, context, async (scopedDb) => {
      let inserted = 0;
      for (const event of page) {
        if (!event.turnId) continue;
        const payload =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : null;
        if (!payload) continue;
        const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey : null;
        const provider = typeof payload.provider === "string" ? payload.provider : null;
        const providerApi = typeof payload.providerApi === "string" ? payload.providerApi : null;
        const model = typeof payload.model === "string" ? payload.model : null;
        if (!sourceKey || !provider || !providerApi || !model) continue;

        const sourceResourceId = `${event.turnId}:${sourceKey}`;
        const [cost] = await scopedDb
          .select({ quantity: schema.usageEvents.quantity })
          .from(schema.usageEvents)
          .where(
            and(
              eq(schema.usageEvents.workspaceId, input.workspaceId),
              eq(schema.usageEvents.eventType, "model.cost"),
              eq(schema.usageEvents.sourceResourceId, sourceResourceId),
            ),
          )
          .limit(1);
        const [tokenRow] = await scopedDb
          .select({ id: schema.usageEvents.id })
          .from(schema.usageEvents)
          .where(
            and(
              eq(schema.usageEvents.workspaceId, input.workspaceId),
              eq(schema.usageEvents.eventType, "model.tokens"),
              eq(schema.usageEvents.sourceResourceId, sourceResourceId),
            ),
          )
          .limit(1);

        // External turns always write model.cost=0 and never model.tokens.
        // Credits turns with totalTokens=0 write neither — keep those as credits.
        const pricedCostMicros = cost ? Number(cost.quantity) : 0;
        const billingPath =
          cost != null && pricedCostMicros === 0 && !tokenRow ? "external" : "opengeni_credits";

        const [turn] = await scopedDb
          .select({
            source: schema.sessionTurns.source,
            initiatorKind: schema.sessionTurns.initiatorKind,
            initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
            initiatorContext: schema.sessionTurns.initiatorContext,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, event.turnId),
            ),
          )
          .limit(1);

        let scheduledTaskId: string | null = null;
        const runIds =
          turn?.initiatorContext &&
          typeof turn.initiatorContext === "object" &&
          !Array.isArray(turn.initiatorContext) &&
          Array.isArray((turn.initiatorContext as Record<string, unknown>).scheduledRunIds)
            ? (
                (turn.initiatorContext as Record<string, unknown>).scheduledRunIds as unknown[]
              ).filter((value): value is string => typeof value === "string")
            : [];
        if (runIds.length > 0) {
          const [run] = await scopedDb
            .select({ taskId: schema.scheduledTaskRuns.taskId })
            .from(schema.scheduledTaskRuns)
            .where(
              and(
                eq(schema.scheduledTaskRuns.workspaceId, input.workspaceId),
                inArray(schema.scheduledTaskRuns.id, runIds),
              ),
            )
            .orderBy(schema.scheduledTaskRuns.createdAt)
            .limit(1);
          scheduledTaskId = run?.taskId ?? null;
        }

        const insertedRows = await scopedDb
          .insert(schema.modelCallFacts)
          .values({
            accountId: event.accountId,
            workspaceId: event.workspaceId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            turnAttemptId: event.turnAttemptId,
            sourceKey,
            provider,
            providerApi,
            model,
            billingPath,
            turnSource: turn?.source ?? null,
            initiatorKind: turn?.initiatorKind ?? null,
            initiatorSubjectId: turn?.initiatorSubjectId ?? null,
            scheduledTaskId,
            inputTokens: numberOrNull(payload.inputTokens),
            outputTokens: numberOrNull(payload.outputTokens),
            cachedTokens: numberOrNull(payload.cachedTokens),
            cacheWriteTokens: numberOrNull(payload.cacheWriteTokens),
            reasoningTokens: numberOrNull(payload.reasoningTokens),
            totalTokens:
              numberOrNull(payload.inputTokens) !== null ||
              numberOrNull(payload.outputTokens) !== null
                ? (numberOrNull(payload.inputTokens) ?? 0) +
                  (numberOrNull(payload.outputTokens) ?? 0)
                : null,
            pricedCostMicros,
            occurredAt: event.occurredAt,
          })
          .onConflictDoNothing({
            target: [
              schema.modelCallFacts.workspaceId,
              schema.modelCallFacts.turnId,
              schema.modelCallFacts.sourceKey,
            ],
          })
          .returning({ id: schema.modelCallFacts.id });
        if (insertedRows.length > 0) inserted += 1;
      }
      return inserted;
    });
    upserted += batchUpserted;
    if (page.length < Math.min(batchSize, remaining)) break;
  }

  return { considered, upserted };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
