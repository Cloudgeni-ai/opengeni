/**
 * SuperGrok (provider id `xai`) on the shared subscription core: the adapter
 * that supplies every SuperGrok-specific input to the provider-neutral
 * runtime (credential codec, OAuth refresh, relogin classification, health
 * policy, cache facts and capability flags), and the database binding.
 *
 * Core credential plaintext (the format the SuperGrok cutover maps legacy
 * rows to): `credential_encrypted` holds the same `encryptEnvironmentValue`
 * blob as the legacy `xai_subscription_credentials` table, whose plaintext is
 * the JSON object `{ version: 1, accessToken, refreshToken? }`. The legacy
 * shape also allowed `sessionToken` and `cookie`, which no writer ever
 * stored and no reader uses; the core format drops them. The stored
 * `credential_format` is `xai_oauth_v1`. `provider_account_id` is the token
 * identity subject (the bearer's `userId`); SuperGrok has no plan type.
 *
 * The binding is not in the provider registry until the SuperGrok drained
 * cutover adds the SQL registry row with it (design 5.3, X3): until then
 * every shared runtime refuses it, and the worker never reaches it without
 * the `xai` cutover receipt.
 */
import {
  refreshXaiToken,
  xaiAccessTokenExpiry,
  XaiSubscriptionReloginRequired,
} from "@opengeni/xai-subscription";
import {
  XAI_REFRESH_FALLBACK_MS,
  XAI_REFRESH_WINDOW_MS,
  XAI_SUBSCRIPTION_PROVIDER_ID,
} from "@opengeni/xai-subscription";
import type { SubscriptionCoreAdapter } from "@opengeni/subscriptions";
import { subscriptionCoreDefaultErrors } from "./subscription-core/errors";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";

/** SuperGrok's provider id on the shared core and in the legacy tables. */
export const SUBSCRIPTION_CORE_XAI_PROVIDER = "xai";
/** The `credential_format` of a SuperGrok connection: OAuth tokens, which renew. */
export const SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT = "xai_oauth_v1";
/** How long a connection SuperGrok refused (forbidden) stays quarantined. */
export const SUBSCRIPTION_CORE_XAI_FORBIDDEN_QUARANTINE_MS = 60 * 60 * 1000;
/** SuperGrok has no plan entitlements; kept equal to Codex for the shared health policy. */
export const SUBSCRIPTION_CORE_XAI_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The decoded SuperGrok credential. */
export type SubscriptionCoreXaiTokens = {
  accessToken: string;
  /** Absent for a legacy row stored without one: it cannot renew and needs a new sign-in. */
  refreshToken: string | null;
};

const RELOGIN_TEXT = "The SuperGrok connection is no longer valid. Reconnect the account.";
const NOT_RENEWABLE_TEXT = "The SuperGrok connection cannot be refreshed. Reconnect the account.";

export type SubscriptionCoreXaiAdapterDeps = {
  /** The OAuth token refresh call (tests inject a scripted upstream). */
  refresh?: typeof refreshXaiToken;
};

/** Decode the stored plaintext; fixed texts, never echoing the plaintext. */
export function decodeSubscriptionCoreXaiCredential(plaintext: string): SubscriptionCoreXaiTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    // No cause: a JSON.parse message quotes the plaintext it failed on.
    throw new Error("A core SuperGrok credential could not be decrypted");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== 1 ||
    typeof record.accessToken !== "string" ||
    record.accessToken.length === 0 ||
    (record.refreshToken !== undefined &&
      record.refreshToken !== null &&
      typeof record.refreshToken !== "string")
  ) {
    throw new Error("A core SuperGrok credential does not hold the expected token object");
  }
  const refreshToken =
    typeof record.refreshToken === "string" && record.refreshToken.length > 0
      ? record.refreshToken
      : null;
  return { accessToken: record.accessToken, refreshToken };
}

/** Encode a credential as the stored plaintext (the legacy v1 object, OAuth fields only). */
export function encodeSubscriptionCoreXaiCredential(tokens: SubscriptionCoreXaiTokens): string {
  return JSON.stringify({
    version: 1,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  });
}

export function subscriptionCoreXaiAdapter(
  deps: SubscriptionCoreXaiAdapterDeps = {},
): SubscriptionCoreAdapter<SubscriptionCoreXaiTokens> {
  const refresh = deps.refresh ?? refreshXaiToken;
  const capabilities = {
    autoRenews: true,
    resetCredits: false,
    extraCredits: false,
    modelEntitlements: false,
    realtime: true,
    fundsMedia: true,
    apps: false,
    remoteCompaction: false,
    quotaWindows: true,
  };
  return {
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
    displayName: "SuperGrok",
    capabilities,
    // One stored format (OAuth tokens), which renews; a row without a
    // refresh token fails its refresh with a relogin instead.
    capabilitiesFor: () => capabilities,
    credentialKind: "oauth",
    quotaKind: "usage_windows",
    // Workspace model policy names SuperGrok models by their resolved provider.
    modelPolicyProviderId: XAI_SUBSCRIPTION_PROVIDER_ID,
    cacheFacts: { kind: "measured_idle_cutoff", cutoffMs: null },
    health: {
      forbiddenQuarantineMs: SUBSCRIPTION_CORE_XAI_FORBIDDEN_QUARANTINE_MS,
      entitlementCooldownMs: SUBSCRIPTION_CORE_XAI_ENTITLEMENT_COOLDOWN_MS,
    },
    credential: {
      decode: decodeSubscriptionCoreXaiCredential,
      encode: encodeSubscriptionCoreXaiCredential,
      expiry: (tokens) => xaiAccessTokenExpiry(tokens.accessToken),
      format: () => SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
    },
    refresh: {
      windowMs: XAI_REFRESH_WINDOW_MS,
      fallbackMs: XAI_REFRESH_FALLBACK_MS,
      async rotate(tokens) {
        if (!tokens.refreshToken) throw new XaiSubscriptionReloginRequired(NOT_RENEWABLE_TEXT);
        // The OAuth call is bounded by the package's own operation deadline.
        const next = await refresh(tokens.refreshToken);
        const rotated = {
          accessToken: next.accessToken,
          // xAI rotates the refresh token; the call keeps the old one when
          // the response omits it.
          refreshToken: next.refreshToken || tokens.refreshToken,
        };
        return {
          credential: rotated,
          expiresAt:
            xaiAccessTokenExpiry(rotated.accessToken) ??
            new Date(Date.now() + next.expiresInSeconds * 1_000),
          planType: null,
        };
      },
      reloginMessage(error) {
        return error instanceof XaiSubscriptionReloginRequired ? error.message : null;
      },
    },
    reloginText: (message) => (message.trim().length > 0 ? message : RELOGIN_TEXT),
  };
}

/** SuperGrok's database binding on the shared core. */
export function subscriptionCoreXaiProvider(
  deps: SubscriptionCoreXaiAdapterDeps = {},
): SubscriptionCoreProvider<SubscriptionCoreXaiTokens> {
  return {
    adapter: subscriptionCoreXaiAdapter(deps),
    // SuperGrok has no remote compaction state.
    sessionCompactionLock: null,
    errors: subscriptionCoreDefaultErrors("SuperGrok"),
    settings: { primaryColumn: "xai_primary_connection_id" },
  };
}

/** The SuperGrok binding (the production refresh call). */
export const SUBSCRIPTION_CORE_XAI: SubscriptionCoreProvider<SubscriptionCoreXaiTokens> =
  subscriptionCoreXaiProvider();
