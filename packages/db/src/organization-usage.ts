import {
  OrganizationUsageQuery,
  OrganizationUsageSummary,
  type OrganizationUsagePeriod,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { withAccountRls, type Database } from "./database";

/** Same UTC semantics as Insights: week is today and the previous six days. */
export function organizationUsageWindow(period: OrganizationUsagePeriod, now = new Date()) {
  const until = new Date(now);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "week") since.setUTCDate(since.getUTCDate() - 6);
  if (period === "month") since.setUTCDate(1);
  if (period === "ytd") since.setUTCMonth(0, 1);
  if (!Number.isFinite(until.getTime())) throw new Error("Invalid usage window");
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    granularity: period === "today" ? ("hour" as const) : ("day" as const),
  };
}

/**
 * One period scan, no event limit and no workspace request fanout. Use the
 * primary database: existing analytical authority writes transaction-local
 * capabilities and cannot safely be moved to a read replica. This additive
 * query retains ordinary tenant AND private-session RLS; it does not mint or
 * widen the workspace-specific Insights capability. Scalar RLS cost remains.
 */
export async function getOrganizationUsageSummary(
  db: Database,
  input: {
    accountId: string;
    period?: OrganizationUsagePeriod | undefined;
    afterWorkspaceId?: string | undefined;
  },
  now = new Date(),
): Promise<OrganizationUsageSummary> {
  const query = OrganizationUsageQuery.parse(input);
  const window = organizationUsageWindow(query.period, now);
  return await withAccountRls(db, input.accountId, async (scopedDb) => {
    // Fail visibly rather than allowing a large-account scan to occupy a pool
    // connection indefinitely. The setting is local to this transaction.
    await scopedDb.execute(sql`select set_config('statement_timeout', '10s', true)`);
    const result = await scopedDb.execute(sql`
      with visible as materialized (
        select workspace_id, event_type, unit, quantity,
          to_char(date_trunc(${window.granularity}, occurred_at at time zone 'UTC'),
            ${window.granularity === "hour" ? 'YYYY-MM-DD"T"HH24:00' : "YYYY-MM-DD"}) as bucket
        from usage_events
        where account_id = ${input.accountId}::uuid
          and occurred_at >= ${window.since}::timestamptz
          and occurred_at < ${window.until}::timestamptz
      ), aggregates as materialized (
        select workspace_id, bucket, grouping(workspace_id) as all_workspaces,
          grouping(bucket) as all_buckets,
          jsonb_build_object('eventType', event_type, 'unit', unit,
            'quantity', sum(quantity)::text, 'eventCount', count(*)::text) as total
        from visible
        group by grouping sets ((event_type, unit), (bucket, event_type, unit),
          (workspace_id, event_type, unit))
      ), workspace_page as materialized (
        select workspace_id, jsonb_agg(total order by total->>'eventType', total->>'unit') as totals
        from aggregates where all_workspaces = 0
          and (${query.afterWorkspaceId ?? null}::uuid is null or workspace_id > ${query.afterWorkspaceId ?? null}::uuid)
        group by workspace_id order by workspace_id limit 51
      ), bucket_rows as (
        select bucket, jsonb_agg(total order by total->>'eventType', total->>'unit') as totals
        from aggregates where all_buckets = 0 group by bucket
      )
      select
        coalesce((select jsonb_agg(total order by total->>'eventType', total->>'unit')
          from aggregates where all_workspaces = 1 and all_buckets = 1), '[]'::jsonb) as totals,
        coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'totals', totals) order by bucket)
          from bucket_rows), '[]'::jsonb) as buckets,
        coalesce((select jsonb_agg(jsonb_build_object('workspaceId', page.workspace_id,
          'name', w.name, 'totals', page.totals) order by page.workspace_id)
          from (select * from workspace_page order by workspace_id limit 50) page
          left join workspaces w on w.id = page.workspace_id and w.account_id = ${input.accountId}::uuid), '[]'::jsonb) as workspaces,
        case when (select count(*) from workspace_page) > 50 then
          (select workspace_id::text from workspace_page order by workspace_id offset 49 limit 1)
          else null end as next_workspace_cursor
    `);
    // Standalone uses postgres-js; accept the other supported PgDatabase shape too.
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    const row = rows[0] as Record<string, unknown>;
    return OrganizationUsageSummary.parse({
      accountId: input.accountId,
      period: query.period,
      ...window,
      totals: row.totals,
      buckets: row.buckets,
      workspaces: row.workspaces,
      nextWorkspaceCursor: row.next_workspace_cursor,
    });
  });
}
