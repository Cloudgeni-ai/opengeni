/**
 * Claude (provider id `claude`) on the shared subscription core: the adapter
 * that supplies every Claude-specific input to the provider-neutral runtime
 * (credential codec for OAuth and setup tokens, OAuth refresh, relogin
 * classification, health policy, exact cache lifetime, capability flags),
 * the decoding of Claude usage into the shared quota model, and the database
 * binding.
 *
 * Core credential plaintext (the format the Claude cutover maps legacy rows
 * to): the same `ClaudeSubscriptionCredential` JSON object the legacy
 * `claude_subscription_credentials` table stores,
 * `{ version: 1, token, identity: { accountUuid, deviceId }, oauth? }`. A
 * credential with `oauth` is stored as `claude_oauth_v1` and renews through
 * the OAuth refresh; one without it is a pasted setup token
 * (`claude_setup_token_v1`), which never renews: once Claude refuses it the
 * shared refresh marks the connection needs-relogin. `provider_account_id` is
 * the Claude account UUID, else the `oauth:`/`setup:` HMAC id the writers
 * already derive; setup tokens report no email or plan.
 *
 * The binding is not in the provider registry until the Claude drained
 * cutover adds the SQL registry row with it (design 5.3, C3): until then
 * every shared runtime refuses it, and the worker never reaches it without
 * the `claude` cutover receipt.
 */
import { ClaudeSubscriptionCredential, type ClaudeUsageObservation } from "@opengeni/config";
import type { z } from "zod";
import type { SubscriptionCoreAdapter, SubscriptionQuota } from "@opengeni/subscriptions";
import {
  ClaudeSubscriptionReconnectRequired,
  requestClaudeTokenRefresh,
} from "./claude-subscription-tokens";
import { subscriptionCoreDefaultErrors } from "./subscription-core/errors";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";

/** Claude's provider id on the shared core and in the legacy tables. */
export const SUBSCRIPTION_CORE_CLAUDE_PROVIDER = "claude";
/** The `credential_format` of an OAuth sign-in, which renews. */
export const SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT = "claude_oauth_v1";
/** The `credential_format` of a pasted setup token, which never renews. */
export const SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT = "claude_setup_token_v1";
/** Refresh this long before the OAuth token expires (the legacy resolver's margin). */
export const SUBSCRIPTION_CORE_CLAUDE_REFRESH_WINDOW_MS = 60 * 1000;
/** An OAuth credential always records its expiry; this bounds one that somehow does not. */
export const SUBSCRIPTION_CORE_CLAUDE_REFRESH_FALLBACK_MS = 60 * 60 * 1000;
/**
 * Claude's 403 is not an account refusal (decision 7: it never rotates
 * accounts), so this only bounds a forbidden outcome another path reports.
 */
export const SUBSCRIPTION_CORE_CLAUDE_FORBIDDEN_QUARANTINE_MS = 60 * 60 * 1000;
/** Claude has no plan entitlements; kept equal to the other providers. */
export const SUBSCRIPTION_CORE_CLAUDE_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A 429 without a retry time rests as long as the legacy backpressure delay. */
export const SUBSCRIPTION_CORE_CLAUDE_RATE_LIMIT_FALLBACK_MS = 60 * 1000;
/** A limit without a known reset is checked again after a minute, as the legacy capacity check does. */
export const SUBSCRIPTION_CORE_CLAUDE_UNKNOWN_RESET_MS = 60 * 1000;
/** The prompt-cache lifetime Opengeni sends on Claude requests (`cacheTtl: "5m"`). */
export const SUBSCRIPTION_CORE_CLAUDE_CACHE_TTL_MS = 5 * 60 * 1000;
/** The product model id prefixes of Claude subscription models (`claudeProviderId`). */
export const SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES = [
  "organization-claude-subscription",
  "workspace-claude-subscription",
] as const;

/** The decoded Claude credential (the legacy secret object, unchanged). */
export type SubscriptionCoreClaudeCredential = z.infer<typeof ClaudeSubscriptionCredential>;

const RELOGIN_TEXT = "Claude sign-in expired or was revoked. Sign in again in Models.";

export type SubscriptionCoreClaudeAdapterDeps = {
  /** The fetch the OAuth refresh uses (tests inject a scripted upstream). */
  fetch?: typeof fetch;
  now?: () => number;
};

/** Decode the stored plaintext; fixed texts, never echoing the plaintext. */
export function decodeSubscriptionCoreClaudeCredential(
  plaintext: string,
): SubscriptionCoreClaudeCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    // No cause: a JSON.parse message quotes the plaintext it failed on.
    throw new Error("A core Claude credential could not be decrypted");
  }
  const result = ClaudeSubscriptionCredential.safeParse(parsed);
  if (!result.success) {
    throw new Error("A core Claude credential does not hold the expected token object");
  }
  return result.data;
}

/** Encode a credential as the stored plaintext (the legacy object, field order kept). */
export function encodeSubscriptionCoreClaudeCredential(
  credential: SubscriptionCoreClaudeCredential,
): string {
  const parsed = ClaudeSubscriptionCredential.safeParse(credential);
  if (!parsed.success) throw new Error("A core Claude credential cannot be encoded");
  const { version, token, identity, oauth } = parsed.data;
  return JSON.stringify({ version, token, identity, ...(oauth ? { oauth } : {}) });
}

export function subscriptionCoreClaudeAdapter(
  deps: SubscriptionCoreClaudeAdapterDeps = {},
): SubscriptionCoreAdapter<SubscriptionCoreClaudeCredential> {
  const now = deps.now ?? Date.now;
  const capabilities = {
    autoRenews: true,
    resetCredits: false,
    // Claude's paid overage is the provider's own setting, read from its
    // usage reports (`decodeSubscriptionCoreClaudeQuota`), not a consent
    // Opengeni stores per connection.
    extraCredits: false,
    modelEntitlements: false,
    realtime: false,
    fundsMedia: false,
    apps: false,
    remoteCompaction: false,
    quotaWindows: true,
  };
  const setupTokenCapabilities = { ...capabilities, autoRenews: false };
  return {
    provider: SUBSCRIPTION_CORE_CLAUDE_PROVIDER,
    displayName: "Claude",
    capabilities,
    // Only an OAuth sign-in renews. Any other stored format, including one
    // this binary does not know, is never refreshed (fail closed).
    capabilitiesFor: (format) =>
      format === SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT ? capabilities : setupTokenCapabilities,
    credentialKind: "oauth",
    quotaKind: "usage_windows",
    modelPolicyProviderId: SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES[0],
    cacheFacts: { kind: "exact_ttl", ttlMs: SUBSCRIPTION_CORE_CLAUDE_CACHE_TTL_MS },
    health: {
      forbiddenQuarantineMs: SUBSCRIPTION_CORE_CLAUDE_FORBIDDEN_QUARANTINE_MS,
      entitlementCooldownMs: SUBSCRIPTION_CORE_CLAUDE_ENTITLEMENT_COOLDOWN_MS,
      rateLimitFallbackMs: SUBSCRIPTION_CORE_CLAUDE_RATE_LIMIT_FALLBACK_MS,
      exhaustedFallbackMs: SUBSCRIPTION_CORE_CLAUDE_UNKNOWN_RESET_MS,
    },
    credential: {
      decode: decodeSubscriptionCoreClaudeCredential,
      encode: encodeSubscriptionCoreClaudeCredential,
      expiry: (credential) => (credential.oauth ? new Date(credential.oauth.expiresAt) : null),
      format: (credential) =>
        credential.oauth
          ? SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT
          : SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT,
    },
    refresh: {
      windowMs: SUBSCRIPTION_CORE_CLAUDE_REFRESH_WINDOW_MS,
      fallbackMs: SUBSCRIPTION_CORE_CLAUDE_REFRESH_FALLBACK_MS,
      async rotate(credential) {
        // A setup token has no refresh token: never called for its format,
        // and refused as a relogin if it were.
        if (!credential.oauth) throw new ClaudeSubscriptionReconnectRequired();
        // The OAuth call has its own deadline and classifies a revoked grant
        // as ClaudeSubscriptionReconnectRequired, anything else as retryable.
        const tokens = await requestClaudeTokenRefresh(credential, deps.fetch ?? globalThis.fetch);
        const expiresAt = new Date(now() + tokens.expires_in * 1000);
        const rotated = ClaudeSubscriptionCredential.parse({
          ...credential,
          token: tokens.access_token,
          oauth: {
            ...credential.oauth,
            refreshToken: tokens.refresh_token ?? credential.oauth.refreshToken,
            expiresAt: expiresAt.toISOString(),
            scopes: tokens.scope.split(/\s+/).filter(Boolean),
          },
        });
        // Claude's refresh reports no plan; the recorded plan stays.
        return { credential: rotated, expiresAt, planType: null };
      },
      reloginMessage(error) {
        return error instanceof ClaudeSubscriptionReconnectRequired ? error.message : null;
      },
    },
    reloginText: (message) => (message.trim().length > 0 ? message : RELOGIN_TEXT),
  };
}

/** The product model ids a Claude upstream model id is served as. */
export function subscriptionCoreClaudeProductModelIds(upstreamModelId: string): string[] {
  return SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES.map((prefix) => `${prefix}/${upstreamModelId}`);
}

const ACCOUNT_WINDOWS = new Set(["five_hour", "seven_day"]);
const FAMILY_WINDOWS: Record<string, RegExp> = {
  seven_day_opus: /^claude-opus-/,
  seven_day_sonnet: /^claude-sonnet-/,
};
const allowed = (status: string | null | undefined) =>
  status === "allowed" || status === "allowed_warning";

/**
 * One Claude usage observation (response headers or the usage endpoint)
 * in the shared quota model, with the legacy capacity rules
 * (`claudeSubscriptionCapacity`):
 *
 * - The account windows (five hours, seven days) decide the connection's
 *   capacity: `rejected`, or full without a status, is `exhausted` until its
 *   reset (a minute when the reset is unknown).
 * - A model-family window (Opus, Sonnet) limits only that family: when full
 *   or rejected it becomes a cooldown of each listed model of the family, and
 *   the window itself is reported with `unknown` status so it never decides
 *   the account's capacity. The paid overage windows never block the plan.
 * - A rejected request limits the model it was made for (a cooldown of that
 *   model's product ids), or the whole connection when the model is unknown
 *   (`exhaustedUntil`, kind `quota`), unless the provider allowed paid
 *   overage for it. A rejected overage with an earlier reset is checked at
 *   that reset.
 *
 * `upstreamModelIds` lists the Claude models the organization offers, so a
 * family limit reaches each of them.
 */
export function decodeSubscriptionCoreClaudeQuota(input: {
  observation: ClaudeUsageObservation;
  refreshGeneration: number;
  upstreamModelIds: readonly string[];
}): Omit<SubscriptionQuota, "revision"> {
  const { observation } = input;
  const observedAt = Date.parse(observation.observedAt);
  const unknownReset = observedAt + SUBSCRIPTION_CORE_CLAUDE_UNKNOWN_RESET_MS;
  const modelCooldowns: Record<string, number> = {};
  const cool = (upstreamModelId: string, until: number) => {
    if (until <= observedAt) return;
    for (const modelId of subscriptionCoreClaudeProductModelIds(upstreamModelId)) {
      modelCooldowns[modelId] = Math.max(modelCooldowns[modelId] ?? until, until);
    }
  };
  const windows = observation.windows.map((window) => {
    const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
    const full =
      window.status === "rejected" || (window.status === null && (window.usedPercent ?? 0) >= 100);
    const family = FAMILY_WINDOWS[window.id];
    if (family && full) {
      for (const model of input.upstreamModelIds)
        if (family.test(model)) cool(model, resetsAt ?? unknownReset);
    }
    const status = !ACCOUNT_WINDOWS.has(window.id)
      ? ("unknown" as const)
      : full
        ? ("exhausted" as const)
        : window.status === "allowed_warning"
          ? ("warning" as const)
          : window.status === "allowed" || window.usedPercent !== null
            ? ("ok" as const)
            : ("unknown" as const);
    return {
      id: window.id,
      usedPercent: window.usedPercent,
      resetsAt: status === "exhausted" ? (resetsAt ?? unknownReset) : resetsAt,
      status,
    };
  });
  let exhaustedUntil: number | null = null;
  const request = observation.requestStatus;
  if (request?.status === "rejected" && !allowed(request.overageStatus)) {
    let until = request.resetsAt === null ? unknownReset : Date.parse(request.resetsAt);
    if (request.overageStatus === "rejected" && request.overageResetsAt !== null) {
      until = Math.min(until, Date.parse(request.overageResetsAt));
    }
    if (request.upstreamModelId !== null) cool(request.upstreamModelId, until);
    else if (until > observedAt) exhaustedUntil = until;
  }
  return {
    windows,
    modelCooldowns,
    exhaustedUntil,
    exhaustedKind: exhaustedUntil === null ? null : "quota",
    observedAt,
    observedRefreshGeneration: input.refreshGeneration,
    source: observation.source === "provider" ? "usage_endpoint" : "response_headers",
  };
}

/** Claude's database binding on the shared core. */
export function subscriptionCoreClaudeProvider(
  deps: SubscriptionCoreClaudeAdapterDeps = {},
): SubscriptionCoreProvider<SubscriptionCoreClaudeCredential> {
  return {
    adapter: subscriptionCoreClaudeAdapter(deps),
    // Claude has no remote compaction state.
    sessionCompactionLock: null,
    errors: subscriptionCoreDefaultErrors("Claude"),
    settings: { primaryColumn: "claude_primary_connection_id" },
  };
}

/** The Claude binding (the production refresh call). */
export const SUBSCRIPTION_CORE_CLAUDE: SubscriptionCoreProvider<SubscriptionCoreClaudeCredential> =
  subscriptionCoreClaudeProvider();
