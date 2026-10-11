import type { CacheFacts, ModelId, ModelTier, ProviderId, SubscriptionQuota } from "./types";

/**
 * The prompt-cache lifetime a provider adapter declares (SUB-PROV-01,
 * SUB-STICK-04): either the exact lifetime Opengeni sends with each request,
 * or an idle cut-off taken from the provider's public documentation. Every
 * adapter states a positive number; the shared core never falls back to a
 * default for a provider and never names one. Choose it conservatively:
 * a session switches account only once idle longer than this, so a value
 * that is too short pays for a cache miss the provider would have avoided.
 */
export type DeclaredCacheFacts =
  | { kind: "exact_ttl"; ttlMs: number }
  | { kind: "measured_idle_cutoff"; cutoffMs: number };

/** The declared lifetime in milliseconds, or a thrown error for an unusable declaration. */
export function declaredCacheLifetimeMs(facts: DeclaredCacheFacts): number {
  const lifetime = facts.kind === "exact_ttl" ? facts.ttlMs : facts.cutoffMs;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0)
    throw new Error("A provider adapter must declare a positive whole-millisecond cache lifetime");
  return lifetime;
}

/**
 * Provider differences are capability flags, never provider conditionals in
 * shared code (SUB-PROV-02).
 */
export type ProviderCapabilities = {
  /**
   * The credential renews itself through refresh. A provider whose credential
   * formats differ (OAuth renews, a setup token or an API key does not)
   * declares it per format through `capabilitiesFor`.
   */
  autoRenews: boolean;
  resetCredits: boolean;
  /** Paid usage beyond the plan can be enabled per connection (consent-gated). */
  extraCredits: boolean;
  modelEntitlements: boolean;
  realtime: boolean;
  fundsMedia: boolean;
  apps: boolean;
  remoteCompaction: boolean;
  quotaWindows: boolean;
};

/**
 * Shared error outcomes every adapter classifies into (SUB-PROV-01). A
 * refusal that limits one model only carries its `modelId`, so the core can
 * record it as that model's cooldown on the connection
 * (`modelCooldownFromOutcome`). The shared settlement step
 * (`planSubscriptionCoreRefusal`) records it; the live worker does once it
 * adopts that step.
 */
export type ProviderErrorOutcome =
  | { kind: "exhausted"; resetAt: number | null; modelId?: ModelId }
  | { kind: "rate_limited"; retryAfterMs: number | null; modelId?: ModelId }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "entitlement_missing"; modelId: ModelId }
  | { kind: "overloaded" }
  | { kind: "transient" }
  | { kind: "fatal" };

/** An encrypted credential as stored; the core never decrypts it. */
export type EncryptedCredential = {
  credentialEncrypted: string;
  credentialFormat: string;
  expiresAt: number | null;
};

/** Identity a sign-in reports for the connection row. */
export type ConnectionIdentity = {
  providerAccountId: string;
  accountEmail: string | null;
  planType: string | null;
};

export type SignInResult = { credential: EncryptedCredential; identity: ConnectionIdentity };

/** Items in conversation history that only their own provider accepts. */
export type ProviderHistoryItemKind =
  | "encrypted_reasoning"
  | "thinking_signature"
  | "provider_tool"
  | "remote_compaction";

/**
 * What a provider can accept from history written while another provider
 * served the session (design 4, SUB-FAIL-08).
 */
export type HistoryCompatibility = {
  /** Provider-specific item kinds to drop from a request copy for this provider. */
  dropFromOtherProviders: readonly ProviderHistoryItemKind[];
};

/**
 * The adapter surface every model connection implements, including API-key
 * connectors (SUB-PROV-04). `Transport` is the provider's request-local
 * authorization handle; `ProviderError` is whatever the transport throws.
 */
export interface ModelConnectionAdapter<Transport = unknown, ProviderError = unknown> {
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Request-local authorization and wire normalization for one selected connection. */
  transport(input: { connectionId: string; credential: EncryptedCredential }): Promise<Transport>;
  /** Models the connection's plan can serve, including provider-observed exclusions. */
  entitledModels(input: {
    planType: string | null;
    excludedModelIds: readonly ModelId[];
  }): readonly ModelId[] | null;
  /** Null when the error is not a provider outcome (for example a programming error). */
  classifyError(error: ProviderError): ProviderErrorOutcome | null;
  cacheFacts(input: { modelId: ModelId }): CacheFacts;
  historyCompatibility(): HistoryCompatibility;
  /**
   * Optional out-of-turn quota probe (a provider usage endpoint), decoded by
   * the subscription adapter's `decodeQuota`.
   */
  fetchUsage?(transport: Transport): Promise<unknown>;
  /** Optional live model catalog of the connection, cached per refresh generation. */
  liveModels?(transport: Transport): Promise<readonly ModelId[]>;
}

/**
 * The full adapter of a signed-in subscription (SUB-PROV-01): sign-in,
 * refresh, quota decoding, plus the shared connection surface.
 */
export interface SubscriptionProviderAdapter<
  Transport = unknown,
  ProviderError = unknown,
  SignInInput = unknown,
  UsageResponse = unknown,
> extends ModelConnectionAdapter<Transport, ProviderError> {
  /** OAuth, device code or setup token; returns an encrypted secret and identity. */
  signIn(input: SignInInput): Promise<SignInResult>;
  /**
   * Token refresh, called only under the core's single per-connection lock.
   * The core increments `refresh_generation` for every successful refresh.
   */
  refresh(input: {
    connectionId: string;
    credential: EncryptedCredential;
  }): Promise<EncryptedCredential>;
  /** Usage responses or headers decoded into the shared quota model. */
  decodeQuota(input: {
    response: UsageResponse;
    observedAt: number;
    refreshGeneration: number;
  }): Omit<SubscriptionQuota, "revision">;
}

/**
 * How a provider's credential is obtained and kept valid. `oauth` renews
 * through refresh; `setup_token` is pasted once and may not renew; `api_key`
 * is a static key with no refresh (API-key connectors).
 */
export type CredentialKind = "oauth" | "setup_token" | "api_key";

/** How a provider reports usage limits to the shared quota model. */
export type QuotaKind =
  /** Rolling usage windows with reset times (subscriptions). */
  | "usage_windows"
  /** A spend budget in currency units (API-key connectors). */
  | "spend_budget"
  /** Request or token rate limits only, observed from refusals or headers. */
  | "rate_limits";

/**
 * The provider facts the shared subscription runtime needs, beyond the
 * connection surface: everything the core does is identical for every
 * provider, and these members are the only per-provider inputs. Shared core
 * modules receive an adapter as data and never branch on its `provider`.
 *
 * `Credential` is the decoded secret (OAuth tokens, a setup token, an API
 * key). The core stores only its encrypted encoding and never inspects it.
 */
export interface SubscriptionCoreAdapter<Credential = unknown> {
  readonly provider: ProviderId;
  /** Product name used in operator-facing error texts (never in routing). */
  readonly displayName: string;
  /** Capabilities of the provider's renewable credential format. */
  readonly capabilities: ProviderCapabilities;
  /**
   * Capabilities of one credential format, as `credential.format` derives it
   * from a decoded secret. The stored `credential_format` column is not that
   * format (the shared writers record the encryption envelope version there),
   * so callers derive it from the secret. The core never calls `refresh` for
   * a format whose `autoRenews` is false.
   */
  capabilitiesFor(credentialFormat: string): ProviderCapabilities;
  readonly credentialKind: CredentialKind;
  readonly quotaKind: QuotaKind;
  /** Provider identity used by workspace model policy for this provider's models. */
  readonly modelPolicyProviderId: string;
  /**
   * The workspace model policy's provider identity of one model, for a
   * provider whose models carry more than one (absent or null:
   * `modelPolicyProviderId`). Read through `subscriptionCoreModelPolicyProviderId`.
   */
  readonly modelPolicyProviderIdFor?: (modelId: ModelId) => string | null;
  /**
   * The prompt-cache lifetime placement keeps a session's account for
   * (SUB-STICK-04): an exact TTL Opengeni sends, or a documented idle cut-off.
   */
  readonly cacheFacts: DeclaredCacheFacts;
  /** Health policy applied to this provider's connections. */
  readonly health: {
    /** How long a connection the provider refused (forbidden) stays quarantined. */
    readonly forbiddenQuarantineMs: number;
    /** How long a model the plan is not entitled to stays cooled down. */
    readonly entitlementCooldownMs: number;
    /** How long a rate-limited connection rests when the provider gave no retry time. */
    readonly rateLimitFallbackMs: number;
    /**
     * How long an exhausted connection (usage limit or spend budget) rests
     * when the provider gave no reset. Placement retries it then, so a
     * connector without a usage reading still recovers on its own.
     */
    readonly exhaustedFallbackMs: number;
  };
  /** Plaintext codec for the encrypted credential column. */
  readonly credential: {
    /** Parse decrypted plaintext; throw fixed text (never echo the plaintext). */
    decode(plaintext: string): Credential;
    encode(credential: Credential): string;
    /** The expiry embedded in the credential (a JWT exp), used when the store has none. */
    expiry(credential: Credential): Date | null;
    /** The stored `credential_format` of a decoded credential. */
    format(credential: Credential): string;
  };
  /**
   * Credential renewal under the core's single per-connection lock. Null for
   * credentials that never renew (API keys, setup tokens without OAuth).
   */
  readonly refresh: CredentialRefresher<Credential> | null;
  /** Stored needs-relogin text for a provider message (fills an empty one). */
  reloginText(message: string): string;
  /**
   * Optional tier of one of the provider's models (D-35). With no explicit
   * fallback entry, placement derives a cross-provider order from equal
   * tiers. Absent, or null for a model: no tier, so nothing is derived for
   * or to that model and only explicit fallback entries apply.
   */
  modelTier?(modelId: ModelId): ModelTier | null;
  /**
   * Optional out-of-turn quota probe: read the provider's usage endpoint
   * with one connection's bearer. Every physical request goes through
   * `input.fetch` (the core's request custody). The response is opaque to
   * the core and decoded by `decodeQuota`.
   */
  fetchUsage?(input: SubscriptionCoreConnectionRead<Credential>): Promise<unknown>;
  /**
   * Decode a `fetchUsage` response into the shared quota model, fenced on
   * the refresh generation of the bearer that read it. Null when the
   * response carries no quota (an error payload or no windows).
   *
   * `modelIds`, when the caller passes it, lists the product models the
   * connection can serve when the response is decoded (the caller's
   * catalog), for providers whose usage reports limits of model groups
   * that become per-model cooldowns. Absent: no catalog is known, and only
   * models the response itself names can be cooled down.
   */
  decodeQuota?(input: {
    response: unknown;
    observedAt: number;
    refreshGeneration: number;
    modelIds?: readonly ModelId[];
  }): SubscriptionQuota | null;
  /**
   * The provider's usage endpoint is authoritative for its quota: a
   * `decodeQuota` reading below the limit ends a stored quota exhaustion
   * (`exhaustedKind: "quota"`) before its deadline, as an explicit,
   * revision-fenced store write. Absent: a running deadline is kept until
   * it passes (design 2.2).
   */
  usageReadEndsQuotaExhaustion?: boolean;
  /**
   * The provider's usage-endpoint readings are complete: each reports every
   * window that limits the connection, so a stored exhausted window that a
   * newer reading omits has ended and is dropped. Absent or false: a
   * reading may omit a window that still runs, and the shared quota merge
   * keeps an omitted exhausted window until its own reset (fail closed,
   * design 2.2). Response headers and refusals are always partial.
   */
  usageReadingsComplete?: boolean;
  /**
   * Optional live model catalog of one connection (provider model ids),
   * read with its bearer through `input.fetch`. Throws when the provider
   * refuses the credential.
   */
  liveModels?(input: SubscriptionCoreConnectionRead<Credential>): Promise<readonly ModelId[]>;
}

/** One connection's bearer as a connection read sees it. */
export type SubscriptionCoreConnectionBearer<Credential> = {
  /** The decoded, current credential. */
  credential: Credential;
  providerAccountId: string | null;
  /** Provider-owned connection facts; only the provider's adapter interprets them. */
  providerState: Record<string, unknown>;
};

/** What a connection read (usage, live catalog) receives from the core. */
export type SubscriptionCoreConnectionRead<Credential> = {
  /** The current bearer (refreshed under the core lock when stale). */
  getToken(): Promise<SubscriptionCoreConnectionBearer<Credential>>;
  /** A forced refresh under the core lock, after the provider refused the bearer. */
  refresh(): Promise<SubscriptionCoreConnectionBearer<Credential>>;
  /** A provider HTTP call under the core's request custody. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
};

/** Renewal of one credential; the core persists the result before anything else. */
export type CredentialRefresher<Credential> = {
  /** Refresh this long before the credential expires. */
  readonly windowMs: number;
  /** Refresh after this long when the expiry is unknown. */
  readonly fallbackMs: number;
  /** Call the provider and return the rotated credential. */
  rotate(credential: Credential): Promise<RotatedCredential<Credential>>;
  /**
   * The needs-relogin message when `error` is a permanent refusal of the
   * credential (revoked or expired refresh token), else null.
   */
  reloginMessage(error: unknown): string | null;
};

export type RotatedCredential<Credential> = {
  credential: Credential;
  expiresAt: Date | null;
  /** The plan the rotated credential reports, or null when it reports none. */
  planType: string | null;
};

/**
 * The refresher the core may call for one decoded credential: the adapter's
 * refresher when the credential's format renews, else null (the credential
 * is used until it expires or is refused, then needs a new sign-in).
 */
export function subscriptionCoreCredentialRefresher<Credential>(
  adapter: Pick<SubscriptionCoreAdapter<Credential>, "capabilitiesFor" | "credential" | "refresh">,
  credential: Credential,
): CredentialRefresher<Credential> | null {
  if (adapter.refresh === null) return null;
  return adapter.capabilitiesFor(adapter.credential.format(credential)).autoRenews
    ? adapter.refresh
    : null;
}

/** The workspace model policy's provider identity for one of the adapter's models. */
export function subscriptionCoreModelPolicyProviderId(
  adapter: Pick<SubscriptionCoreAdapter, "modelPolicyProviderId" | "modelPolicyProviderIdFor">,
  modelId: ModelId,
): string {
  return adapter.modelPolicyProviderIdFor?.(modelId) ?? adapter.modelPolicyProviderId;
}

/**
 * The model cooldown a refusal implies, or null when it limits the whole
 * connection (no `modelId`) or carries no time. `rate_limited` without a
 * known delay is not a cooldown: the connection's own rate-limit handling
 * applies.
 */
export function modelCooldownFromOutcome(
  outcome: ProviderErrorOutcome,
  now: number,
): { modelId: ModelId; until: number } | null {
  if (outcome.kind === "rate_limited") {
    if (outcome.modelId === undefined || outcome.retryAfterMs === null) return null;
    return { modelId: outcome.modelId, until: now + Math.max(0, outcome.retryAfterMs) };
  }
  if (outcome.kind === "exhausted") {
    if (outcome.modelId === undefined || outcome.resetAt === null) return null;
    return outcome.resetAt > now ? { modelId: outcome.modelId, until: outcome.resetAt } : null;
  }
  return null;
}
