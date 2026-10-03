// Type-only contract references: SDK/browser consumers never load zod here.
import type {
  WorkspaceInsightsUsageQueryInput,
  OrganizationInsightsUsageQueryInput,
  WorkspaceInsightsCallsQueryInput,
  OrganizationInsightsCallsQueryInput,
  InsightsUsagePayer,
} from "@opengeni/contracts/insights-usage";

export type {
  InsightsUsageRange,
  InsightsUsageGroupBy,
  InsightsUsagePayer,
  InsightsUsageTokens,
  InsightsUsageClassMicros,
  InsightsUsageMeasures,
  InsightsUsageScope,
  InsightsUsageGroup,
  InsightsUsageSeriesPoint,
  InsightsUsageFacets,
  InsightsUsageResponse,
  InsightsCall,
  InsightsCallsResponse,
} from "@opengeni/contracts/insights-usage";

export type WorkspaceInsightsUsageOptions = Omit<
  WorkspaceInsightsUsageQueryInput,
  "limit" | "seriesGroups" | "payer"
> & {
  limit?: number;
  seriesGroups?: boolean;
  payer?: InsightsUsagePayer | InsightsUsagePayer[];
};
export type OrganizationInsightsUsageOptions = Omit<
  OrganizationInsightsUsageQueryInput,
  "limit" | "seriesGroups" | "payer"
> & {
  limit?: number;
  seriesGroups?: boolean;
  payer?: InsightsUsagePayer | InsightsUsagePayer[];
};
export type WorkspaceInsightsCallsOptions = Omit<
  WorkspaceInsightsCallsQueryInput,
  "limit" | "payer"
> & {
  limit?: number;
  payer?: InsightsUsagePayer | InsightsUsagePayer[];
};
export type OrganizationInsightsCallsOptions = Omit<
  OrganizationInsightsCallsQueryInput,
  "limit" | "payer"
> & { limit?: number; payer?: InsightsUsagePayer | InsightsUsagePayer[] };
export type InsightsCallsScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "organization"; accountId: string };

/** Keep repeated values repeated, including slashes, opaque cursors, and false. */
export function insightsUsageQueryString(
  options: OrganizationInsightsUsageOptions | OrganizationInsightsCallsOptions,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, String(item));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
