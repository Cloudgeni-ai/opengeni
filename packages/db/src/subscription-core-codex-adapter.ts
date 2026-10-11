/**
 * Codex on the shared subscription core: the adapter that supplies every
 * Codex-specific input to the provider-neutral runtime (credential codec,
 * OAuth refresh, plan observation, relogin classification, health policy,
 * cache facts and capability flags), and the database binding.
 *
 * Core credential plaintext (the format the 0689 cutover mapped legacy rows
 * to): `credential_encrypted` holds the same `encryptEnvironmentValue` blob as
 * the legacy Codex tables, whose plaintext is the JSON object
 * `{ access_token, refresh_token, id_token }` with OpenAI's snake_case names.
 * `provider_account_id` is the ChatGPT account id sent as
 * `ChatGPT-Account-ID`, `provider_state.isFedramp` is the FedRAMP routing
 * flag (absent means false), and `plan_type` is the recorded ChatGPT plan.
 */
import { sql } from "drizzle-orm";
import {
  accessTokenExpiry,
  CODEX_CLIENT_VERSION,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexReloginRequired,
  fetchCodexUsage,
  normalizeCodexUsage,
  parseIdToken,
  refreshCodexToken,
  type CodexUsagePayload,
} from "@opengeni/codex";
import type { SubscriptionCoreAdapter, SubscriptionQuota } from "@opengeni/subscriptions";
import { withCodexTokenDeadline } from "./codex-token-resolver";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";
import {
  SubscriptionCoreCodexAccessLostError,
  SubscriptionCoreCodexLeaseLostError,
  SubscriptionCoreCodexOperationUnavailableError,
  SubscriptionCoreCodexOrganizationManagedError,
  SubscriptionCoreCodexRequestOutcomeUnknownError,
  SubscriptionCoreCodexSourceDisconnectedError,
  SubscriptionCoreCodexSourceRefusedError,
} from "./subscription-core-codex-errors";
import {
  SUBSCRIPTION_CORE_CODEX_PROVIDER,
  subscriptionCoreCodexReloginText,
} from "./subscription-core-codex-provider";

/** The decoded Codex credential. */
export type SubscriptionCoreCodexTokens = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
};

/** How long a connection Codex refused (forbidden) stays quarantined. */
export const SUBSCRIPTION_CORE_CODEX_FORBIDDEN_QUARANTINE_MS = 60 * 60 * 1000;
/** How long a model the Codex plan is not entitled to stays cooled down. */
export const SUBSCRIPTION_CORE_CODEX_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** The `credential_format` of a Codex connection: OAuth tokens, which renew. */
export const SUBSCRIPTION_CORE_CODEX_CREDENTIAL_FORMAT = "v1";

export type SubscriptionCoreCodexAdapterDeps = {
  /** The OAuth token refresh call (tests inject a scripted upstream). */
  refresh?: typeof refreshCodexToken;
};

export function subscriptionCoreCodexAdapter(
  deps: SubscriptionCoreCodexAdapterDeps = {},
): SubscriptionCoreAdapter<SubscriptionCoreCodexTokens> {
  const refresh = deps.refresh ?? refreshCodexToken;
  const capabilities = {
    autoRenews: true,
    resetCredits: true,
    extraCredits: true,
    modelEntitlements: true,
    realtime: true,
    fundsMedia: true,
    apps: true,
    remoteCompaction: true,
    quotaWindows: true,
  };
  return {
    provider: SUBSCRIPTION_CORE_CODEX_PROVIDER,
    displayName: "Codex",
    capabilities,
    // Codex has one credential format (OAuth tokens), and it renews.
    capabilitiesFor: () => capabilities,
    credentialKind: "oauth",
    quotaKind: "usage_windows",
    // Workspace model policy names Codex models by their resolved provider.
    modelPolicyProviderId: "codex-subscription",
    cacheFacts: { kind: "measured_idle_cutoff", cutoffMs: null },
    health: {
      forbiddenQuarantineMs: SUBSCRIPTION_CORE_CODEX_FORBIDDEN_QUARANTINE_MS,
      entitlementCooldownMs: SUBSCRIPTION_CORE_CODEX_ENTITLEMENT_COOLDOWN_MS,
    },
    credential: {
      decode(plaintext) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(plaintext);
        } catch {
          // Fixed text and no cause: a JSON.parse message quotes the plaintext
          // it failed on, and runtimes print a cause's message with the error.
          throw new Error("A core Codex credential could not be decrypted");
        }
        const record = parsed as Record<string, unknown> | null;
        if (
          !record ||
          typeof record.access_token !== "string" ||
          typeof record.refresh_token !== "string" ||
          typeof record.id_token !== "string"
        ) {
          throw new Error("A core Codex credential does not hold the expected token object");
        }
        return {
          accessToken: record.access_token,
          refreshToken: record.refresh_token,
          idToken: record.id_token,
        };
      },
      encode(tokens) {
        return JSON.stringify({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          id_token: tokens.idToken,
        });
      },
      expiry: (tokens) => accessTokenExpiry(tokens.accessToken),
      // The format the Codex writers store in `credential_format`.
      format: () => SUBSCRIPTION_CORE_CODEX_CREDENTIAL_FORMAT,
    },
    refresh: {
      windowMs: CODEX_REFRESH_WINDOW_MS,
      fallbackMs: CODEX_REFRESH_FALLBACK_MS,
      async rotate(tokens) {
        const next = await withCodexTokenDeadline(refresh(tokens.refreshToken));
        const rotated = {
          accessToken: next.accessToken ?? tokens.accessToken,
          refreshToken: next.refreshToken ?? tokens.refreshToken,
          idToken: next.idToken ?? tokens.idToken,
        };
        // The plan the rotated id_token carries is persisted with the token.
        // Parsing cannot fail the refresh: an unreadable token keeps the plan.
        let planType: string | null = null;
        try {
          planType = next.idToken ? parseIdToken(next.idToken).planType : null;
        } catch {
          planType = null;
        }
        return {
          credential: rotated,
          expiresAt: accessTokenExpiry(rotated.accessToken),
          planType,
        };
      },
      reloginMessage(error) {
        return error instanceof CodexReloginRequired ? error.message : null;
      },
    },
    reloginText: subscriptionCoreCodexReloginText,
    // Live usage from /wham/usage, normalized to the route payload; one
    // request with the resolved bearer (no refresh-and-retry, as in M3).
    async fetchUsage(read) {
      const token = await read.getToken();
      const response = await fetchCodexUsage(
        {
          accessToken: token.credential.accessToken,
          chatgptAccountId: token.providerAccountId,
          isFedramp: token.providerState.isFedramp === true,
          clientVersion: CODEX_CLIENT_VERSION,
        },
        read.fetch,
      );
      return normalizeCodexUsage(response.status, response.payload);
    },
    decodeQuota: ({ response, observedAt, refreshGeneration }) => {
      const usage = response as CodexUsagePayload;
      return usage.status === "error"
        ? null
        : codexUsageQuotaObservation(usage, refreshGeneration, observedAt);
    },
  };
}

function codexUsageWindow(id: string, percent: number, resetAt: string | null) {
  return {
    id,
    usedPercent: percent,
    resetsAt: resetAt ? new Date(resetAt).getTime() : null,
    status:
      percent >= 100
        ? ("exhausted" as const)
        : percent >= 90
          ? ("warning" as const)
          : ("ok" as const),
  };
}

/** The five-hour and weekly windows of a usage payload as a quota observation. */
function codexUsageQuotaObservation(
  usage: CodexUsagePayload,
  observedRefreshGeneration: number,
  observedAt: number,
): SubscriptionQuota | null {
  const windows = [
    ...(usage.fiveHour
      ? [codexUsageWindow("primary", usage.fiveHour.percent, usage.fiveHour.resetAt)]
      : []),
    ...(usage.weekly
      ? [codexUsageWindow("secondary", usage.weekly.percent, usage.weekly.resetAt)]
      : []),
  ];
  if (windows.length === 0) return null;
  return {
    windows,
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 0,
    observedAt,
    observedRefreshGeneration,
    source: "usage_endpoint",
  };
}

/** Codex's database binding on the shared core. */
export function subscriptionCoreCodexProvider(
  deps: SubscriptionCoreCodexAdapterDeps = {},
): SubscriptionCoreProvider<SubscriptionCoreCodexTokens> {
  return {
    adapter: subscriptionCoreCodexAdapter(deps),
    // A session whose history was compacted remotely continues on Codex only.
    sessionCompactionLock: sql`session.codex_compaction_mode = 'remote_v2'`,
    errors: {
      leaseLost: () => new SubscriptionCoreCodexLeaseLostError(),
      accessLost: () => new SubscriptionCoreCodexAccessLostError(),
      sourceDisconnected: () => new SubscriptionCoreCodexSourceDisconnectedError(),
      requestOutcomeUnknown: () => new SubscriptionCoreCodexRequestOutcomeUnknownError(),
      operationUnavailable: () => new SubscriptionCoreCodexOperationUnavailableError(),
      sourceRefused: (reason, message) =>
        new SubscriptionCoreCodexSourceRefusedError(message, reason),
      organizationManaged: () => new SubscriptionCoreCodexOrganizationManagedError(),
    },
    settings: { primaryColumn: "codex_primary_connection_id" },
  };
}

/** The registered Codex binding (the production refresh call). */
export const SUBSCRIPTION_CORE_CODEX: SubscriptionCoreProvider<SubscriptionCoreCodexTokens> =
  subscriptionCoreCodexProvider();
