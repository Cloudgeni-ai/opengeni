/**
 * Contract types for the shared subscription core
 * (docs/subscription-accounts.md, docs/design/subscription-core-2026-10-07.md).
 *
 * Everything is plain data: timestamps are epoch milliseconds, identifiers are
 * opaque strings, and no type carries credential material.
 */

export type ProviderId = string;
export type ModelId = string;

/** A provider model and the reasoning levels it supports, lowest first. */
export type ModelDescriptor = {
  id: ModelId;
  provider: ProviderId;
  reasoningLevels: readonly string[];
};

// Connections and scope (design 3.1)

export type ConnectionKind = "subscription" | "api_key";

/** Where a shared connection may be used (SUB-SCOPE-02). */
export type ConnectionScope =
  | { kind: "organization" }
  | {
      kind: "workspaces";
      workspaceIds: readonly string[];
      /** Separate switch for every Personal workspace in the organization. */
      allowPersonalWorkspaces: boolean;
    }
  /** Chosen people, evaluated against the session owner (design 3.8). */
  | { kind: "people"; membershipIds: readonly string[] };

export type ConnectionOwnership =
  | {
      kind: "shared";
      scope: ConnectionScope;
      /** Delegated management (SUB-SCOPE-04); null when only administrators manage it. */
      managedByWorkspaceId: string | null;
    }
  | { kind: "personal"; ownerMembershipId: string };

/** Credential health. Separate from allocator eligibility (SUB-ELIG-04). */
export type ConnectionHealth = "healthy" | "needs_reconnect" | "error";

export type SubscriptionConnection = {
  id: string;
  provider: ProviderId;
  kind: ConnectionKind;
  ownership: ConnectionOwnership;
  health: ConnectionHealth;
  allocatorEnabled: boolean;
  /**
   * Models the plan entitles, as reported by the adapter. Null means every
   * model of the provider.
   */
  entitledModelIds: readonly ModelId[] | null;
  /** Entitlement exclusions observed by the adapter (SUB-ELIG-03). */
  excludedModelIds: readonly ModelId[];
  /** Administrator access policy; null allows every entitled model. */
  allowedModelIds: readonly ModelId[] | null;
  /** Per-workspace, per-source policy; one canonical connection may have both memberships. */
  assignmentPolicies?: readonly SubscriptionAssignmentPolicy[];
  /** Incremented on every credential refresh; fences quota observations. */
  refreshGeneration: number;
  quota: SubscriptionQuota | null;
};

// Shared quota model (design 2.2)

export type QuotaWindowStatus = "ok" | "warning" | "exhausted" | "unknown";

export type QuotaWindow = {
  id: string;
  usedPercent: number | null;
  resetsAt: number | null;
  status: QuotaWindowStatus;
};

export type QuotaSource = "usage_endpoint" | "response_headers" | "refusal";

export type SubscriptionQuota = {
  windows: readonly QuotaWindow[];
  /** Per-model cooldowns (for example Claude model-specific limits). */
  modelCooldowns: Readonly<Record<ModelId, number>>;
  exhaustedUntil: number | null;
  exhaustedKind: "quota" | "rate_limit" | null;
  revision: number;
  observedAt: number | null;
  observedRefreshGeneration: number | null;
  source: QuotaSource | null;
};

// Settings (design 3.3)

export type RotationSetting =
  | { mode: "primary_first"; primaryConnectionId: string | null }
  | { mode: "spread" };

export type InferenceSource = "automatic" | "workspace" | "organization";
export type InferencePool = "workspace" | "organization";

/** Source-specific authorization and service policy for one workspace assignment. */
export type SubscriptionAssignmentPolicy = {
  workspaceId: string;
  inferencePool: InferencePool;
  allowedModelIds: readonly ModelId[] | null;
  excludedModelIds?: readonly ModelId[];
  allocatorEnabled: boolean;
  managedByWorkspaceId?: string | null;
};

/** Per workspace and provider switches (SUB-SET-06). */
export type ProviderSwitches = {
  /** New authoritative pool selection; omitted only for legacy stored settings. */
  inferenceSource?: InferenceSource;
  /** Compatibility projection: false means workspace-only; true means automatic/organization. */
  useOrganizationAccounts: boolean;
  enabled: boolean;
};

export type SubscriptionSettingValues = {
  /** Per provider; a provider without an entry spreads work. */
  rotation: Readonly<Record<ProviderId, RotationSetting>>;
  /** Per provider; a provider without an entry is enabled and uses organization accounts. */
  providers: Readonly<Record<ProviderId, ProviderSwitches>>;
  crossProviderFailover: boolean;
  /** Ordered fallback models for a preferred model, possibly on other providers. */
  fallbackOrder: Readonly<Record<ModelId, readonly ModelId[]>>;
  personalConnectionsAllowed: boolean;
  personalFallbackAllowed: boolean;
};

export type SubscriptionSettingKey = keyof SubscriptionSettingValues;

/** Keys whose value is a map; a workspace override replaces individual entries. */
export type KeyedSettingKey = "rotation" | "providers" | "fallbackOrder";
export type ScalarSettingKey = Exclude<SubscriptionSettingKey, KeyedSettingKey>;

export type SubscriptionSettingsPolicy = {
  /** The organization row: every value set. */
  organization: SubscriptionSettingValues;
  /** Settings an organization administrator locked; workspace overrides of them are ignored. */
  locked: readonly SubscriptionSettingKey[];
  /** Optional workspace rows; an absent key inherits. */
  workspaces: Readonly<Record<string, SubscriptionSettingOverrides>>;
};

/**
 * A workspace row. Map-valued settings override individual entries, and a
 * provider's switches override individual fields (D-25).
 */
export type SubscriptionSettingOverrides = Partial<Omit<SubscriptionSettingValues, "providers">> & {
  providers?: Readonly<Record<ProviderId, Partial<ProviderSwitches>>>;
};

export type SettingSource = "organization" | "workspace";

export type EffectiveSubscriptionSettings = {
  values: SubscriptionSettingValues;
  sources: { [K in ScalarSettingKey]: SettingSource } & {
    [K in KeyedSettingKey]: Readonly<Record<string, SettingSource>>;
  };
};

// Placement context

export type PlacementWorkspace = {
  id: string;
  kind: "shared" | "personal";
  /** Owner of a Personal workspace (organization membership). */
  ownerMembershipId: string | null;
  /** Workspace model restriction; null allows every model (SUB-ELIG-02). */
  allowedModelIds: readonly ModelId[] | null;
};

export type PlacementPerson = {
  membershipId: string;
  /** False once the person left the organization or lost access. */
  active: boolean;
  personalFallbackOptIn: boolean;
};

/** The session's chat binding (design 3.4). */
export type SessionBinding = {
  connectionId: string;
  /** Provider of the bound connection when the binding was written (informational). */
  provider: ProviderId;
  modelId: ModelId;
  choice: "automatic" | "explicit";
  /** Completion time of the latest model call on this binding. */
  lastModelCallAt: number;
  /**
   * The exact prompt-cache lifetime Opengeni sent with the latest request on
   * this binding (Claude: 5 minutes or 1 hour). Overrides the provider's cache
   * facts when set (SUB-STICK-04).
   */
  cacheTtlMs?: number | null;
};

/** Personal authority frozen on accepted work (design 3.7). */
export type PersonalAuthority = { provider: ProviderId; ownerMembershipId: string };

/** A re-selection point since the last placement (SUB-STICK-05). */
export type ReselectionPoint = "compaction_completed" | "model_changed";

export type PlacementSession = {
  id: string;
  workspaceId: string;
  visibility: "private" | "shared";
  /** Null only for a deliberately ownerless service session; it can use shared pools only. */
  ownerMembershipId: string | null;
  preferredModelId: ModelId;
  reasoningLevel: string;
  binding: SessionBinding | null;
  /** "Only this model": no failover to another model (SUB-FAIL-05). */
  onlyThisModel: boolean;
  reselectionPoints: readonly ReselectionPoint[];
  personalAuthority: readonly PersonalAuthority[];
  /**
   * Set while the session's compaction mode ties it to one provider (Codex
   * remote compaction, SUB-FAIL-09): models of other providers are excluded.
   */
  compactionProviderLock: ProviderId | null;
};

/** How the provider prompt cache expires (SUB-STICK-04, design 6.1). */
export type CacheFacts =
  /** Exact lifetime Opengeni sent with the request (Claude). */
  | { kind: "exact_ttl"; ttlMs: number }
  /** Idle cut-off measured from model-call facts; null until measured. */
  | { kind: "measured_idle_cutoff"; cutoffMs: number | null };

/** Everything placement reads for one session and one turn. */
export type PlacementInput = {
  now: number;
  workspace: PlacementWorkspace;
  session: PlacementSession;
  /** Effective settings for the session's workspace. */
  settings: SubscriptionSettingValues;
  people: readonly PlacementPerson[];
  models: readonly ModelDescriptor[];
  connections: readonly SubscriptionConnection[];
  cacheFacts: Readonly<Record<ProviderId, CacheFacts>>;
  /**
   * Per provider, how old a quota observation may be before its windows count
   * as unknown again (SUB-ELIG-06). Absent means observations do not expire;
   * exhaustion deadlines always stand.
   */
  quotaStaleAfterMs?: Readonly<Record<ProviderId, number>>;
};

// Decisions, switch and wait reasons

/** Why a placement runs where it runs. */
export type PlacementSwitch =
  | "initial"
  | "sticky"
  | "pinned"
  | "reselected_cold"
  | "failover_same_provider"
  | "failover_cross_provider"
  | "return_to_preferred";

/**
 * Reasons carried by `subscription.account.switched` (design 6.2). Placement
 * produces the switching subset of `PlacementSwitch`; `explicit_choice` comes
 * from a person changing the binding and `revoked` from lease renewal.
 */
export type AccountSwitchReason =
  | "initial"
  | "reselected_cold"
  | "failover_same_provider"
  | "failover_cross_provider"
  | "return_to_preferred"
  | "explicit_choice"
  | "revoked";

export type WaitReason =
  | "pinned_account_unavailable"
  /** The explicit choice can never serve this work until a person changes something (D-24). */
  | "pinned_account_ineligible"
  | "no_eligible_capacity"
  /** No candidate model may be used: workspace ceiling or provider switch (D-17, D-26). */
  | "model_not_allowed"
  /**
   * The session's compaction mode keeps it on its provider until it converts,
   * and that is what keeps a usable model away (SUB-FAIL-09).
   */
  | "compaction_provider_locked";

export type PlacementDecision =
  | {
      kind: "run";
      connectionId: string;
      provider: ProviderId;
      modelId: ModelId;
      reasoningLevel: string;
      switch: PlacementSwitch;
      personal: boolean;
    }
  | { kind: "wait"; reason: WaitReason; earliestResetAt: number | null };
