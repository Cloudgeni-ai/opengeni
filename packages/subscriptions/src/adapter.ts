import type { CacheFacts, ModelId, ProviderId, SubscriptionQuota } from "./types";

/**
 * Provider differences are capability flags, never provider conditionals in
 * shared code (SUB-PROV-02).
 */
export type ProviderCapabilities = {
  /** The credential renews itself through refresh (false for setup tokens). */
  autoRenews: boolean;
  resetCredits: boolean;
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
