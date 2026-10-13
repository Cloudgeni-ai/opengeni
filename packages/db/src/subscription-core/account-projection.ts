/** Stable public account metadata projected from the provider-neutral core. */
export type SubscriptionCorePoolAccount = {
  allowedModelIds?: string[] | null;
  id: string;
  scope: "workspace" | "user" | "organization";
  providerAccountId: string | null;
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  status: "active" | "needs_relogin" | "error" | "disabled";
  allocatorEnabled: boolean;
  version: number;
  allocatorVersion: number;
  allocatorUpdatedAt: Date | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
  quotaUsedPercent: number | null;
  quotaResetAt: Date | null;
  quotaCheckedAt: Date | null;
  exhaustedUntil: Date | null;
  selectionCount: number;
  lastSelectedAt: Date | null;
  connectedBySubjectId: string | null;
};
