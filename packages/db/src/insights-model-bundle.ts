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
  rootSessionId?: string | null;
  sessionId?: string | null;
};

export const INSIGHTS_ROOT_DRIVER_LIMIT = 8;
export const INSIGHTS_FACET_LIMIT = 500;
export const INSIGHTS_RECENT_CALL_LIMIT = 50;

export type WorkspaceInsightsModelBundle = {
  /** Newest `recorded_at` among visible facts in the unfiltered current window. */
  dataThrough: Date | null;
  /** Distinct root-session groups before the driver limit is applied. */
  driverGroups: number;
  driversTruncated: boolean;
  facetsTruncated: boolean;
  recentCallsTruncated: boolean;
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
  const raw = row[key];
  if (
    (typeof raw !== "number" && typeof raw !== "string") ||
    (typeof raw === "string" && raw.trim().length === 0)
  ) {
    throw new Error(`Insights model bundle ${key} is not numeric`);
  }
  const value = Number(raw);
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
    equivalentCreditCostMicros: numberValue(row, "equivalentCreditCostMicros"),
    equivalentCreditCostKnownCalls: numberValue(row, "equivalentCreditCostKnownCalls"),
  }));
}

function mapRootRows(value: unknown, label: string): RootSessionDriverRow[] {
  return records(value, label).map((row) => ({
    rootSessionId: stringValue(row, "rootSessionId"),
    title: nullableString(row, "title"),
    pricedCostMicros: numberValue(row, "pricedCostMicros"),
    estimatedProviderCostMicros: numberValue(row, "estimatedProviderCostMicros"),
    estimatedProviderCostKnownCalls: numberValue(row, "estimatedProviderCostKnownCalls"),
    equivalentCreditCostMicros: numberValue(row, "equivalentCreditCostMicros"),
    equivalentCreditCostKnownCalls: numberValue(row, "equivalentCreditCostKnownCalls"),
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
    dataThrough:
      payload.dataThrough === null || payload.dataThrough === undefined
        ? null
        : dateValue(payload, "dataThrough"),
    driverGroups: numberValue(payload, "driverGroups"),
    driversTruncated: payload.driversTruncated === true,
    facetsTruncated: payload.facetsTruncated === true,
    recentCallsTruncated: payload.recentCallsTruncated === true,
    modelRows: mapModelRows(payload.modelRows, "modelRows"),
    priorModelRows: mapModelRows(payload.priorModelRows, "priorModelRows"),
    factBuckets: new Map(
      bucketRows.map((row) => [
        stringValue(row, "bucket"),
        {
          costMicros: numberValue(row, "costMicros"),
          estimatedProviderCostMicros: numberValue(row, "estimatedProviderCostMicros"),
          estimatedProviderCostKnownCalls: numberValue(row, "estimatedProviderCostKnownCalls"),
          equivalentCreditCostMicros: numberValue(row, "equivalentCreditCostMicros"),
          equivalentCreditCostKnownCalls: numberValue(row, "equivalentCreditCostKnownCalls"),
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
      equivalentCreditCostMicros: numberValue(row, "equivalentCreditCostMicros"),
      equivalentCreditCostKnownCalls: numberValue(row, "equivalentCreditCostKnownCalls"),
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
      equivalentCreditCostMicros: nullableNumber(row, "equivalentCreditCostMicros"),
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
 * One bounded model-fact query for the Workspace Insights response. Each UTC
 * window is read once through the narrow scoped projection (migration 0519) and
 * aggregated in one grouping-sets pass. A filtered or session-scoped request adds
 * one unfiltered current-window read because facets and the freshness watermark
 * are deliberately workspace-wide; an unfiltered request reuses current_visible.
 * Every bounded list reads one row past its limit so truncation is reported
 * rather than silent.
 */
export async function readWorkspaceInsightsModelBundle(
  db: Database,
  input: WorkspaceInsightsModelBundleInput,
): Promise<WorkspaceInsightsModelBundle> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  // Group on the truncated timestamp; format only the grouped buckets.
  const unit = input.granularity === "hour" ? sql`'hour'` : sql`'day'`;
  const bucket = sql`date_trunc(${unit}, fact.occurred_at at time zone 'UTC')`;
  const bucketLabel =
    input.granularity === "hour"
      ? sql`to_char(bucket, 'YYYY-MM-DD"T"HH24:00')`
      : sql`to_char(bucket, 'YYYY-MM-DD')`;
  const provider = input.provider ?? null;
  const model = input.model ?? null;
  const rootSessionId = input.rootSessionId ?? null;
  const sessionId = input.sessionId ?? null;
  const narrowed = provider != null || model != null || rootSessionId != null || sessionId != null;
  const factRows = (since: Date, until: Date, scoped: boolean) => sql`
    opengeni_private.visible_workspace_insights_model_fact_rows(
      ${input.workspaceId}::uuid,
      ${since.toISOString()}::timestamp with time zone,
      ${until.toISOString()}::timestamp with time zone,
      ${scoped ? provider : null}::text,
      ${scoped ? model : null}::text,
      ${scoped ? rootSessionId : null}::uuid,
      ${scoped ? sessionId : null}::uuid
    )`;
  // Facets and freshness are workspace-wide. Unnarrowed, the grouped pass already
  // holds every (provider, model) and the newest recorded_at; narrowed, they need
  // one unscoped read of the same window.
  const workspaceCurrentSource = narrowed
    ? sql`select fact.provider, fact.model, max(fact.recorded_at) as recorded_at
        from ${factRows(input.since, input.until, false)} fact
        group by fact.provider, fact.model`
    : sql`select provider, model, max(data_through) as recorded_at
        from current_grouped
        where by_model
        group by provider, model`;
  const sums = sql`
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
            as estimated_provider_cost_known_calls,
          coalesce(sum(fact.equivalent_credit_cost_micros), 0)::bigint
            as equivalent_credit_cost_micros,
          count(fact.equivalent_credit_cost_micros)::bigint
            as equivalent_credit_cost_known_calls,
          count(*)::bigint as calls,
          count(fact.context_contributions)::bigint as covered_calls,
          max(fact.recorded_at) as data_through`;
  const modelRowJson = sql`jsonb_build_object(
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
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'equivalentCreditCostMicros', equivalent_credit_cost_micros,
            'equivalentCreditCostKnownCalls', equivalent_credit_cost_known_calls
          )`;
  const rootRowJson = sql`jsonb_build_object(
            'rootSessionId', root_session_id,
            'title', title,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'equivalentCreditCostMicros', equivalent_credit_cost_micros,
            'equivalentCreditCostKnownCalls', equivalent_credit_cost_known_calls,
            'totalTokens', total_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens
          )`;
  return await withRlsContext(db, context, async (scopedDb) => {
    // The grouping-sets passes hash a few thousand groups over up to ~1.5M rows;
    // the default 4MB budget makes the planner spill one set through a disk sort.
    await scopedDb.execute(sql`select set_config('work_mem', '64MB', true)`);
    const [row] = await scopedDb.execute<RawBundleRow>(sql`
      with current_visible as materialized (
        select fact.*, ${bucket} as bucket
        from ${factRows(input.since, input.until, true)} fact
      ), prior_visible as materialized (
        select
          fact.root_session_id,
          fact.provider,
          fact.model,
          fact.billing_path,
          fact.scheduled_task_id,
          fact.input_tokens,
          fact.output_tokens,
          fact.cached_tokens,
          fact.cache_write_tokens,
          fact.reasoning_tokens,
          fact.total_tokens,
          fact.priced_cost_micros,
          fact.estimated_provider_cost_micros,
          fact.equivalent_credit_cost_micros,
          null::jsonb as context_contributions,
          fact.recorded_at
        from ${factRows(input.priorSince, input.priorUntil, true)} fact
      ), current_grouped as materialized (
        select
          grouping(fact.provider, fact.model, fact.billing_path) = 0 as by_model,
          grouping(fact.bucket) = 0 as by_bucket,
          grouping(fact.root_session_id) = 0 as by_root,
          grouping(fact.scheduled_task_id) = 0 as by_schedule,
          fact.provider,
          fact.model,
          fact.billing_path,
          fact.bucket,
          fact.root_session_id,
          fact.scheduled_task_id,
          ${sums},
          case when bool_or(fact.billing_path = 'opengeni_credits')
            then 'opengeni_credits' else 'external' end as schedule_billing_path
        from current_visible fact
        group by grouping sets (
          (fact.provider, fact.model, fact.billing_path),
          (fact.bucket),
          (fact.root_session_id),
          (fact.scheduled_task_id)
        )
      ), workspace_current as materialized (
        ${workspaceCurrentSource}
      ), prior_grouped as materialized (
        select
          grouping(fact.provider, fact.model, fact.billing_path) = 0 as by_model,
          fact.provider,
          fact.model,
          fact.billing_path,
          fact.root_session_id,
          ${sums}
        from prior_visible fact
        group by grouping sets (
          (fact.provider, fact.model, fact.billing_path),
          (fact.root_session_id)
        )
      ), current_root_aggregates as (
        select * from current_grouped where by_root
      ), current_root_rows as materialized (
        select
          aggregate.*,
          row_number() over (
            order by aggregate.total_tokens desc, aggregate.root_session_id
          ) as rn
        from (
          select *
          from current_root_aggregates
          order by total_tokens desc, root_session_id
          limit ${INSIGHTS_ROOT_DRIVER_LIMIT + 1}
        ) aggregate
      ), current_root_titled as (
        select current_root_rows.*, root.title
        from current_root_rows
        left join sessions root
          on root.workspace_id = ${input.workspaceId}::uuid
          and root.id = current_root_rows.root_session_id
      ), prior_root_rows as (
        select prior.*, root.title
        from prior_grouped prior
        inner join current_root_rows selected_root
          on selected_root.root_session_id = prior.root_session_id
          and selected_root.rn <= ${INSIGHTS_ROOT_DRIVER_LIMIT}
        left join sessions root
          on root.workspace_id = ${input.workspaceId}::uuid
          and root.id = prior.root_session_id
        where not prior.by_model
      ), facet_values as (
        select distinct fact.provider, fact.model
        from workspace_current fact
      ), facet_rows as (
        select facet.provider, facet.model
        from facet_values facet
        order by facet.provider, facet.model
        limit ${INSIGHTS_FACET_LIMIT + 1}
      ), recent_limited as (
        select fact.*
        from current_visible fact
        order by fact.occurred_at desc, fact.id desc
        limit ${INSIGHTS_RECENT_CALL_LIMIT + 1}
      ), recent_rows as (
        select
          fact.*,
          session.title as session_title,
          session.nested_agent_depth as session_depth,
          row_number() over (order by fact.occurred_at desc, fact.id desc) as rn
        from recent_limited fact
        left join sessions session
          on session.workspace_id = ${input.workspaceId}::uuid
          and session.id = fact.session_id
      ), contribution_coverage as (
        select
          coalesce(sum(calls), 0)::bigint as total_calls,
          coalesce(sum(covered_calls), 0)::bigint as covered_calls
        from current_grouped
        where by_model
      ), contribution_source_rows as (
        select
          contribution.entry->>'source' as source,
          (contribution.entry->>'items')::bigint as items,
          (contribution.entry->>'utf8Bytes')::bigint as utf8_bytes,
          (contribution.entry->>'estimatedTokens')::bigint as estimated_tokens,
          -- The validated CHECK rejects duplicate named sources. Its SQL NULL
          -- semantics still permit repeated null sources; count those only once
          -- per fact without sorting all contribution rows by raw fact ID.
          case when contribution.entry->>'source' is not null then true
            else not exists (
              select 1
              from jsonb_array_elements(fact.context_contributions)
                with ordinality earlier(entry, ordinal)
              where earlier.ordinal < contribution.ordinal
                and earlier.entry->>'source' is null
            )
          end as first_source
        from current_visible fact
        cross join lateral jsonb_array_elements(fact.context_contributions)
          with ordinality contribution(entry, ordinal)
        where fact.context_contributions is not null
      ), contribution_rows as (
        select
          source,
          sum(items)::bigint as items,
          sum(utf8_bytes)::bigint as utf8_bytes,
          sum(estimated_tokens)::bigint as estimated_tokens,
          count(*) filter (where first_source)::bigint as calls
        from contribution_source_rows
        group by source
      )
      select jsonb_build_object(
        'modelRows', coalesce((
          select jsonb_agg(${modelRowJson} order by provider, model, billing_path)
          from current_grouped where by_model
        ), '[]'::jsonb),
        'priorModelRows', coalesce((
          select jsonb_agg(${modelRowJson} order by provider, model, billing_path)
          from prior_grouped where by_model
        ), '[]'::jsonb),
        'factBuckets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'bucket', ${bucketLabel},
            'costMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'equivalentCreditCostMicros', equivalent_credit_cost_micros,
            'equivalentCreditCostKnownCalls', equivalent_credit_cost_known_calls,
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
          from current_grouped where by_bucket
        ), '[]'::jsonb),
        'rootDrivers', coalesce((
          select jsonb_agg(${rootRowJson} order by total_tokens desc, root_session_id)
          from current_root_titled
          where rn <= ${INSIGHTS_ROOT_DRIVER_LIMIT}
        ), '[]'::jsonb),
        'priorRootDrivers', coalesce((
          select jsonb_agg(${rootRowJson} order by total_tokens desc, root_session_id)
          from prior_root_rows
        ), '[]'::jsonb),
        'scheduleFacts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'scheduledTaskId', scheduled_task_id,
            'pricedCostMicros', priced_cost_micros,
            'estimatedProviderCostMicros', estimated_provider_cost_micros,
            'estimatedProviderCostKnownCalls', estimated_provider_cost_known_calls,
            'equivalentCreditCostMicros', equivalent_credit_cost_micros,
            'equivalentCreditCostKnownCalls', equivalent_credit_cost_known_calls,
            'totalTokens', total_tokens,
            'cachedTokens', cached_tokens,
            'cacheInputTokens', cache_input_tokens,
            'calls', calls,
            'billingPath', schedule_billing_path
          ) order by scheduled_task_id)
          from current_grouped
          where by_schedule and scheduled_task_id is not null
        ), '[]'::jsonb),
        'facets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'provider', provider,
            'model', model
          ) order by provider, model)
          from (
            select * from facet_rows
            order by provider, model
            limit ${INSIGHTS_FACET_LIMIT}
          ) facet
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
            'equivalentCreditCostMicros', equivalent_credit_cost_micros,
            'pricingSource', pricing_source
          ) order by occurred_at desc, id desc)
          from recent_rows
          where rn <= ${INSIGHTS_RECENT_CALL_LIMIT}
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
        ),
        'driverGroups', (select count(*) from current_root_aggregates),
        'driversTruncated', (select count(*) > ${INSIGHTS_ROOT_DRIVER_LIMIT} from current_root_rows),
        'facetsTruncated', (select count(*) > ${INSIGHTS_FACET_LIMIT} from facet_rows),
        'recentCallsTruncated', (select count(*) > ${INSIGHTS_RECENT_CALL_LIMIT} from recent_limited),
        'dataThrough', (select max(recorded_at) from workspace_current)
      ) as payload
    `);
    if (!row) {
      throw new Error("Insights model bundle query returned no row");
    }
    return mapBundle(row.payload);
  });
}
