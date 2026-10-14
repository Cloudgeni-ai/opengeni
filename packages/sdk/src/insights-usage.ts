// Type-only references keep this opt-in SDK leaf free of zod/root contracts.
import type {
  OrganizationInsightsUsageQueryInput,
  OrganizationInsightsCallsQueryInput,
  InsightsUsageRange,
  InsightsUsagePayer,
  InsightsUsageSource,
} from "@opengeni/contracts/insights-usage";

export type {
  InsightsUsageRange,
  InsightsUsageGroupBy,
  InsightsUsagePayer,
  InsightsUsageSource,
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

/** Custom selections require both inclusive UTC calendar days. */
export type InsightsUsageWindowOptions =
  | { range?: Exclude<InsightsUsageRange, "custom">; from?: never; to?: never }
  | { range: "custom"; from: string; to: string };

type FilterOptions<T> = Omit<T, "range" | "from" | "to" | "limit" | "payer" | "source"> &
  InsightsUsageWindowOptions & {
    limit?: number;
    payer?: InsightsUsagePayer | InsightsUsagePayer[];
    source?: InsightsUsageSource | InsightsUsageSource[];
  };

export type OrganizationInsightsUsageOptions = FilterOptions<
  Omit<OrganizationInsightsUsageQueryInput, "seriesGroups">
> & { seriesGroups?: boolean };
/** workspaceId is intersected with the path workspace by the existing server gate. */
export type WorkspaceInsightsUsageOptions = OrganizationInsightsUsageOptions;
export type OrganizationInsightsCallsOptions = FilterOptions<OrganizationInsightsCallsQueryInput>;
export type WorkspaceInsightsCallsOptions = OrganizationInsightsCallsOptions;
export type InsightsCallsScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "organization"; accountId: string };

/** Arrays repeat; comma strings, false and opaque values round-trip unchanged. */
export function insightsUsageQueryString(
  options: OrganizationInsightsUsageOptions | OrganizationInsightsCallsOptions,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
