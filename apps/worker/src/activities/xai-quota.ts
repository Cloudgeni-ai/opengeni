import {
  deliverSubscriptionCoreProviderWake,
  listXaiSubscriptionAccountsMetadata,
  readSubscriptionCoreProviderRouteForWorkspace,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
  updateXaiQuotaMetadata,
} from "@opengeni/db";
import { fetchXaiSubscriptionQuota } from "@opengeni/xai-subscription";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import { buildXaiTurnRequestAuthorization } from "./xai-auth";

const CORE_SUBSCRIPTION_SERVICE_SUBJECT = "service:subscription-core";

/**
 * After the SuperGrok receipt: one billing probe per exhausted shared
 * connection in this workspace's explicit context (design 5.3, EP-N22),
 * never legacy rows and never a personal connection (the probe runs as the
 * core's service subject). A recovery wakes the organization's SuperGrok
 * core waiters: a shared connection can serve every workspace it reaches.
 */
export async function refreshExhaustedXaiCoreQuota(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  fetch?: typeof fetch;
}): Promise<void> {
  let recovered: string[];
  try {
    recovered = await subscriptionCoreOperationConnections(
      SUBSCRIPTION_CORE_XAI,
    ).refreshExhaustedSubscriptionCoreQuota(
      input.db,
      input.settings,
      {
        kind: "workspace",
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: CORE_SUBSCRIPTION_SERVICE_SUBJECT,
      },
      input.fetch ? { fetchImpl: input.fetch } : {},
    );
  } catch {
    // A failed probe never blocks placement; the stored state stands.
    return;
  }
  if (recovered.length > 0) {
    await deliverSubscriptionCoreProviderWake(input.db, SUBSCRIPTION_CORE_XAI_PROVIDER, {
      accountId: input.accountId,
      reason: "usage_recovered",
    });
  }
}

/** Refresh billing, never inference, before treating cached exhaustion as current. */
export async function refreshExhaustedXaiQuota(
  input: Omit<Parameters<typeof buildXaiTurnRequestAuthorization>[0], "credentialId">,
) {
  const route = await readSubscriptionCoreProviderRouteForWorkspace(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
  });
  if (route === "maintenance") return;
  if (route === "core") {
    await refreshExhaustedXaiCoreQuota({
      db: input.db,
      settings: input.settings,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      ...(input.fetch ? { fetch: input.fetch as typeof fetch } : {}),
    });
    return;
  }
  const accounts = await listXaiSubscriptionAccountsMetadata(input.db, input);
  for (const account of accounts) {
    if (account.status !== "active" || !account.allocatorEnabled || !account.exhaustedUntil)
      continue;
    if (account.quotaCheckedAt && Date.now() - account.quotaCheckedAt.getTime() < 30_000) continue;
    try {
      const auth = await buildXaiTurnRequestAuthorization({ ...input, credentialId: account.id });
      const quota = await fetchXaiSubscriptionQuota({ context: auth.context });
      // Unknown billing is not evidence that a refusal has cleared.
      if (quota.usedPercent === null) continue;
      await updateXaiQuotaMetadata(input.db, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        credentialId: account.id,
        quotaUsedPercent: quota.usedPercent,
        quotaResetAt: quota.period?.end ?? null,
        quotaCheckedAt: quota.checkedAt,
        expectedExhaustedUntil: account.exhaustedUntil,
        expectedQuotaCheckedAt: account.quotaCheckedAt,
        exhaustedUntil:
          quota.usedPercent < 100 ? null : (quota.period?.end ?? account.exhaustedUntil),
      });
    } catch {
      // Preserve provider refusal on refresh failure; the durable timer retries.
    }
  }
}
