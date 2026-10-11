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
 * credential with `oauth` has the format `claude_oauth_v1` and renews
 * through the OAuth refresh; one without it is a pasted setup token
 * (`claude_setup_token_v1`), which never renews: once Claude refuses it the
 * shared refresh marks the connection needs-relogin. The format is derived
 * from the decoded secret (`credential.format`) whenever the core decides
 * renewal; the stored `credential_format` column is informational only
 * (the cutover records `claude_oauth_v1` / `claude_setup_token_v1`, the
 * shared connect and reconnect writers record the envelope version `v1`)
 * and is never passed to `capabilitiesFor`. `provider_account_id` is
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
  claudeRefreshedCredential,
  ClaudeSubscriptionReconnectRequired,
  requestClaudeTokenRefresh,
} from "./subscription-core-claude-oauth";
import { subscriptionCoreDefaultErrors } from "./subscription-core/errors";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";

/** Claude's provider id on the shared core and in the legacy tables. */
export const SUBSCRIPTION_CORE_CLAUDE_PROVIDER = "claude";
/** The credential format of an OAuth sign-in, which renews (derived from the decoded secret). */
export const SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT = "claude_oauth_v1";
/** The credential format of a pasted setup token, which never renews. */
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
    throw new Error("A core Claude credential is not valid JSON");
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
    // Workspace model policy names Claude models by their scope-specific
    // provider id: a workspace-scoped model keeps its own policy.
    modelPolicyProviderId: SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES[0],
    modelPolicyProviderIdFor: subscriptionCoreClaudeModelPolicyProviderId,
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
        const rotated = claudeRefreshedCredential(credential, tokens, now());
        // Claude's refresh reports no plan; the recorded plan stays.
        return { ...rotated, planType: null };
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

/**
 * The workspace-policy provider id of a Claude product model: its own
 * prefix (`workspace-claude-subscription` or
 * `organization-claude-subscription`), the organization id otherwise.
 */
export function subscriptionCoreClaudeModelPolicyProviderId(modelId: string): string {
  const prefix = modelId.slice(0, Math.max(0, modelId.indexOf("/")));
  return (SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES as readonly string[]).includes(prefix)
    ? prefix
    : SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES[0];
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
 * (`claudeSubscriptionCapacity`, applied to the one response observed):
 *
 * - Paid overage the response allowed covers every plan limit it reports:
 *   a full account window is a `warning`, and no family or request limit
 *   blocks. Overage is the Claude account's own setting, so it covers every
 *   model of the account.
 * - A rejected request whose overage was refused with a known reset before
 *   its own plan reset is checked again at the overage reset (while its plan
 *   limit still runs): the blocks that response reports for the models it
 *   concerns (its own model; without one, the family its limit names, else
 *   every model) end no later than it.
 * - The account windows (five hours, seven days) decide the connection's
 *   capacity: `rejected`, or full without a status, is `exhausted` until its
 *   reset (a minute when the reset is unknown).
 * - A model-family window (Opus, Sonnet) limits only that family: when full
 *   or rejected it becomes a cooldown of each listed model of the family, and
 *   the window itself is reported with `unknown` status so it never decides
 *   the account's capacity. The paid overage windows never block.
 * - A rejected request, and each rejected request restriction the
 *   observation carries (unless a later allowance of the same model lifts
 *   it), limits the model it was made for (a cooldown of that model's
 *   product ids); without a model, the family its limit names, else the
 *   whole connection (`exhaustedUntil`, kind `quota`).
 * - The model a response was allowed for dispatches whatever else that
 *   response reports, until the allowance's reset (a limit outlasting it
 *   limits that model too, from now).
 * - When some models are judged apart (an allowed model, or a recheck that
 *   concerns only some models), an account limit cools the listed models
 *   one by one instead of exhausting the connection, and the window is a
 *   `warning`.
 *
 * `upstreamModelIds` must list every Claude model the connection can serve
 * (the organization's catalog when decoded), so a family limit reaches each
 * of them; the response's own model is always included.
 */
export function decodeSubscriptionCoreClaudeQuota(input: {
  observation: ClaudeUsageObservation;
  refreshGeneration: number;
  upstreamModelIds: readonly string[];
}): Omit<SubscriptionQuota, "revision"> {
  const { observation } = input;
  const observedAt = Date.parse(observation.observedAt);
  const request = observation.requestStatus ?? null;
  const rejected = request?.status === "rejected";
  const own = request?.upstreamModelId ?? null;
  const overageReset = request?.overageResetsAt ? Date.parse(request.overageResetsAt) : null;
  const overageCovers =
    rejected && allowed(request.overageStatus) && (overageReset ?? Infinity) > observedAt;
  const base = (reset: string | null, at: string) =>
    reset === null ? Date.parse(at) + SUBSCRIPTION_CORE_CLAUDE_UNKNOWN_RESET_MS : Date.parse(reset);
  // Only while the request's own plan limit still runs, and only when the
  // overage resets first: a later overage reset never ends another limit.
  const planReset = rejected ? base(request.resetsAt, request.observedAt) : -Infinity;
  const recheck =
    rejected &&
    request.overageStatus === "rejected" &&
    planReset > observedAt &&
    overageReset !== null &&
    overageReset < planReset
      ? overageReset
      : null;
  const recheckFamily =
    own === null && request?.representativeClaim
      ? FAMILY_WINDOWS[request.representativeClaim]
      : undefined;
  /** The latest a block of this model (null: the connection) may run. */
  const capOf = (model: string | null) =>
    recheck === null
      ? Infinity
      : own !== null
        ? model === own
          ? recheck
          : Infinity
        : recheckFamily
          ? model !== null && recheckFamily.test(model)
            ? recheck
            : Infinity
          : recheck;
  // The model this response was allowed for dispatches whatever else it
  // reports, until the allowance's own reset (a minute when unknown).
  const spared = request && allowed(request.status) ? own : null;
  const allowanceEnd =
    spared === null
      ? -Infinity
      : request?.resetsAt
        ? Date.parse(request.resetsAt)
        : observedAt + SUBSCRIPTION_CORE_CLAUDE_UNKNOWN_RESET_MS;
  const perModel = spared !== null || (recheck !== null && capOf(null) === Infinity);
  // The response's own model is limited by its family's window even when the
  // listed catalog misses it.
  const listed = [...new Set([...input.upstreamModelIds, ...(own ? [own] : [])])];
  const modelCooldowns: Record<string, number> = {};
  const cool = (upstreamModelId: string, limit: number) => {
    const end = Math.min(limit, capOf(upstreamModelId));
    if (end <= observedAt || (upstreamModelId === spared && end <= allowanceEnd)) return;
    for (const modelId of subscriptionCoreClaudeProductModelIds(upstreamModelId)) {
      modelCooldowns[modelId] = Math.max(modelCooldowns[modelId] ?? end, end);
    }
  };
  let exhaustedUntil: number | null = null;
  const block = (model: string | null, claim: string | null, limit: number) => {
    const family = claim === null ? undefined : FAMILY_WINDOWS[claim];
    if (model !== null) cool(model, limit);
    else if (family || perModel) {
      for (const id of listed) if (!family || family.test(id)) cool(id, limit);
    } else {
      const end = Math.min(limit, capOf(null));
      if (end > observedAt) exhaustedUntil = Math.max(exhaustedUntil ?? end, end);
    }
  };
  const windows = observation.windows.map((window) => {
    const full =
      !overageCovers &&
      (window.status === "rejected" ||
        (window.status === null && (window.usedPercent ?? 0) >= 100));
    const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
    const account = ACCOUNT_WINDOWS.has(window.id);
    // Only plan windows block: a family window its family, an account window
    // the connection (or, judged per model, each listed model).
    if (full && (FAMILY_WINDOWS[window.id] !== undefined || (account && perModel)))
      block(null, window.id, base(window.resetsAt, window.observedAt));
    const status = !account
      ? ("unknown" as const)
      : full && !perModel
        ? ("exhausted" as const)
        : full || overageCovers || window.status === "allowed_warning"
          ? ("warning" as const)
          : window.status === "allowed" || window.usedPercent !== null
            ? ("ok" as const)
            : ("unknown" as const);
    return {
      id: window.id,
      usedPercent: window.usedPercent,
      resetsAt:
        status === "exhausted"
          ? Math.min(base(window.resetsAt, window.observedAt), capOf(null))
          : resetsAt,
      status,
    };
  });
  if (rejected && !overageCovers) {
    block(own, request.representativeClaim, base(request.resetsAt, request.observedAt));
  }
  const restrictions = observation.requestRestrictions ?? [];
  for (const item of restrictions) {
    if (item.status !== "rejected") continue;
    // Restrictions carry no overage of their own: the response's allowed
    // overage covers those it postdates, and a later allowance of the same
    // model lifts its restriction.
    if (overageCovers && item.observedAt <= request.observedAt) continue;
    const lifted = restrictions.some(
      (other) =>
        item.upstreamModelId !== null &&
        other.upstreamModelId === item.upstreamModelId &&
        allowed(other.status) &&
        other.observedAt > item.observedAt,
    );
    if (!lifted)
      block(item.upstreamModelId, item.representativeClaim, base(item.resetsAt, item.observedAt));
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
