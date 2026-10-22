import type { CodexAccount, CodexAccountOverview, CodexUsage } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { MODEL_SETTINGS_STALE_TIME_MS, useSharedQuery } from "@opengeni/react/app/lib/shared-query";

export function useOrganizationCodexOverview(
  client: OpenGeniBrowserClient,
  organizationId: string,
  account: CodexAccount,
  enabled = true,
) {
  return useSharedQuery<CodexAccountOverview>(
    client,
    ["model-settings", "organization-codex-overview", organizationId, account.id],
    () =>
      client.requestJson<CodexAccountOverview>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/codex/accounts/${encodeURIComponent(account.id)}/overview`,
      ),
    { enabled: enabled && account.status === "active", staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
}

export function useOrganizationCodexUsage(
  client: OpenGeniBrowserClient,
  organizationId: string,
  account: CodexAccount,
  enabled = true,
) {
  // Usage and reset inventory come from the same independently-settled read:
  // prefetching the detail never makes a second live provider usage request.
  const query = useOrganizationCodexOverview(client, organizationId, account, enabled);
  const usage = query.data?.usage;
  const data: CodexUsage | null = usage
    ? { status: usage.error ? "error" : (usage.value?.status ?? "no-data"), usage: usage.value }
    : null;
  return { ...query, data, source: usage?.source, resetCredits: query.data?.resetCredits };
}

/** Mounted with list rows: opening a detail reuses these exact retained keys. */
export function OrganizationCodexDetailPrefetch({
  client,
  organizationId,
  account,
}: {
  client: OpenGeniBrowserClient;
  organizationId: string;
  account: CodexAccount;
}) {
  useOrganizationCodexOverview(client, organizationId, account);
  return null;
}
