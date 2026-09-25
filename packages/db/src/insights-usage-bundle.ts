import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rlsContextForWorkspace, withRlsContext } from "./database";
import { INSIGHTS_WARM_GROUP_UUID_RE, type WarmGroupAggregate } from "./insights";

export type WorkspaceInsightsUsageBundleInput = {
  workspaceId: string;
  since: Date;
  until: Date;
  priorSince: Date;
  priorUntil: Date;
  monthSince: Date;
  granularity: "day" | "hour";
  warmGroupLimit?: number;
};

export type WorkspaceInsightsUsageBucket = {
  costMicros: number | null;
  warmSeconds: number;
};

export type WorkspaceInsightsUsageBundle = {
  workspaceCreditMicros: number;
  priorWorkspaceCreditMicros: number;
  warmSeconds: number;
  priorWarmSeconds: number;
  buckets: Map<string, WorkspaceInsightsUsageBucket>;
  warmGroups: WarmGroupAggregate[];
  billableTokensUsed: number;
  agentRunsUsed: number;
};

type RawUsageBundleRow = {
  workspace_credit_micros: unknown;
  prior_workspace_credit_micros: unknown;
  warm_seconds: unknown;
  prior_warm_seconds: unknown;
  billable_tokens_used: unknown;
  agent_runs_used: unknown;
  buckets: unknown;
  warm_groups: unknown;
};

type JsonRecord = Record<string, unknown>;

function numberValue(value: unknown, label: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    throw new Error(`Insights usage bundle ${label} is not numeric`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Insights usage bundle ${label} is not numeric`);
  }
  return parsed;
}

function nullableNumberValue(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : numberValue(value, label);
}

function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`Insights usage bundle ${label} is not an array`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Insights usage bundle ${label}[${index}] is not an object`);
    }
    return item as JsonRecord;
  });
}

function stringValue(row: JsonRecord, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Insights usage bundle ${key} is not a string`);
  }
  return value;
}

/**
 * One read for the three existing usage windows. The event-type arrays are
 * deliberately closed so the authority function can keep selective predicates
 * inside its scan while all rollup math remains outside the billing path. The
 * current window feeds one grouping-sets pass (UTC buckets and warm groups), and
 * its totals are the sum of the bucket rows, so no window is materialized.
 */
export async function readWorkspaceInsightsUsageBundle(
  db: Database,
  input: WorkspaceInsightsUsageBundleInput,
): Promise<WorkspaceInsightsUsageBundle> {
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  // Group on the truncated timestamp; format only the grouped buckets.
  const unit = input.granularity === "hour" ? sql`'hour'` : sql`'day'`;
  const bucket = sql`date_trunc(${unit}, usage_row.occurred_at at time zone 'UTC')`;
  const bucketLabel =
    input.granularity === "hour"
      ? sql`to_char(bucket, 'YYYY-MM-DD"T"HH24:00')`
      : sql`to_char(bucket, 'YYYY-MM-DD')`;
  const warmGroupLimit = Math.max(1, Math.min(input.warmGroupLimit ?? 24, 100));

  return await withRlsContext(db, context, async (scopedDb) => {
    const [row] = await scopedDb.execute<RawUsageBundleRow>(sql`
      with current_grouped as (
        select
          grouping(usage_row.bucket) = 0 as by_bucket,
          usage_row.bucket,
          usage_row.warm_group_id,
          sum(usage_row.quantity) filter (
            where usage_row.event_type = 'model.cost'
          ) as cost_micros,
          coalesce(sum(usage_row.quantity) filter (
            where usage_row.event_type = 'sandbox.warm_seconds'
          ), 0) as warm_seconds
        from (
          select
            usage_row.event_type,
            usage_row.quantity,
            ${bucket} as bucket,
            case when usage_row.event_type = 'sandbox.warm_seconds'
              then split_part(usage_row.source_resource_id, ':', 1)
            end as warm_group_id
          from opengeni_private.visible_workspace_insights_usage_projection(
            ${input.workspaceId},
            ${input.since.toISOString()}::timestamp with time zone,
            ${input.until.toISOString()}::timestamp with time zone,
            array['model.cost', 'sandbox.warm_seconds']::text[]
          ) usage_row
        ) usage_row
        group by grouping sets ((usage_row.bucket), (usage_row.warm_group_id))
      ), current_totals as (
        select
          coalesce(sum(cost_micros), 0) as workspace_credit_micros,
          coalesce(sum(warm_seconds), 0) as warm_seconds
        from current_grouped
        where by_bucket
      ), prior_totals as (
        select
          coalesce(sum(usage_row.quantity) filter (
            where usage_row.event_type = 'model.cost'
          ), 0) as prior_workspace_credit_micros,
          coalesce(sum(usage_row.quantity) filter (
            where usage_row.event_type = 'sandbox.warm_seconds'
          ), 0) as prior_warm_seconds
        from opengeni_private.visible_workspace_insights_usage_projection(
          ${input.workspaceId},
          ${input.priorSince.toISOString()}::timestamp with time zone,
          ${input.priorUntil.toISOString()}::timestamp with time zone,
          array['model.cost', 'sandbox.warm_seconds']::text[]
        ) usage_row
      ), month_totals as (
        select
          coalesce(sum(usage_row.quantity) filter (
            where usage_row.event_type = 'model.tokens'
              and usage_row.occurred_at > ${input.monthSince.toISOString()}::timestamp with time zone
          ), 0) as billable_tokens_used,
          coalesce(sum(usage_row.quantity) filter (
            where usage_row.event_type = 'agent_run.created'
              and usage_row.occurred_at > ${input.monthSince.toISOString()}::timestamp with time zone
          ), 0) as agent_runs_used
        from opengeni_private.visible_workspace_insights_usage_projection(
          ${input.workspaceId},
          ${input.monthSince.toISOString()}::timestamp with time zone,
          'infinity'::timestamp with time zone,
          array['model.tokens', 'agent_run.created']::text[]
        ) usage_row
      ), bucket_rows as (
        select bucket, cost_micros, warm_seconds
        from current_grouped
        where by_bucket
      ), warm_group_rows as (
        select warm_group_id as group_id, warm_seconds
        from current_grouped
        where not by_bucket and warm_group_id is not null
        order by warm_seconds desc
        limit ${Math.max(warmGroupLimit * 4, warmGroupLimit)}
      )
      select
        current_totals.workspace_credit_micros,
        prior_totals.prior_workspace_credit_micros,
        current_totals.warm_seconds,
        prior_totals.prior_warm_seconds,
        month_totals.billable_tokens_used,
        month_totals.agent_runs_used,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'bucket', ${bucketLabel},
            'costMicros', cost_micros,
            'warmSeconds', warm_seconds
          ) order by bucket)
          from bucket_rows
        ), '[]'::jsonb) as buckets,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'groupId', group_id,
            'warmSeconds', warm_seconds
          ) order by warm_seconds desc, group_id)
          from warm_group_rows
        ), '[]'::jsonb) as warm_groups
      from current_totals
      cross join prior_totals
      cross join month_totals
    `);
    if (!row) {
      throw new Error("Insights usage bundle query returned no row");
    }

    const buckets = new Map(
      records(row.buckets, "buckets").map((bucketRow) => [
        stringValue(bucketRow, "bucket"),
        {
          costMicros: nullableNumberValue(bucketRow.costMicros, "costMicros"),
          warmSeconds: numberValue(bucketRow.warmSeconds, "warmSeconds"),
        },
      ]),
    );
    const warmGroups = records(row.warm_groups, "warmGroups")
      .filter((groupRow) => INSIGHTS_WARM_GROUP_UUID_RE.test(stringValue(groupRow, "groupId")))
      .slice(0, warmGroupLimit)
      .map((groupRow) => ({
        groupId: stringValue(groupRow, "groupId"),
        warmSeconds: numberValue(groupRow.warmSeconds, "warmSeconds"),
      }));

    return {
      workspaceCreditMicros: numberValue(row.workspace_credit_micros, "workspaceCreditMicros"),
      priorWorkspaceCreditMicros: numberValue(
        row.prior_workspace_credit_micros,
        "priorWorkspaceCreditMicros",
      ),
      warmSeconds: numberValue(row.warm_seconds, "warmSeconds"),
      priorWarmSeconds: numberValue(row.prior_warm_seconds, "priorWarmSeconds"),
      buckets,
      warmGroups,
      billableTokensUsed: numberValue(row.billable_tokens_used, "billableTokensUsed"),
      agentRunsUsed: numberValue(row.agent_runs_used, "agentRunsUsed"),
    };
  });
}
