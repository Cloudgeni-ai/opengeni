import type { CacheFacts, ModelId, ProviderId, SubscriptionQuota } from "./types";

/**
 * Provider differences are capability flags, never provider conditionals in
 * shared code (SUB-PROV-02).
 */
export type ProviderCapabilities = {
  /** The credential renews itself through refresh (false for setup tokens). */
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

/** Shared error outcomes every adapter classifies into (SUB-PROV-01). */
export type ProviderErrorOutcome =
  | { kind: "exhausted"; resetAt: number | null }
  | { kind: "rate_limited"; retryAfterMs: number | null }
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
  readonly capabilities: ProviderCapabilities;
  readonly credentialKind: CredentialKind;
  readonly quotaKind: QuotaKind;
  /** Provider identity used by workspace model policy for this provider's models. */
  readonly modelPolicyProviderId: string;
  /** Cache behaviour used by placement (exact TTL or a measured idle cut-off). */
  readonly cacheFacts: CacheFacts;
  /** Health policy applied to this provider's connections. */
  readonly health: {
    /** How long a connection the provider refused (forbidden) stays quarantined. */
    readonly forbiddenQuarantineMs: number;
    /** How long a model the plan is not entitled to stays cooled down. */
    readonly entitlementCooldownMs: number;
  };
  /** Plaintext codec for the encrypted credential column. */
  readonly credential: {
    /** Parse decrypted plaintext; throw fixed text (never echo the plaintext). */
    decode(plaintext: string): Credential;
    encode(credential: Credential): string;
    /** The expiry embedded in the credential (a JWT exp), used when the store has none. */
    expiry(credential: Credential): Date | null;
  };
  /**
   * Credential renewal under the core's single per-connection lock. Null for
   * credentials that never renew (API keys, setup tokens without OAuth).
   */
  readonly refresh: CredentialRefresher<Credential> | null;
  /** Stored needs-relogin text for a provider message (fills an empty one). */
  reloginText(message: string): string;
}

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
