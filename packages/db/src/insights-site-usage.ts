import { sql } from "drizzle-orm";
import { InsightsSiteUsageResponse, type InsightsSiteUsageQuery } from "@opengeni/contracts/insights-usage";
import { withRlsContext, type Database } from "./database";
import { insightsUsageWindow } from "./insights-unified";

/** Uses the native accounting ledger and frozen model-call price snapshots. */
export async function readInsightsSiteUsage(db: Database, input: {
  accountId: string;
  workspaceId: string;
  query: InsightsSiteUsageQuery;
  now: Date;
}): Promise<InsightsSiteUsageResponse> {
  const window = insightsUsageWindow(input.query.range, input.now);
  return withRlsContext(db, input, async tx => {
    const result = await tx.execute(sql`select payload from opengeni_private.insights_site_usage(
      ${input.accountId}::uuid, ${input.workspaceId}::uuid,
      ${window.since.toISOString()}::timestamptz, ${window.until.toISOString()}::timestamptz)`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { payload: unknown }[];
    return InsightsSiteUsageResponse.parse({ workspaceId: input.workspaceId, range: input.query.range,
      windowStart: window.since.toISOString(), windowEnd: window.until.toISOString(),
      rows: rows.map(row => row.payload) });
  });
}
