import {
  resolveInsightsUsageWindow,
  type InsightsCallsQuery,
  type InsightsCallsResponse,
  type InsightsUsageQuery,
  type InsightsUsageRange,
  type InsightsUsageResponse,
  type InsightsSiteUsageQuery,
} from "@opengeni/contracts/insights-usage";
import {
  readInsightsCalls,
  readInsightsUsage,
  readInsightsSiteUsage,
  type Database,
} from "@opengeni/db";

export async function getInsightsSiteUsage(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    query: InsightsSiteUsageQuery;
    viewerSubjectId: string | null;
    now?: Date;
  },
) {
  return readInsightsSiteUsage(db, { ...input, now: input.now ?? new Date() });
}

export type InsightsQueryScope = {
  accountId: string;
  /** null means organization scope; it does not grant workspace/session access. */
  workspaceId: string | null;
  /** Server-verified metadata authority; billing permission alone supplies none. */
  detailsWorkspaceIds?: readonly string[];
  /** Existing organization service-key authority applies only to shared workspaces. */
  detailsSharedWorkspaces?: boolean;
};

export async function getInsightsUsage(
  db: Database,
  input: InsightsQueryScope & { query: InsightsUsageQuery; now?: Date },
): Promise<InsightsUsageResponse> {
  return await readInsightsUsage(db, { ...input, now: input.now ?? new Date() });
}

export async function listInsightsCalls(
  db: Database,
  input: InsightsQueryScope & { query: InsightsCallsQuery; now?: Date },
): Promise<InsightsCallsResponse> {
  return await readInsightsCalls(db, { ...input, now: input.now ?? new Date() });
}

/** UTC windows retain the actual request timestamp, including empty midnight windows. */
export function insightsUsageWindow(
  range: Exclude<InsightsUsageRange, "custom">,
  now = new Date(),
) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid Insights request time");
  return resolveInsightsUsageWindow({ range }, now);
}
