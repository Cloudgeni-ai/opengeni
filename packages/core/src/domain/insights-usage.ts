import type {
  InsightsCallsQuery,
  InsightsCallsResponse,
  InsightsUsageQuery,
  InsightsUsageRange,
  InsightsUsageResponse,
} from "@opengeni/contracts/insights-usage";
import { readInsightsCalls, readInsightsUsage, type Database } from "@opengeni/db";

export type InsightsQueryScope = {
  accountId: string;
  /** null means organization scope; it does not grant workspace/session access. */
  workspaceId: string | null;
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
export function insightsUsageWindow(range: InsightsUsageRange, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid Insights request time");
  const until = new Date(now);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (range) {
    case "today":
      break;
    case "week":
      since.setUTCDate(since.getUTCDate() - 6);
      break;
    case "month":
      since.setUTCDate(1);
      break;
    case "30d":
      since.setUTCDate(since.getUTCDate() - 29);
      break;
    case "90d":
      since.setUTCDate(since.getUTCDate() - 89);
      break;
    case "ytd":
      since.setUTCMonth(0, 1);
      break;
  }
  const priorUntil = new Date(since);
  const priorSince = new Date(priorUntil.getTime() - (until.getTime() - since.getTime()));
  return {
    since,
    until,
    priorSince,
    priorUntil,
    bucket: range === "today" ? ("hour" as const) : ("day" as const),
  };
}
