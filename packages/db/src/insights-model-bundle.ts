import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rlsContextForWorkspace, withRlsContext } from "./database";
import type {
  ModelCallFactAggregateRow,
  ModelCallFactSeriesAggregate,
  ModelCallFacetRow,
  ModelContextContributionAggregate,
  RecentModelCallRow,
  RootSessionDriverRow,
  ScheduleFactAggregate,
} from "./insights";

export type WorkspaceInsightsModelBundleInput = {
  workspaceId: string;
  since: Date;
  until: Date;
  priorSince: Date;
  priorUntil: Date;
  granularity: "day" | "hour";
  provider?: string | null;
  model?: string | null;
};

export type WorkspaceInsightsModelBundle = {
  modelRows: ModelCallFactAggregateRow[];
  priorModelRows: ModelCallFactAggregateRow[];
  factBuckets: Map<string, ModelCallFactSeriesAggregate>;
  rootDrivers: RootSessionDriverRow[];
  priorRootDrivers: RootSessionDriverRow[];
  scheduleFacts: ScheduleFactAggregate[];
  facets: ModelCallFacetRow[];
  recentCalls: RecentModelCallRow[];
  promptContributions: ModelContextContributionAggregate;
};

type RawBundleRow = { payload: unknown };
type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Insights model bundle ${label} is not an object`);
  }
  return value as JsonRecord;
}

function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`Insights model bundle ${label} is not an array`);
  }
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function stringValue(row: JsonRecord, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Insights model bundle ${key} is not a string`);
  }
  return value;
}

function nullableString(row: JsonRecord, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Insights model bundle ${key} is not nullable text`);
  }
  return value;
}

function numberValue(row: JsonRecord, key: string): number {
  const value = Number(row[key] ?? 0);
  if (!Number.isFinite(value)) {
    throw new Error(`Insights model bundle ${key} is not numeric`);
  }
  return value;
}

function nullableNumber(row: JsonRecord, key: string): number | null {
  if (row[key] === null || row[key] === undefined) return null;
  return numberValue(row, key);
}

function dateValue(row: JsonRecord, key: string): Date {
  const value = row[key];
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Insights model bundle ${key} is not a timestamp`);
  }
  return date;
}

function mapModelRows(value: unknown, label: string): ModelCallFactAggregateRow[] {
  return records(value, label).map((row) => ({
    provider: stringValue(row, "provider"),
    model: stringValue(row, "model"),
    billingPath: stringValue(row, "billingPath"),
    calls: numberValue(row, "calls"),
    inputTokens: numberValue(row, "inputTokens"),
    outputTokens: numberValue(row, "outputTokens"),
    cachedTokens: numberValue(row, "cachedTokens"),
    cacheInputTokens: numberValue(row, "cacheInputTokens"),
    cacheWriteTokens: numberValue(row, "cacheWriteTokens"),
    reasoningTokens: numberValue(row, "reasoningTokens"),
    totalTokens: numberValue(row, "totalTokens"),
    tokenKnownCalls: numberValue(row, "tokenKnownCalls"),
    cacheKnownCalls: numberValue(row, "cacheKnownCalls"),
    pricedCostMicros: numberValue(row, "pricedCostMicros"),
    estimatedProviderCostMicros: numberValue(row, "estimatedProviderCostMicros"),
    estimatedProviderCostKnownCalls: numberValue(row, "estimatedProviderCostKnownCalls"),
  }));
}

function mapRootRows(value: unknown, label: string): RootSessionDriverRow[] {
  return records(value, label).map((row) => ({
    rootSessionId: stringValue(row, "rootSessionId"),
    title: nullableString(row, "title"),
    pricedCostMicros: numberValue(row, "pricedCostMicros"),
    estimatedProviderCostMicros: numberValue(row, "estimatedProviderCostMicros"),
    estimatedProviderCostKnownCalls: numberValue(row, "estimatedProviderCostKnownCalls"),
    totalTokens: numberValue(row, "totalTokens"),
    cachedTokens: numberValue(row, "cachedTokens"),
    cacheInputTokens: numberValue(row, "cacheInputTokens"),
  }));
}

function mapBundle(value: unknown): WorkspaceInsightsModelBundle {
  const payload = record(value, "payload");
  const bucketRows = records(payload.factBuckets, "factBuckets");
  const contribution = record(payload.promptContributions, "promptContributions");
  const sources = records(contribution.sources, "promptContributions.sources").map((row) => ({
    source: stringValue(row, "source"),
    items: numberValue(row, "items"),
    utf8Bytes: numberValue(row, "utf8Bytes"),
    estimatedTokens: numberValue(row, "estimatedTokens"),
    calls: numberValue(row, "calls"),
  }));
  return {
    modelRows: mapModelRows(payload.modelRows, "modelRows"),
    priorModelRows: mapModelRows(payload.priorModelRows, "priorModelRows"),
    factBuckets: new Map(
      bucketRows.map((row) => [
        stringValue(row, "bucket"),
        {
          costMicros: numberValue(row, "costMicros"),
          estimatedProviderCostMicros: numberValue(row, "estimatedProviderCostMicros"),
          estimatedProviderCostKnownCalls: numberValue(row, "estimatedProviderCostKnownCalls"),
          inputTokens: numberValue(row, "inputTokens"),
          outputTokens: numberValue(row, "outputTokens"),
          cachedTokens: numberValue(row, "cachedTokens"),
          cacheInputTokens: numberValue(row, "cacheInputTokens"),
          cacheWriteTokens: numberValue(row, "cacheWriteTokens"),
          reasoningTokens: numberValue(row, "reasoningTokens"),
          totalTokens: numberValue(row, "totalTokens"),
          tokenKnownCalls: numberValue(row, "tokenKnownCalls"),
          cacheKnownCalls: numberValue(row, "cacheKnownCalls"),
          calls: numberValue(row, "calls"),
        },
      ]),
    ),
    rootDrivers: mapRootRows(payload.rootDrivers, "rootDrivers"),
    priorRootDrivers: mapRootRows(payload.priorRootDrivers, "priorRootDrivers"),
    scheduleFacts: records(payload.scheduleFacts, "scheduleFacts").map((row) => ({
      scheduledTaskId: stringValue(row, "scheduledTaskId"),
      pricedCostMicros: numberValue(row, "pricedCostMicros"),
      estimatedProviderCostMicros: numberValue(row, "estimatedProviderCostMicros"),
      estimatedProviderCostKnownCalls: numberValue(row, "estimatedProviderCostKnownCalls"),
      totalTokens: numberValue(row, "totalTokens"),
      cachedTokens: numberValue(row, "cachedTokens"),
      cacheInputTokens: numberValue(row, "cacheInputTokens"),
      calls: numberValue(row, "calls"),
      billingPath: stringValue(row, "billingPath"),
    })),
    facets: records(payload.facets, "facets").map((row) => ({
      provider: stringValue(row, "provider"),
      model: stringValue(row, "model"),
    })),
    recentCalls: records(payload.recentCalls, "recentCalls").map((row) => ({
      id: stringValue(row, "id"),
      occurredAt: dateValue(row, "occurredAt"),
      recordedAt: dateValue(row, "recordedAt"),
      sessionId: stringValue(row, "sessionId"),
      sessionTitle: nullableString(row, "sessionTitle"),
      sessionDepth: nullableNumber(row, "sessionDepth"),
      turnId: stringValue(row, "turnId"),
      provider: stringValue(row, "provider"),
      providerApi: stringValue(row, "providerApi"),
      model: stringValue(row, "model"),
      billingPath: stringValue(row, "billingPath"),
      inputTokens: nullableNumber(row, "inputTokens"),
      outputTokens: nullableNumber(row, "outputTokens"),
      cachedTokens: nullableNumber(row, "cachedTokens"),
      cacheWriteTokens: nullableNumber(row, "cacheWriteTokens"),
      reasoningTokens: nullableNumber(row, "reasoningTokens"),
      totalTokens: nullableNumber(row, "totalTokens"),
      pricedCostMicros: numberValue(row, "pricedCostMicros"),
      estimatedProviderCostMicros: nullableNumber(row, "estimatedProviderCostMicros"),
      pricingSource: nullableString(row, "pricingSource"),
    })),
    promptContributions: {
      estimatedTokens: numberValue(contribution, "estimatedTokens"),
      utf8Bytes: numberValue(contribution, "utf8Bytes"),
      coveredCalls: numberValue(contribution, "coveredCalls"),
      totalCalls: numberValue(contribution, "totalCalls"),
      sources,
    },
  };
}

/**
 * One bounded model-fact read for the Workspace Insights response. The two
 * materialized inputs are the exact current/prior UTC windows; every model
 * projection reuses them without reopening the audited visibility seam.
 */
export async function readWorkspaceInsightsModelBundle(
  db: Database,
  input: WorkspaceInsightsModelBundleInput,
): Promise<WorkspaceInsightsModelBundle> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  const bucket =
    input.granularity === "hour"
      ? sql`to_char(date_trunc('hour', fact.occurred_at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00')`
      : sql`to_char(date_trunc('day', fact.occurred_at at time zone 'UTC'), 'YYYY-MM-DD')`;
  return await withRlsContext(db, context, async (scopedDb) => {
    const [row] = await scopedDb.execute<RawBundleRow>(sql`
      with current_visible as materialized (
        select
          fact.*,
          (
            (${input.provider ?? null}::text is null or fact.provider = ${input.provider ?? null}::text)
            and (${input.model ?? null}::text is null or fact.model = ${input.model ?? null}::text)
          ) as selected
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId},
          ${input.since.toISOString()}::timestamp with time zone,
          ${input.until.toISOString()}::timestamp with time zone
        ) fact
      ), prior_visible as materialized (
        select
          fact.*,
          (
            (${input.provider ?? null}::text is null or fact.provider = ${input.provider ?? null}::text)
            and (${input.model ?? null}::text is null or fact.model = ${input.model ?? null}::text)
          ) as selected
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId},
          ${input.priorSince.toISOString()}::timestamp with time zone,
          ${input.priorUntil.toISOString()}::timestamp with time zone
        ) fact
      ), current_model_rows as (
        select
          fact.provider,
          fact.model,
          fact.billing_path,
          count(*)::bigint as calls,
          coalesce(sum(fact.input_tokens), 0)::bigint as input_tokens,
          coalesce(sum(fact.output_tokens), 0)::bigint as output_tokens,
          coalesce(sum(fact.cached_tokens), 0)::bigint as cached_tokens,
          coalesce(sum(fact.input_tokens) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          ), 0)::bigint as cache_input_tokens,
          coalesce(sum(fact.cache_write_tokens), 0)::bigint as cache_write_tokens,
          coalesce(sum(fact.reasoning_tokens), 0)::bigint as reasoning_tokens,
          coalesce(sum(fact.total_tokens), 0)::bigint as total_tokens,
          count(fact.total_tokens)::bigint as token_known_calls,
          count(*) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          )::bigint as cache_known_calls,
          coalesce(sum(fact.priced_cost_micros) filter (
            where fact.billing_path = 'opengeni_credits'
          ), 0)::bigint as priced_cost_micros,
          coalesce(sum(fact.estimated_provider_cost_micros), 0)::bigint
            as estimated_provider_cost_micros,
          count(fact.estimated_provider_cost_micros)::bigint
            as estimated_provider_cost_known_calls
        from current_visible fact
        where fact.selected
        group by fact.provider, fact.model, fact.billing_path
      ), prior_model_rows as (
        select
          fact.provider,
          fact.model,
          fact.billing_path,
          count(*)::bigint as calls,
          coalesce(sum(fact.input_tokens), 0)::bigint as input_tokens,
          coalesce(sum(fact.output_tokens), 0)::bigint as output_tokens,
          coalesce(sum(fact.cached_tokens), 0)::bigint as cached_tokens,
          coalesce(sum(fact.input_tokens) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          ), 0)::bigint as cache_input_tokens,
          coalesce(sum(fact.cache_write_tokens), 0)::bigint as cache_write_tokens,
          coalesce(sum(fact.reasoning_tokens), 0)::bigint as reasoning_tokens,
          coalesce(sum(fact.total_tokens), 0)::bigint as total_tokens,
          count(fact.total_tokens)::bigint as token_known_calls,
          count(*) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          )::bigint as cache_known_calls,
          coalesce(sum(fact.priced_cost_micros) filter (
            where fact.billing_path = 'opengeni_credits'
          ), 0)::bigint as priced_cost_micros,
          coalesce(sum(fact.estimated_provider_cost_micros), 0)::bigint
            as estimated_provider_cost_micros,
          count(fact.estimated_provider_cost_micros)::bigint
            as estimated_provider_cost_known_calls
        from prior_visible fact
        where fact.selected
        group by fact.provider, fact.model, fact.billing_path
      ), current_series_rows as (
        select
          ${bucket} as bucket,
          coalesce(sum(fact.priced_cost_micros) filter (
            where fact.billing_path = 'opengeni_credits'
          ), 0)::bigint as cost_micros,
          coalesce(sum(fact.estimated_provider_cost_micros), 0)::bigint
            as estimated_provider_cost_micros,
          count(fact.estimated_provider_cost_micros)::bigint
            as estimated_provider_cost_known_calls,
          coalesce(sum(fact.input_tokens), 0)::bigint as input_tokens,
          coalesce(sum(fact.output_tokens), 0)::bigint as output_tokens,
          coalesce(sum(fact.cached_tokens), 0)::bigint as cached_tokens,
          coalesce(sum(fact.input_tokens) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          ), 0)::bigint as cache_input_tokens,
          coalesce(sum(fact.cache_write_tokens), 0)::bigint as cache_write_tokens,
          coalesce(sum(fact.reasoning_tokens), 0)::bigint as reasoning_tokens,
          coalesce(sum(fact.total_tokens), 0)::bigint as total_tokens,
          count(fact.total_tokens)::bigint as token_known_calls,
          count(*) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          )::bigint as cache_known_calls,
          count(*)::bigint as calls
        from current_visible fact
        where fact.selected
        group by ${bucket}
      ), current_root_aggregates as (
        select
          child.root_session_id,
          root.title,
          coalesce(sum(fact.priced_cost_micros) filter (
            where fact.billing_path = 'opengeni_credits'
          ), 0)::bigint as priced_cost_micros,
          coalesce(sum(fact.estimated_provider_cost_micros), 0)::bigint
            as estimated_provider_cost_micros,
          count(fact.estimated_provider_cost_micros)::bigint
            as estimated_provider_cost_known_calls,
          coalesce(sum(fact.total_tokens), 0)::bigint as total_tokens,
          coalesce(sum(fact.cached_tokens), 0)::bigint as cached_tokens,
          coalesce(sum(fact.input_tokens) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          ), 0)::bigint as cache_input_tokens
        from current_visible fact
        inner join sessions child
          on child.workspace_id = fact.workspace_id and child.id = fact.session_id
        left join sessions root
          on root.workspace_id = child.workspace_id and root.id = child.root_session_id
        where fact.selected
        group by child.root_session_id, root.title
      ), current_root_rows as materialized (
        select *
        from current_root_aggregates
        order by total_tokens desc
        limit 8
      ), prior_root_rows as (
        select
          child.root_session_id,
          root.title,
          coalesce(sum(fact.priced_cost_micros) filter (
            where fact.billing_path = 'opengeni_credits'
          ), 0)::bigint as priced_cost_micros,
          coalesce(sum(fact.estimated_provider_cost_micros), 0)::bigint
            as estimated_provider_cost_micros,
          count(fact.estimated_provider_cost_micros)::bigint
            as estimated_provider_cost_known_calls,
          coalesce(sum(fact.total_tokens), 0)::bigint as total_tokens,
          coalesce(sum(fact.cached_tokens), 0)::bigint as cached_tokens,
          coalesce(sum(fact.input_tokens) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          ), 0)::bigint as cache_input_tokens
        from prior_visible fact
        inner join sessions child
          on child.workspace_id = fact.workspace_id and child.id = fact.session_id
        left join sessions root
          on root.workspace_id = child.workspace_id and root.id = child.root_session_id
        inner join current_root_rows selected_root
          on selected_root.root_session_id = child.root_session_id
        where fact.selected
        group by child.root_session_id, root.title
      ), schedule_rows as (
        select
          fact.scheduled_task_id,
          coalesce(sum(fact.priced_cost_micros) filter (
            where fact.billing_path = 'opengeni_credits'
          ), 0)::bigint as priced_cost_micros,
          coalesce(sum(fact.estimated_provider_cost_micros), 0)::bigint
            as estimated_provider_cost_micros,
          count(fact.estimated_provider_cost_micros)::bigint
            as estimated_provider_cost_known_calls,
          coalesce(sum(fact.total_tokens), 0)::bigint as total_tokens,
          coalesce(sum(fact.cached_tokens), 0)::bigint as cached_tokens,
          coalesce(sum(fact.input_tokens) filter (
            where fact.cached_tokens is not null and fact.input_tokens is not null
          ), 0)::bigint as cache_input_tokens,
          count(*)::bigint as calls,
          case when bool_or(fact.billing_path = 'opengeni_credits')
            then 'opengeni_credits' else 'external' end as billing_path
        from current_visible fact
        where fact.selected and fact.scheduled_task_id is not null
        group by fact.scheduled_task_id
      ), facet_rows as (
        select distinct fact.provider, fact.model
        from current_visible fact
        order by fact.provider, fact.model
        limit 500
      ), recent_rows as (
        select
          fact.id,
          fact.occurred_at,
          fact.recorded_at,
          fact.session_id,
          session.title as session_title,
          session.nested_agent_depth as session_depth,
          fact.turn_id,
          fact.provider,
          fact.provider_api,
          fact.model,
          fact.billing_path,
          fact.input_tokens,
          fact.output_tokens,
          fact.cached_tokens,
          fact.cache_write_tokens,
          fact.reasoning_tokens,
          fact.total_tokens,
          fact.priced_cost_micros,
          fact.estimated_provider_cost_micros,
          fact.pricing_source
        from current_visible fact
        left join sessions session
          on session.workspace_id = fact.workspace_id and session.id = fact.session_id
        where fact.selected
        order by fact.occurred_at desc, fact.id desc
        limit 50
      ), contribution_coverage as (
        select
          count(*)::bigint as total_calls,
          count(fact.context_contributions)::bigint as covered_calls
        from current_visible fact
        where fact.selected
      ), contribution_source_rows as (
        select
          fact.id,
          contribution->>'source' as source,
          (contribution->>'items')::bigint as items,
          (contribution->>'utf8Bytes')::bigint as utf8_bytes,
          (contribution->>'estimatedTokens')::bigint as estimated_tokens
        from current_visible fact
        cross join lateral jsonb_array_elements(fact.context_contributions) contribution
        where fact.selected
      ), contribution_rows as (
        select
          source,
          sum(items)::bigint as items,
          sum(utf8_bytes)::bigint as utf8_bytes,
          sum(estimated_tokens)::bigint as estimated_tokens,
          count(distinct id)::bigint as calls
        from contribution_source_rows
        group by source
      )
      select jsonb_build_object(
        'modelRows', coalesce((
          select jsonb_agg(jsonb_build_object(
            'provider', provider,
            'model', model,
            'billingPath', billing_path,
            'calls', calls,
            'inputTokens', input_tokens,
            'outputTokens', output_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens,
            'cacheWriteTokens', cache_write_tokens,
            'reasoningTokens', reasoning_tokens,
            'totalTokens', total_tokens,
            'tokenKnownCalls', token_known_calls,
            'cacheKnownCalls', cache_known_calls,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls
          ) order by provider, model, billing_path)
          from current_model_rows
        ), '[]'::jsonb),
        'priorModelRows', coalesce((
          select jsonb_agg(jsonb_build_object(
            'provider', provider,
            'model', model,
            'billingPath', billing_path,
            'calls', calls,
            'inputTokens', input_tokens,
            'outputTokens', output_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens,
            'cacheWriteTokens', cache_write_tokens,
            'reasoningTokens', reasoning_tokens,
            'totalTokens', total_tokens,
            'tokenKnownCalls', token_known_calls,
            'cacheKnownCalls', cache_known_calls,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls
          ) order by provider, model, billing_path)
          from prior_model_rows
        ), '[]'::jsonb),
        'factBuckets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'bucket', bucket,
            'costMicros', cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'inputTokens', input_tokens,
            'outputTokens', output_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens,
            'cacheWriteTokens', cache_write_tokens,
            'reasoningTokens', reasoning_tokens,
            'totalTokens', total_tokens,
            'tokenKnownCalls', token_known_calls,
            'cacheKnownCalls', cache_known_calls,
            'calls', calls
          ) order by bucket)
          from current_series_rows
        ), '[]'::jsonb),
        'rootDrivers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'rootSessionId', root_session_id,
            'title', title,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'totalTokens', total_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens
          ) order by total_tokens desc)
          from current_root_rows
        ), '[]'::jsonb),
        'priorRootDrivers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'rootSessionId', root_session_id,
            'title', title,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'totalTokens', total_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens
          ) order by total_tokens desc)
          from prior_root_rows
        ), '[]'::jsonb),
        'scheduleFacts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'scheduledTaskId', scheduled_task_id,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'totalTokens', total_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens,
            'calls', calls,
            'billingPath', billing_path
          ) order by scheduled_task_id)
          from schedule_rows
        ), '[]'::jsonb),
        'facets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'provider', provider,
            'model', model
          ) order by provider, model)
          from facet_rows
        ), '[]'::jsonb),
        'recentCalls', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', id,
            'occurredAt', occurred_at,
            'recordedAt', recorded_at,
            'sessionId', session_id,
            'sessionTitle', session_title,
            'sessionDepth', session_depth,
            'turnId', turn_id,
            'provider', provider,
            'providerApi', provider_api,
            'model', model,
            'billingPath', billing_path,
            'inputTokens', input_tokens,
            'outputTokens', output_tokens,
            'cachedTokens', cached_tokens,
            'cacheWriteTokens', cache_write_tokens,
            'reasoningTokens', reasoning_tokens,
            'totalTokens', total_tokens,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'pricingSource', pricing_source
          ) order by occurred_at desc, id desc)
          from recent_rows
        ), '[]'::jsonb),
        'promptContributions', jsonb_build_object(
          'estimatedTokens', coalesce((select sum(estimated_tokens) from contribution_rows), 0),
          'utf8Bytes', coalesce((select sum(utf8_bytes) from contribution_rows), 0),
          'coveredCalls', (select covered_calls from contribution_coverage),
          'totalCalls', (select total_calls from contribution_coverage),
          'sources', coalesce((
            select jsonb_agg(jsonb_build_object(
              'source', source,
              'items', items,
              'utf8Bytes', utf8_bytes,
              'estimatedTokens', estimated_tokens,
              'calls', calls
            ) order by estimated_tokens desc nulls last, source)
            from contribution_rows
          ), '[]'::jsonb)
        )
      ) as payload
    `);
    if (!row) {
      throw new Error("Insights model bundle query returned no row");
    }
    return mapBundle(row.payload);
  });
}
