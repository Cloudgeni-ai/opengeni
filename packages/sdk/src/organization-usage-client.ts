import { OpenGeniClient as OpenGeniBrowserClient } from "./client";
import type { OpenGeniRequestOptions } from "./client";

/** Legacy organization usage reads retained on root/core clients, not the browser graph. */
export class OpenGeniClient extends OpenGeniBrowserClient {
  async getOrganizationUsageSummary(
    options: {
      accountId: string;
      period?: import("@opengeni/contracts").OrganizationUsagePeriod;
    },
    requestOptions: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts").OrganizationUsageSummary> {
    return await this.requestJson(
      "GET",
      "/v1/billing/usage-summary",
      undefined,
      {
        accountId: options.accountId,
        period: options.period ?? "month",
      },
      requestOptions,
    );
  }

  async getOrganizationUsageWorkspacePage(
    options: {
      accountId: string;
      period?: import("@opengeni/contracts").OrganizationUsagePeriod;
      until: string;
      afterWorkspaceId?: string;
    },
    requestOptions: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts").OrganizationUsageWorkspacePage> {
    return await this.requestJson(
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
}
