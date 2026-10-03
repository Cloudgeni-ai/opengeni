import type { OpenGeniClient, OpenGeniRequestOptions } from "./client";
import type {
  OrganizationUsagePeriod,
  OrganizationUsageSummary,
  OrganizationUsageWorkspacePage,
} from "@opengeni/contracts";

/** Legacy organization usage endpoints, loaded only when a caller uses them. */
export async function getOrganizationUsageSummary(
  client: Pick<OpenGeniClient, "requestJson">,
  options: { accountId: string; period?: OrganizationUsagePeriod },
  requestOptions: OpenGeniRequestOptions = {},
): Promise<OrganizationUsageSummary> {
  return await client.requestJson(
    "GET",
    "/v1/billing/usage-summary",
    undefined,
    { accountId: options.accountId, period: options.period ?? "month" },
    requestOptions,
  );
}

export async function getOrganizationUsageWorkspacePage(
  client: Pick<OpenGeniClient, "requestJson">,
  options: {
    accountId: string;
    period?: OrganizationUsagePeriod;
    until: string;
    afterWorkspaceId?: string;
  },
  requestOptions: OpenGeniRequestOptions = {},
): Promise<OrganizationUsageWorkspacePage> {
  return await client.requestJson(
    "GET",
    "/v1/billing/usage-workspaces",
    undefined,
    {
      accountId: options.accountId,
      period: options.period ?? "month",
      until: options.until,
      ...(options.afterWorkspaceId ? { afterWorkspaceId: options.afterWorkspaceId } : {}),
    },
    requestOptions,
  );
}
