import {
  OrganizationUsageQuery,
  OrganizationUsageSummary,
  OrganizationUsageWorkspacePage,
  OrganizationUsageWorkspacePageQuery,
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

type UsageInput = { accountId: string; period?: OrganizationUsagePeriod | undefined };

/** One set-based, actor-visible aggregate. Must use the writable primary. */
export async function getOrganizationUsageSummary(
  db: Database,
  input: UsageInput,
  now = new Date(),
): Promise<OrganizationUsageSummary> {
  const query = OrganizationUsageQuery.parse(input);
  const window = organizationUsageWindow(query.period, now);
  const result = await readOrganizationUsage(db, input.accountId, window, true);
  return OrganizationUsageSummary.parse({
    ...result,
    accountId: input.accountId,
    period: query.period,
    ...window,
  });
}

/** Bounded page-only scan; never recomputes organization-wide totals/buckets. */
export async function getOrganizationUsageWorkspacePage(
  db: Database,
  input: UsageInput & { until: string; afterWorkspaceId?: string | undefined },
): Promise<OrganizationUsageWorkspacePage> {
  const query = OrganizationUsageWorkspacePageQuery.parse(input);
  const window = organizationUsageWindow(query.period, new Date(query.until));
  const result = await readOrganizationUsage(
    db,
    input.accountId,
    window,
    false,
    query.afterWorkspaceId,
  );
  return OrganizationUsageWorkspacePage.parse({
    ...result,
    accountId: input.accountId,
    period: query.period,
    ...window,
  });
}

async function readOrganizationUsage(
  db: Database,
  accountId: string,
  window: ReturnType<typeof organizationUsageWindow>,
  includePeriod: boolean,
  afterWorkspaceId?: string,
) {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    await scopedDb.execute(sql`select set_config('statement_timeout', '10s', true)`);
    const result = await scopedDb.execute(sql`select opengeni_private.organization_usage_summary(
      ${accountId}::uuid, ${window.since}::timestamptz, ${window.until}::timestamptz,
      ${window.granularity}::text, ${afterWorkspaceId ?? null}::uuid, ${includePeriod}::boolean
    ) as summary`);
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    return (rows[0] as { summary: Record<string, unknown> }).summary;
  });
}
