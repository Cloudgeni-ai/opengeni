import { createHash } from "node:crypto";
import type {
  InsightsCall,
  InsightsCallsQuery,
  InsightsCallsResponse,
  InsightsUsageQuery,
  InsightsUsageRange,
  InsightsUsageResponse,
} from "@opengeni/contracts/insights-usage";
import { sql, type SQL } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";

type Scope = {
  accountId: string;
  workspaceId: string | null;
  now: Date;
  /** Internal, authenticated sessions:read authority supplied by Core; not wire query fields. */
  detailsWorkspaceIds?: readonly string[];
  /** Only the existing account-scoped API-key authority proof may establish this. */
  detailsSharedWorkspaces?: boolean;
};

/** UTC calendar windows; rolling ranges include today and the preceding N-1 days. */
export function insightsUsageWindow(range: InsightsUsageRange, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid Insights clock");
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === "week") since.setUTCDate(since.getUTCDate() - 6);
  if (range === "30d") since.setUTCDate(since.getUTCDate() - 29);
  if (range === "90d") since.setUTCDate(since.getUTCDate() - 89);
  if (range === "month") since.setUTCDate(1);
  if (range === "ytd") since.setUTCMonth(0, 1);
  const until = new Date(now);
  const duration = until.getTime() - since.getTime();
  return {
    since,
    until,
    priorSince: new Date(since.getTime() - duration),
    priorUntil: new Date(since),
    bucket: range === "today" ? ("hour" as const) : ("day" as const),
  };
}

function numericTree(value: unknown): void {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Insights quantity exceeds the exact non-negative wire range");
  }
  if (Array.isArray(value)) for (const item of value) numericTree(item);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) numericTree(item);
  }
}

function rows<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: unknown[] }).rows) as T[];
}

function sum(field: string, payer?: string): SQL {
  const selected = sql`(payload->'m'->>${field})::bigint`;
  return payer === undefined
    ? sql`coalesce(sum(${selected}),0)`
    : sql`coalesce(sum(${selected}) filter(where payload->>'payer'=${payer}),0)`;
}

function tokens(): SQL {
  return sql`jsonb_build_object('uncachedInput',${sum("uncachedInput")},'cacheRead',${sum("cacheRead")},
    'cacheWrite',${sum("cacheWrite")},'output',${sum("output")},'reasoning',${sum("reasoning")})`;
}

function payers(): SQL {
  const triplet = (payer: string) => sql`jsonb_build_object('calls',${sum("calls", payer)},
    'chargedMicros',${sum("chargedMicros", payer)},'listMicros',${sum("listMicros", payer)})`;
  return sql`jsonb_build_object('opengeni_credits',${triplet("opengeni_credits")},
    'subscription',${triplet("subscription")},'own_key',${triplet("own_key")})`;
}

function measures(): SQL {
  return sql`jsonb_build_object('calls',${sum("calls")},'tokenKnownCalls',${sum("tokenKnownCalls")},
    'cacheKnownCalls',${sum("cacheKnownCalls")},'cacheWriteKnownCalls',${sum("cacheWriteKnownCalls")},
    'listClassKnownCalls',${sum("listClassKnownCalls")},'tokens',${tokens()},
    'chargedMicros',${sum("chargedMicros")},'listMicros',${sum("listMicros")},
    'pricedCalls',${sum("pricedCalls")},'byPayer',${payers()},
    'listByClassMicros',case when ${sum("listClassKnownCalls")}>0 then jsonb_build_object(
      'uncachedInput',${sum("listUncachedInput")},'cacheRead',${sum("listCacheRead")},
      'cacheWrite',${sum("listCacheWrite")},'output',${sum("listOutput")}) end,
    'listByClassApprox',${sum("listApproxCalls")}>0 or
      (${sum("listClassKnownCalls")}>0 and ${sum("listClassKnownCalls")}<${sum("pricedCalls")}))`;
}

function mini(): SQL {
  return sql`jsonb_build_object('calls',${sum("calls")},'tokens',${tokens()},
    'chargedMicros',${sum("chargedMicros")},'listMicros',${sum("listMicros")},'byPayer',${payers()})`;
}

function grouping(groupBy: InsightsUsageQuery["groupBy"]) {
  const key = {
    model: sql`payload->>'provider'||'/'||(payload->>'model')`,
    provider: sql`payload->>'provider'`,
    payer: sql`payload->>'payer'`,
    workspace: sql`payload->>'workspaceId'`,
    project: sql`coalesce(payload->>'projectId','unfiled')`,
    rootSession: sql`coalesce(payload->>'rootSessionId','deleted')`,
    person: sql`coalesce(payload->>'person','service')`,
    schedule: sql`coalesce(payload->>'scheduleId','service')`,
  }[groupBy];
  const label = {
    model: sql`payload->>'model'`,
    provider: sql`payload->>'provider'`,
    payer: sql`payload->>'payer'`,
    workspace: sql`payload->>'workspaceName'`,
    project: sql`coalesce(payload->>'projectName','Unfiled chats')`,
    rootSession: sql`coalesce(payload->>'rootTitle','Untitled chat')`,
    person: sql`coalesce(payload->>'personName','Service')`,
    schedule: sql`coalesce(payload->>'scheduleName',case when payload->>'scheduleId' is null then 'Interactive' else 'Unavailable schedule' end)`,
  }[groupBy];
  const normalKind =
    groupBy === "project"
      ? sql`case when payload->>'projectId' is null then 'unfiled' else 'item' end`
      : groupBy === "person" || groupBy === "schedule"
        ? sql`case when ${key}='service' then 'service' else 'item' end`
        : sql`'item'::text`;
  return {
    key: sql`case when payload->>'kind' in ('private','personal') then payload->>'kind'||':'||(payload->>'person')
      when payload->>'kind'<>'item' then payload->>'kind'||case when ${groupBy}='workspace' and payload->>'workspaceId' is not null then ':'||(payload->>'workspaceId') else '' end else (${normalKind})||':'||(${key}) end`,
    kind: sql`case when payload->>'kind'<>'item' then payload->>'kind' else ${normalKind} end`,
    label: sql`case payload->>'kind' when 'private' then coalesce(payload->>'personName','Private chats')
      when 'personal' then coalesce(payload->>'personName','Personal usage') when 'deleted' then 'Deleted chats'
      when 'restricted' then 'Restricted usage' when 'service' then 'Service' else ${label} end`,
  };
}

/** One shared read shape for workspace and organization routes; writable primary only. */
export async function readInsightsUsage(
  db: Database,
  input: Scope & { query: InsightsUsageQuery },
): Promise<InsightsUsageResponse> {
  const { query } = input;
  if (
    input.workspaceId !== null &&
    (query.groupBy === "workspace" || query.workspaceId !== undefined)
  ) {
    throw new Error("Workspace Insights does not accept organization grouping or filters");
  }
  const window = insightsUsageWindow(query.range, input.now);
  const group = grouping(query.groupBy);
  const queryJson = JSON.stringify(query);
  const details = sql`array[${sql.join(
    (input.detailsWorkspaceIds ?? []).map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
  const source = (
    since: Date,
    until: Date,
    bucket: "day" | "hour",
  ) => sql`opengeni_private.insights_scoped_usage_rows(
    ${input.accountId}::uuid,${input.workspaceId}::uuid,${since.toISOString()}::timestamptz,
    ${until.toISOString()}::timestamptz,${bucket}::text,${details},${input.detailsSharedWorkspaces === true}::boolean)`;
  const payload = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) => {
      await scoped.execute(
        sql`select set_config('statement_timeout','10s',true),set_config('jit','off',true)`,
      );
      const result = await scoped.execute(sql`
      with current_rows as materialized(select payload from ${source(window.since, window.until, window.bucket)}),
      prior_rows as materialized(select payload from ${source(window.priorSince, window.priorUntil, "day")}),
      filtered as materialized(select payload from current_rows where opengeni_private.insights_usage_filter(payload,${queryJson}::jsonb)),
      prior_filtered as materialized(select payload from prior_rows where opengeni_private.insights_usage_filter(payload,${queryJson}::jsonb)),
      categorized as materialized(select payload,${group.key} as key,${group.kind} as kind,${group.label} as label,
        date_trunc(${window.bucket},(payload->>'occurredAt')::timestamptz at time zone 'UTC') at time zone 'UTC' as bucket
        from filtered),
      group_rows as materialized(select key,max(kind) as kind,max(label) as label,${measures()} as measures,
        max(payload->>'provider') filter(where payload->>'kind'='item') as provider,
        max(payload->>'model') filter(where payload->>'kind'='item') as model,
        max(payload->>'workspaceId') as workspace_id,
        bool_or(coalesce((payload->>'you')::boolean,false)) as you
        from categorized group by key),
      ranked as materialized(select *,row_number() over(partition by kind in ('private','personal','deleted','restricted')
        order by (measures->>'chargedMicros')::bigint+(measures->>'listMicros')::bigint desc,
        (measures->>'calls')::bigint desc,key) as rank from group_rows),
      tail as materialized(select c.payload from categorized c join ranked r using(key)
        where r.kind not in ('private','personal','deleted','restricted') and r.rank>${query.limit}),
      selected_groups as (select key,kind,label,measures,provider,model,workspace_id,you from ranked
        where kind in ('private','personal','deleted','restricted') or rank<=${query.limit}
        union all select 'other','other','Other',${measures()},null,null,null,false from tail having count(*)>0),
      top_series as materialized(select key from group_rows order by
        (measures->>'chargedMicros')::bigint+(measures->>'listMicros')::bigint desc,(measures->>'calls')::bigint desc,key limit 6),
      mini_rows as (select bucket,case when key in(select key from top_series) then key else 'other' end as key,
        ${mini()} as measures from categorized group by bucket,case when key in(select key from top_series) then key else 'other' end),
      buckets as (select bucket,${measures()} as measures from categorized group by bucket),
      points as (select generate_series(date_trunc(${window.bucket},${window.since.toISOString()}::timestamptz at time zone 'UTC') at time zone 'UTC',
        ${window.until.toISOString()}::timestamptz-interval '1 microsecond',
        case when ${window.bucket}='hour' then interval '1 hour' else interval '1 day' end) as start),
      zero as(select ${measures()} as measures from filtered where false),
      visible as materialized(select payload from current_rows where payload->>'kind'='item')
      select jsonb_build_object(
        'totals',(select ${measures()} from filtered),
        'prior',(select case when ${sum("calls")}>0 or ${sum("chargedMicros")}>0 or ${sum("listMicros")}>0 then ${measures()} end from prior_filtered),
        'dataThrough',(select max((payload->>'recordedAt')::timestamptz) from visible),
        'groupCount',(select count(*) from group_rows),'groupsTruncated',exists(select 1 from tail),
        'groups',coalesce((select jsonb_agg(jsonb_build_object('key',key,'kind',kind,'label',label,'measures',measures)
          ||jsonb_strip_nulls(jsonb_build_object(
          'provider',case when ${query.groupBy} in ('model','provider') then provider end,
          'model',case when ${query.groupBy}='model' then model end,
          'workspaceId',case when ${query.groupBy}='workspace' then workspace_id end,
          'you',case when ${query.groupBy}='person' or kind='personal' then you end))
          order by (measures->>'chargedMicros')::bigint+(measures->>'listMicros')::bigint desc,key) from selected_groups),'[]'::jsonb),
        'series',coalesce((select jsonb_agg(jsonb_build_object('start',points.start,'measures',coalesce(buckets.measures,zero.measures))
          ||case when ${query.seriesGroups === true} then jsonb_build_object('groups',coalesce((select jsonb_object_agg(key,measures)
            from mini_rows where mini_rows.bucket=points.start),'{}'::jsonb)) else '{}'::jsonb end order by points.start)
          from points left join buckets on buckets.bucket=points.start cross join zero),'[]'::jsonb),
        'facets',jsonb_build_object(
          'workspaces',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'personal',personal) order by name,id)
            from(select payload->>'workspaceId' as id,max(payload->>'workspaceName') as name,bool_or(coalesce((payload->>'personal')::boolean,false)) as personal from visible group by payload->>'workspaceId') v),'[]'::jsonb),
          'providers',coalesce((select jsonb_agg(provider order by provider) from(select distinct payload->>'provider' as provider from visible) v),'[]'::jsonb),
          'models',coalesce((select jsonb_agg(jsonb_build_object('provider',provider,'model',model) order by provider,model)
            from(select distinct payload->>'provider' as provider,payload->>'model' as model from visible) v),'[]'::jsonb),
          'payers',coalesce((select jsonb_agg(payer order by payer) from(select distinct payload->>'payer' as payer from visible) v),'[]'::jsonb),
          'projects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id)
            from(select distinct payload->>'projectId' as id,payload->>'projectName' as name from visible where payload->>'projectId' is not null) v),'[]'::jsonb),
          'people',coalesce((select jsonb_agg(jsonb_build_object('key',key,'name',name,'you',you) order by key)
            from(select payload->>'person' as key,max(payload->>'personName') as name,bool_or(coalesce((payload->>'you')::boolean,false)) as you
              from visible where payload->>'person' is not null group by payload->>'person') v),'[]'::jsonb),
          'schedules',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id)
            from(select distinct payload->>'scheduleId' as id,payload->>'scheduleName' as name from visible where payload->>'scheduleId' is not null and payload->>'scheduleName' is not null) v),'[]'::jsonb))
      ) as payload`);
      return rows<{ payload: Record<string, unknown> }>(result)[0]!.payload;
    },
  );
  numericTree(payload);
  const series = payload.series as Array<{ start: string }>;
  for (const point of series) point.start = new Date(point.start).toISOString();
  return {
    ...payload,
    scope:
      input.workspaceId === null
        ? { kind: "organization", accountId: input.accountId, workspaceId: null }
        : { kind: "workspace", accountId: input.accountId, workspaceId: input.workspaceId },
    range: query.range,
    groupBy: query.groupBy,
    bucket: window.bucket,
    generatedAt: input.now.toISOString(),
    windowStart: window.since.toISOString(),
    windowEnd: window.until.toISOString(),
    priorWindowStart: window.priorSince.toISOString(),
    priorWindowEnd: window.priorUntil.toISOString(),
    dataThrough:
      payload.dataThrough === null ? null : new Date(payload.dataThrough as string).toISOString(),
  } as InsightsUsageResponse;
}

function cursorScope(input: Scope & { query: InsightsCallsQuery }): string {
  const { cursor: _, limit: __, ...filters } = input.query;
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.accountId,
        input.workspaceId,
        [...new Set(input.detailsWorkspaceIds ?? [])].sort(),
        input.detailsSharedWorkspaces === true,
        filters,
      ]),
    )
    .digest("hex");
}

export class InvalidInsightsCallsCursorError extends Error {
  constructor() {
    super("Invalid Insights calls cursor for this scope and filters");
    this.name = "InvalidInsightsCallsCursorError";
  }
}

/** Visible details only; cursor and all filters are inside the bounded raw read. */
export async function readInsightsCalls(
  db: Database,
  input: Scope & { query: InsightsCallsQuery },
): Promise<InsightsCallsResponse> {
  if (input.workspaceId !== null && input.query.workspaceId !== undefined)
    throw new Error("Workspace calls do not accept workspace filters");
  const window = insightsUsageWindow(input.query.range, input.now);
  const scope = cursorScope(input);
  const details = sql`array[${sql.join(
    (input.detailsWorkspaceIds ?? []).map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
  let cursorAt: string | null = null;
  let cursorId: string | null = null;
  if (input.query.cursor !== undefined) {
    try {
      if (input.query.cursor.length > 2048) throw new Error("cursor length");
      const value = JSON.parse(
        Buffer.from(input.query.cursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        value.v !== 1 ||
        value.scope !== scope ||
        typeof value.at !== "string" ||
        typeof value.id !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value.at) ||
        !Number.isFinite(Date.parse(value.at)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
      )
        throw new Error("cursor shape");
      cursorAt = value.at;
      cursorId = value.id;
    } catch {
      throw new InvalidInsightsCallsCursorError();
    }
  }
  const calls = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) => {
      await scoped.execute(
        sql`select set_config('statement_timeout','10s',true),set_config('jit','off',true)`,
      );
      const result =
        await scoped.execute(sql`select payload from opengeni_private.insights_scoped_calls_rows(
      ${input.accountId}::uuid,${input.workspaceId}::uuid,${window.since.toISOString()}::timestamptz,${window.until.toISOString()}::timestamptz,
      ${JSON.stringify(input.query)}::jsonb,${cursorAt}::timestamptz,${cursorId}::uuid,${input.query.limit + 1}::int,
      ${details},${input.detailsSharedWorkspaces === true}::boolean)
      order by (payload->>'occurredAt')::timestamptz desc,payload->>'id' desc limit ${input.query.limit + 1}`);
      return rows<{ payload: InsightsCall }>(result).map((row) => row.payload);
    },
  );
  numericTree(calls);
  const selected = calls.slice(0, input.query.limit);
  const last = selected.at(-1);
  const nextCursor =
    calls.length > input.query.limit && last
      ? Buffer.from(JSON.stringify({ v: 1, scope, at: last.occurredAt, id: last.id })).toString(
          "base64url",
        )
      : null;
  for (const call of selected) call.occurredAt = new Date(call.occurredAt).toISOString();
  return { calls: selected, nextCursor };
}
