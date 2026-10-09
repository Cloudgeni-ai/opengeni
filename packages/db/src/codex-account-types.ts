/**
 * The legacy Codex account, rotation and source shapes the Codex routes
 * return. A leaf module so both the legacy accessors in the root barrel and
 * the shared-core projections (`subscription-core-codex-compat`) use them
 * without importing the root barrel.
 */
import type { CodexPlanEntitlementExclusion } from "./codex-plan-entitlement";
import type { CodexCredentialCooldownKind } from "./codex-token-resolver";

export type WorkspaceCodexSubscriptionMode =
  | "automatic"
  | "workspace"
  | "organization"
  | "disabled";
export type EffectiveCodexSubscriptionSource = "workspace" | "organization" | "disabled";

export type WorkspaceCodexSubscriptionSource = {
  accountId: string;
  workspaceId: string;
  workspaceKind: "personal" | "shared";
  mode: WorkspaceCodexSubscriptionMode;
  effectiveSource: EffectiveCodexSubscriptionSource;
  workspaceAvailable: boolean;
  organizationAvailable: boolean;
};

export type CodexAccountStatus = {
  allowedModelIds?: string[] | null;
  id: string;
  source: Exclude<EffectiveCodexSubscriptionSource, "disabled">;
  chatgptAccountId: string | null;
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  /** Last provider plan observation; absent on pre-plan-tracking fixtures. */
  planCheckedAt?: Date | null;
  /** Plan before the most recent observed plan change, and when it was seen. */
  planPreviousType?: string | null;
  planChangedAt?: Date | null;
  /** Models the current plan was proven not to include (see codex-plan-entitlement). */
  planEntitlementExclusion?: CodexPlanEntitlementExclusion | null;
  status: string; // active | needs_relogin | error
  /** New automatic allocations only; health/refresh and existing turns remain independent. */
  allocatorEnabled: boolean;
  allocatorVersion: number;
  allocatorUpdatedBySubjectId: string | null;
  allocatorUpdatedAt: Date | null;
  resetCreditAvailableCount: number | null;
  resetCreditsCheckedAt: Date | null;
  connectedBySubjectId: string | null;
  isActive: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
  // P2 cached usage (plaintext metadata; rides along on this metadata-only read
  // with ZERO provider calls and ZERO decrypts). null until the first refresh.
  primaryUsedPercent: number | null;
  primaryResetAt: Date | null;
  secondaryUsedPercent: number | null;
  secondaryResetAt: Date | null;
  usageCheckedAt: Date | null;
  // P3 rotation cooldown: when set and in the future, this account is cooling-down
  // (rotated-off after a usage cap) and the engine skips it. null ⇒ not cooling.
  exhaustedUntil: Date | null;
  /** Typed provider-refusal provenance; null for legacy/cleared cooldowns. */
  exhaustedKind: CodexCredentialCooldownKind | null;
};

export type CodexRotationSettings = {
  activeCredentialId: string | null;
  /** False keeps new allocations on the active account; true permits pool failover. */
  rotationEnabled: boolean;
  rotationStrategy: string; // P1: 'most_remaining' (unused)
};
