import type { CodexRateLimitResetCreditsAccountResult } from "@opengeni/db";
import type { CodexResetRedemptionRecovery } from "@opengeni/db";
// Codex (ChatGPT) subscription connect / status / usage routes.
//
// Connect uses the device-code flow split into two stateless calls: `start`
// returns a user code + verification URL and an HMAC-signed state carrying the
// device_auth_id; the client opens the URL, authorizes, then drives `poll` on the
// returned interval. No browser redirect and no 15-minute server block, so nothing
// is added to isAuthExempt. Secrets never leave the server: status/usage read the
// decrypted token only to call the codex backend; the token is never returned.

import {
  environmentsEncryptionKeyBytes,
  configuredModels,
  getSettings,
  productLabelForModelId,
  withCodexCatalogProvider,
  type Settings,
} from "@opengeni/config";
import {
  accessTokenExpiry,
  buildCodexUsageWindowFromCache,
  CODEX_CLIENT_VERSION,
  CODEX_FIVE_HOUR_WINDOW_SECONDS,
  CODEX_PROVIDER_ID,
  CODEX_WEEKLY_WINDOW_SECONDS,
  CodexDeviceError,
  CodexReloginRequired,
  consumeCodexRateLimitResetCredit,
  exchangeDeviceCode,
  fetchCodexRateLimitResetCredits,
  parseIdToken,
  pollDeviceCode,
  startDeviceCode,
  type CodexUsagePayload,
  type CodexFetch,
  type CodexRateLimitResetCredit,
  type CodexRateLimitResetCreditsDetails,
} from "@opengeni/codex";
import {
  abandonCodexResetRedemptionBeforeProvider,
  adoptCodexResetRedemptionAttempt,
  buildSubscriptionCoreCodexConnectionTokenResolver,
  completeSubscriptionCoreCodexResetRedemption,
  deliverSubscriptionCoreCodexWake,
  fenceSubscriptionCoreCodexResetCredit,
  fetchSubscriptionCoreCodexUsage,
  getSubscriptionCoreCodexWorkspaceProjection,
  listSubscriptionCoreCodexResetRedemptionRecoveries,
  readSubscriptionCoreCodexResetAuthority,
  resolveSubscriptionCoreCodexConnectionId,
  subscriptionCoreCodexResetAuthority,
  subscriptionCoreCodexResetCreditFence,
  SubscriptionCoreCodexOperationUnavailableError,
  withSessionRlsActorContext,
  claimCodexResetRedemption,
  assertOrganizationCodexAdministrator,
  encryptEnvironmentValue,
  fetchOrganizationCodexUsageForAccount,
  fenceCodexResetRedemptionSend,
  getCodexResetRedemptionAttempt,
  nestedPostgresSqlState,
  releaseCodexResetRedemptionClaim,
  activeCodexPlanExclusions,
  type CodexAccountStatus,
} from "@opengeni/db";

// The picker surfaces codex models under their own "no credits" provider group so
// they read distinctly from the platform provider's same-named model.
const CODEX_PROVIDER_LABEL = "Codex subscription · no credits";

// The wire shape for one Codex account (metadata only; never the secret column).
// P2: fiveHour/weekly ride along, built from the CACHED usage columns (zero
// provider calls, zero decrypts) so the bars render instantly off this read.
export function codexAccountJson(
  row: CodexAccountStatus,
  options: {
    appsCredentialId?: string | null;
    canManageApps?: boolean;
    humanSubjectId?: string | null;
  } = {},
) {
  return {
    id: row.id,
    source: row.source,
    chatgptAccountId: row.chatgptAccountId,
    label: row.label,
    email: row.accountEmail,
    plan: row.planType,
    planCheckedAt: row.planCheckedAt ?? null,
    // The most recent observed plan change (for example "pro" before a move to
    // "free"), kept as evidence until the plan changes again.
    planChangedFrom: row.planPreviousType ?? null,
    planChangedAt: row.planChangedAt ?? null,
    // Models the CURRENT plan was proven not to include. Each leaves automatic
    // selection until `retryAfter` (one request then re-checks it) or until a
    // different plan is observed (refresh usage after an upgrade).
    planExcludedModels: activeCodexPlanExclusions(row, new Date()).map((entry) => ({
      model: entry.modelId,
      label: productLabelForModelId(entry.modelId),
      excludedAt: entry.excludedAt,
      retryAfter: entry.expiresAt,
    })),
    status: row.status,
    active: row.isActive,
    expiresAt: row.expiresAt,
    lastRefreshAt: row.lastRefreshAt,
    lastError: row.lastError,
    fiveHour: buildCodexUsageWindowFromCache(
      row.primaryUsedPercent,
      row.primaryResetAt,
      CODEX_FIVE_HOUR_WINDOW_SECONDS,
    ),
    weekly: buildCodexUsageWindowFromCache(
      row.secondaryUsedPercent,
      row.secondaryResetAt,
      CODEX_WEEKLY_WINDOW_SECONDS,
    ),
    usageCheckedAt: row.usageCheckedAt,
    extraCreditsEnabled: row.extraCreditsEnabled ?? false,
    extraCreditsVersion: row.extraCreditsVersion ?? 1,
    extraCreditsUpdatedAt: row.extraCreditsUpdatedAt ?? null,
    allocatorEnabled: row.allocatorEnabled,
    allocatorVersion: row.allocatorVersion,
    allocatorUpdatedAt: row.allocatorUpdatedAt,
    resetCreditAvailableCount: row.resetCreditAvailableCount,
    resetCreditsCheckedAt: row.resetCreditsCheckedAt,
    // P3 rotation cooldown: when set and in the future, this account is cooling-down.
    exhaustedUntil: row.exhaustedUntil,
    appsDesignated: options.appsCredentialId === row.id,
    canEnableApps:
      row.source === "workspace" &&
      options.appsCredentialId === null &&
      options.canManageApps === true &&
      options.humanSubjectId !== null &&
      options.humanSubjectId !== undefined &&
      row.connectedBySubjectId === options.humanSubjectId &&
      row.status === "active",
  };
}

/**
 * Derive the two distinct cached worker-readiness meanings exposed by the
 * status route. `poolReady` means at least one effective-pool account passes
 * the worker's cached admission predicate. `workerRoutable` additionally
 * honors rotation-off's active-pointer-only rule; it says nothing about a
 * session-specific manual pin.
 */
export function codexWorkerReadiness(input: {
  effectiveSource: "workspace" | "organization" | "disabled";
  rotationEnabled: boolean;
  activeCredentialId: string | null;
  accounts: ReadonlyArray<
    Pick<
      CodexAccountStatus,
      | "id"
      | "status"
      | "allocatorEnabled"
      | "primaryUsedPercent"
      | "primaryResetAt"
      | "secondaryUsedPercent"
      | "secondaryResetAt"
      | "exhaustedUntil"
    >
  >;
  now: Date;
}): { poolReady: boolean; workerRoutable: boolean } {
  if (input.effectiveSource === "disabled") {
    return { poolReady: false, workerRoutable: false };
  }
  const windowUsed = (used: number | null, resetAt: Date | null): number =>
    resetAt !== null && resetAt.getTime() <= input.now.getTime() ? 0 : (used ?? 0);
  const eligible = (account: (typeof input.accounts)[number]): boolean =>
    account.status === "active" &&
    account.allocatorEnabled &&
    (account.exhaustedUntil === null || account.exhaustedUntil.getTime() <= input.now.getTime()) &&
    Math.max(
      windowUsed(account.primaryUsedPercent, account.primaryResetAt),
      windowUsed(account.secondaryUsedPercent, account.secondaryResetAt),
    ) < 100;
  const poolReady = input.accounts.some(eligible);
  const activePointerReady = input.accounts.some(
    (account) => account.id === input.activeCredentialId && eligible(account),
  );
  return {
    poolReady,
    workerRoutable: input.rotationEnabled ? poolReady : activePointerReady,
  };
}

// The /codex/usage{,/refresh,/:id} wire wrapper: the rich normalized payload
// carries its own `status`, surfaced at the top level for back-compat with the
// existing CodexUsage = { status; usage } shape.
export function codexUsageJson(payload: CodexUsagePayload): {
  status: CodexUsagePayload["status"];
  usage: CodexUsagePayload;
} {
  return { status: payload.status, usage: payload };
}

export function codexModelsForPicker(
  settings: Settings = getSettings(),
  supportedSlugs?: readonly string[],
): Array<{
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  api: "responses";
}> {
  return configuredModels(withCodexCatalogProvider(settings))
    .filter(
      (model) =>
        model.providerId === CODEX_PROVIDER_ID &&
        (supportedSlugs === undefined || supportedSlugs.includes(model.upstreamModelId)),
    )
    .map((model) => ({
      id: model.id,
      label: model.label,
      provider: CODEX_PROVIDER_ID,
      providerLabel: CODEX_PROVIDER_LABEL,
      api: "responses" as const,
    }));
}
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  getManagedSession,
  hasPermission,
  requireAccessGrant,
  requireCanonicalLocalAccountAdministrator,
  resolveCatalogSettings,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import {
  codexRouteDisposition,
  coreCodexUsage,
  coreCodexUsageRefresh,
  coreCodexAccounts,
  coreCodexActivate,
  coreCodexAllocator,
  coreCodexExtraCredits,
  coreCodexClearApps,
  coreCodexConnected,
  coreCodexDesignateApps,
  coreCodexDisconnect,
  coreCodexDisconnectAll,
  coreCodexRename,
  coreCodexSetRotation,
  coreCodexSetSource,
  coreCodexSource,
  coreCodexStatus,
  coreOrganizationCodexAccounts,
} from "./codex-core";
import { HTTPException } from "hono/http-exception";
import {
  agentActingAsPerson,
  agentActingAsPersonBeforeGrantCheck,
  isAgentActingAsPerson,
  organizationSettingsPermission,
  requireNotAgent,
} from "../http/acting-person";
import * as z from "zod/v4";
import {
  hashCodexBrowserSession,
  signCodexRedemptionConfirmation,
  verifyCodexRedemptionConfirmation,
} from "../codex-redemption-security";

const CODEX_OVERVIEW_STALE_MS = 15 * 60_000;
const CODEX_REDEMPTION_CONFIRMATION_SECONDS = 5 * 60;
const CODEX_REDEMPTION_CONFIRMATION = "REDEEM_USAGE_LIMIT_RESET";

const redemptionPrepareBody = z.object({
  attemptId: z.string().uuid(),
  creditId: z.string().min(1).max(1024),
});
const redemptionBody = redemptionPrepareBody.extend({
  confirmationToken: z.string().min(1).max(8192),
  confirmation: z.literal(CODEX_REDEMPTION_CONFIRMATION),
});

type ManagedCookieHuman = {
  subjectId: string;
  browserSessionHash: string;
};

export async function managedCookieHuman(
  c: Context,
  deps: ApiRouteDeps,
): Promise<ManagedCookieHuman | null> {
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !c.req.header("cookie") ||
    c.req.header("authorization")
  ) {
    return null;
  }
  const session = await getManagedSession(c, deps.managedAuth, {
    db: deps.db,
    sessionAdapter: deps.managedAuthSessionAdapter,
    sessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
  if (!session?.user?.id || !session.session?.id) return null;
  return {
    subjectId: `user:${session.user.id}`,
    browserSessionHash: await hashCodexBrowserSession(session.session.id),
  };
}

/**
 * The person in this browser, or an agent acting as them. Only for routes that
 * then require the same person's workspace grant; provider sign-in steps keep
 * managedCookieHuman. An agent has no browser session, so its hash never
 * matches a sign-in started in one.
 */
export async function managedHumanOrAgent(
  c: Context,
  deps: ApiRouteDeps,
): Promise<ManagedCookieHuman | null> {
  const human = await managedCookieHuman(c, deps);
  if (human) return human;
  const agent = agentActingAsPersonBeforeGrantCheck(c);
  return agent
    ? {
        subjectId: agent.subjectId,
        browserSessionHash: await hashCodexBrowserSession(`agent:${crypto.randomUUID()}`),
      }
    : null;
}

export async function requireOrganizationCodexHuman(
  c: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  options: {
    /** A provider sign-in step: the person does it in the browser, never an agent. */
    providerConsent?: boolean;
  } = {},
): Promise<ManagedCookieHuman> {
  if (options.providerConsent) requireNotAgent(c, "Signing in to a provider");
  const parsed = z.string().uuid().safeParse(organizationId);
  if (!parsed.success) throw new HTTPException(422, { message: "invalid organization id" });
  let human = await managedCookieHuman(c, deps);
  if (!human) {
    const agent = agentActingAsPerson(c, parsed.data, organizationSettingsPermission(c));
    // An agent has no browser session, so it never matches a sign-in started in one.
    if (agent) {
      human = {
        subjectId: agent.subjectId,
        browserSessionHash: await hashCodexBrowserSession(`agent:${crypto.randomUUID()}`),
      };
    }
  }
  if (!human && deps.settings.productAccessMode === "local") {
    const local = await requireCanonicalLocalAccountAdministrator(c, deps, organizationId);
    human = {
      subjectId: local.subjectId,
      browserSessionHash: await hashCodexBrowserSession(`local:${local.subjectId}`),
    };
  }
  if (!human) {
    throw new HTTPException(401, {
      message: "organization administrator session required",
    });
  }
  try {
    // The generic organization administrator check only: after 0680 the
    // legacy organization Codex tables must not be read on this path.
    await assertOrganizationCodexAdministrator(deps.db, {
      organizationId,
      actorSubjectId: human.subjectId,
    });
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state === "42501") {
      throw new HTTPException(403, {
        message: "organization administration is not authorized",
      });
    }
    if (state === "P0002") {
      throw new HTTPException(404, { message: "organization not found" });
    }
    throw error;
  }
  return human;
}

export function requireSameOriginBrowserMutation(c: Context, deps: ApiRouteDeps): void {
  // Built in process for an agent acting as a person: no browser credentials
  // ride along, so there is no cross-site request to guard against.
  if (isAgentActingAsPerson(c)) return;
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HTTPException(403, {
      message: "JSON browser request required",
    });
  }
  if (deps.settings.productAccessMode !== "local" && !deps.settings.publicBaseUrl) {
    throw new HTTPException(503, {
      message: "managed browser origin is not configured",
    });
  }
  const origin = c.req.header("origin");
  const localOriginMatches =
    deps.settings.productAccessMode === "local" && localBrowserOriginMatchesRequest(c, origin);
  if (
    deps.settings.productAccessMode === "local"
      ? !localOriginMatches
      : origin !== new URL(deps.settings.publicBaseUrl!).origin
  ) {
    throw new HTTPException(403, {
      message: "same-origin browser request required",
    });
  }
  const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
  const localFetchSiteMatches =
    localOriginMatches &&
    (fetchSite === "same-origin" ||
      fetchSite === "same-site" ||
      (fetchSite === "cross-site" && localLoopbackOriginMatchesRequest(c, origin)));
  if (
    deps.settings.productAccessMode === "local"
      ? !localFetchSiteMatches
      : fetchSite !== "same-origin"
  ) {
    throw new HTTPException(403, {
      message: "same-origin fetch metadata required",
    });
  }
}

function localBrowserOriginMatchesRequest(c: Context, value: string | undefined): boolean {
  if (!value) return false;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  if (
    origin.origin !== value ||
    origin.origin === "null" ||
    (origin.protocol !== "http:" && origin.protocol !== "https:")
  ) {
    return false;
  }

  const forwardedProtocol = c.req.header("x-forwarded-proto")?.trim().toLowerCase();
  const protocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(c.req.url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return false;
  const forwardedHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!forwardedHost || /[\s,/?#@\\]/u.test(forwardedHost)) return false;

  let request: URL;
  try {
    request = new URL(`${protocol}//${forwardedHost}`);
  } catch {
    return false;
  }
  return (
    origin.protocol === request.protocol &&
    (origin.hostname === request.hostname ||
      (isLoopbackHostname(origin.hostname) && isLoopbackHostname(request.hostname)))
  );
}

function localLoopbackOriginMatchesRequest(c: Context, value: string | undefined): boolean {
  if (!value) return false;
  try {
    const origin = new URL(value);
    const forwardedProtocol = c.req.header("x-forwarded-proto")?.trim().toLowerCase();
    const protocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(c.req.url).protocol;
    const forwardedHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (!forwardedHost || /[\s,/?#@\\]/u.test(forwardedHost)) return false;
    const request = new URL(`${protocol}//${forwardedHost}`);
    return (
      origin.origin === value &&
      origin.protocol === request.protocol &&
      isLoopbackHostname(origin.hostname) &&
      isLoopbackHostname(request.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(value: string): boolean {
  return value === "localhost" || value === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/u.test(value);
}

async function requireRedemptionHuman(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<{ human: ManagedCookieHuman; accountId: string }> {
  if (deps.settings.productAccessMode !== "managed") {
    throw new HTTPException(403, {
      message: "reset redemption requires managed product mode",
    });
  }
  // An agent the person signed in (organization MCP) acts as that person and
  // may redeem, within the same exact-person grant check below. Its
  // confirmation binds to a stable per-person agent hash, which can never equal
  // a browser session hash.
  const agent = isAgentActingAsPerson(c) ? agentActingAsPersonBeforeGrantCheck(c) : null;
  if (!agent) {
    // Normal managed auth prefers a bearer over a cookie. This irreversible
    // route rejects the header before grant resolution so an API key or
    // delegated token can never borrow a browser cookie that happens to ride
    // along. Exact JSON content type plus Origin and Fetch Metadata fail closed.
    if (c.req.header("authorization")) {
      throw new HTTPException(403, {
        message: "authorization bearer is not allowed for redemption",
      });
    }
    requireSameOriginBrowserMutation(c, deps);
  }
  const human: ManagedCookieHuman | null = agent
    ? {
        subjectId: agent.subjectId,
        browserSessionHash: await hashCodexBrowserSession(`agent:${agent.subjectId}`),
      }
    : await managedCookieHuman(c, deps);
  if (!human) {
    throw new HTTPException(401, {
      message: "managed browser session required",
    });
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
  if (grant.subjectId !== human.subjectId) {
    throw new HTTPException(403, {
      message: "managed browser identity mismatch",
    });
  }
  return { human, accountId: grant.accountId };
}

export async function requireCodexAppsHuman(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<{ human: ManagedCookieHuman; accountId: string }> {
  if (c.req.header("authorization")) {
    throw new HTTPException(403, {
      message: "authorization bearer is not allowed for Codex Apps designation",
    });
  }
  requireSameOriginBrowserMutation(c, deps);
  const human = await managedHumanOrAgent(c, deps);
  if (!human) {
    throw new HTTPException(401, {
      message: "managed browser session required",
    });
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
  if (grant.subjectId !== human.subjectId) {
    throw new HTTPException(403, {
      message: "managed browser identity mismatch",
    });
  }
  return { human, accountId: grant.accountId };
}

function cachedUsage(row: CodexAccountStatus): CodexUsagePayload | null {
  const fiveHour = buildCodexUsageWindowFromCache(
    row.primaryUsedPercent,
    row.primaryResetAt,
    CODEX_FIVE_HOUR_WINDOW_SECONDS,
  );
  const weekly = buildCodexUsageWindowFromCache(
    row.secondaryUsedPercent,
    row.secondaryResetAt,
    CODEX_WEEKLY_WINDOW_SECONDS,
  );
  if (!fiveHour && !weekly && row.resetCreditAvailableCount == null) return null;
  const limitReached = (fiveHour?.percent ?? 0) >= 100 || (weekly?.percent ?? 0) >= 100;
  return {
    status: limitReached ? "limit_reached" : fiveHour || weekly ? "ok" : "no-data",
    planType: row.planType,
    fiveHour,
    weekly,
    limitReached,
    fetchedAt: (row.usageCheckedAt ?? row.resetCreditsCheckedAt ?? new Date(0)).toISOString(),
    rateLimitResetCredits:
      row.resetCreditAvailableCount == null
        ? null
        : { availableCount: row.resetCreditAvailableCount, credits: null },
  };
}

function staleAt(value: Date | null): boolean {
  return !value || Date.now() - value.getTime() > CODEX_OVERVIEW_STALE_MS;
}

function sortedCredits(credits: CodexRateLimitResetCredit[]): CodexRateLimitResetCredit[] {
  return [...credits].sort((left, right) => {
    if (left.expiresAt == null && right.expiresAt == null) return left.id.localeCompare(right.id);
    if (left.expiresAt == null) return 1;
    if (right.expiresAt == null) return -1;
    return left.expiresAt - right.expiresAt || left.id.localeCompare(right.id);
  });
}

function actionableCredit(credit: CodexRateLimitResetCredit, nowSeconds = Date.now() / 1000) {
  return (
    credit.resetType === "codexRateLimits" &&
    credit.status === "available" &&
    (credit.expiresAt == null || credit.expiresAt > nowSeconds)
  );
}

function freshActionableCredit(
  details: CodexRateLimitResetCreditsDetails,
  creditId: string,
): CodexRateLimitResetCredit | null {
  // `availableCount` counts available credits, while the provider detail array
  // may also retain redeeming/redeemed rows. Compare only available detail rows
  // (matching Codex v0.144.6's picker); missing/capped detail and unknown enums
  // are never first-call authority.
  const availableDetailCount = details.credits.filter(
    (credit) => credit.status === "available",
  ).length;
  if (
    details.availableCount !== availableDetailCount ||
    details.credits.some((credit) => credit.resetType === "unknown" || credit.status === "unknown")
  ) {
    return null;
  }
  const credit = details.credits.find((candidate) => candidate.id === creditId);
  return credit && actionableCredit(credit) ? credit : null;
}

type CodexProviderCall = <T>(operation: () => Promise<T>) => Promise<T>;

const CODEX_OVERVIEW_ROUTE_TIMEOUT_MS = 12_000;

function createProviderCallLimiter(limit: number): CodexProviderCall {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Codex provider concurrency limit must be a positive integer");
  }
  let permits = limit;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (permits > 0) {
      permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else permits += 1;
  };
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

type CodexRedemptionAccess = {
  ownership: "current_human" | "unowned" | "different_human" | "managed_human_unavailable";
  canClaimUnownedViaReconnect: boolean;
};

/** Provider reads for one overview account (shared-core organizations). */
type CodexOverviewSources = {
  usage(connectionId: string): Promise<CodexUsagePayload>;
  details(connectionId: string): Promise<CodexRateLimitResetCreditsAccountResult>;
};

async function fetchCodexAccountOverview(
  deps: ApiRouteDeps,
  workspaceId: string,
  row: CodexAccountStatus,
  redemptionAccess: CodexRedemptionAccess,
  canRedeem: boolean,
  canResumeRedemption: boolean,
  redemptions: CodexResetRedemptionRecovery[],
  providerCall: CodexProviderCall,
  sources: CodexOverviewSources,
) {
  const [usageSettled, detailsSettled] = await Promise.allSettled([
    providerCall(() => sources.usage(row.id)),
    providerCall(() => sources.details(row.id)),
  ]);
  const liveUsage = usageSettled.status === "fulfilled" ? usageSettled.value : null;
  const cached = cachedUsage(row);
  const usageFromProvider = liveUsage != null && liveUsage.status !== "error";
  const usageValue = usageFromProvider ? liveUsage : cached;
  const usageSource = usageFromProvider ? "provider" : cached ? "cache" : "none";
  const liveSummary = liveUsage?.rateLimitResetCredits ?? null;
  const detailsResult = detailsSettled.status === "fulfilled" ? detailsSettled.value : null;
  const details = detailsResult?.ok ? detailsResult.details : null;
  const availableCount =
    details?.availableCount ?? liveSummary?.availableCount ?? row.resetCreditAvailableCount;
  const availableDetailCount =
    details?.credits.filter((credit) => credit.status === "available").length ?? 0;
  const availableDetailsComplete = !!details && details.availableCount === availableDetailCount;
  const availableDetailsCapped = !!details && availableDetailCount < details.availableCount;
  const availableDetailsImpossible = !!details && availableDetailCount > details.availableCount;
  const summaryAgrees =
    !details || liveSummary == null || liveSummary.availableCount === details.availableCount;
  const hasUnknown =
    details?.credits.some(
      (credit) => credit.resetType === "unknown" || credit.status === "unknown",
    ) ?? false;
  const detailsComplete = availableDetailsComplete && summaryAgrees && !hasUnknown;
  let detailState: "detailed" | "count_only" | "capped" | "unsupported" | "unknown" | "error";
  if (details) {
    detailState =
      !summaryAgrees || hasUnknown || availableDetailsImpossible
        ? "unknown"
        : availableDetailsCapped
          ? "capped"
          : "detailed";
  } else if (availableCount != null) {
    detailState = "count_only";
  } else if (detailsResult && !detailsResult.ok && detailsResult.reason === "invalid_response") {
    detailState = "unknown";
  } else if (
    detailsResult &&
    !detailsResult.ok &&
    detailsResult.reason === "http_error" &&
    detailsResult.status === 404
  ) {
    detailState = "unsupported";
  } else {
    detailState = "error";
  }
  const resetSource =
    details || liveSummary ? "provider" : availableCount != null ? "cache" : "none";
  const sorted = sortedCredits(details?.credits ?? []);
  const actionAuthority = canRedeem && detailsComplete && detailState === "detailed";
  return {
    accountId: row.id,
    usage: {
      source: usageSource,
      fetchedAt: usageValue?.fetchedAt ?? null,
      stale: usageSource === "provider" ? false : staleAt(row.usageCheckedAt),
      error:
        liveUsage?.status === "error"
          ? (liveUsage.reason ?? "unavailable")
          : usageSettled.status === "rejected"
            ? "unavailable"
            : null,
      value: usageValue,
    },
    resetCredits: {
      source: resetSource,
      fetchedAt:
        resetSource === "provider"
          ? (liveUsage?.fetchedAt ?? new Date().toISOString())
          : (row.resetCreditsCheckedAt?.toISOString() ?? null),
      stale: resetSource === "provider" ? false : staleAt(row.resetCreditsCheckedAt),
      error:
        detailsResult && !detailsResult.ok
          ? detailsResult.reason
          : detailsSettled.status === "rejected"
            ? "unavailable"
            : null,
      detailState,
      detailsComplete,
      availableCount: availableCount ?? null,
      credits: sorted.map((credit) => ({
        ...credit,
        actionable: actionAuthority && actionableCredit(credit),
      })),
    },
    canRedeem,
    redemptionAccess,
    canResumeRedemption,
    redemptions: redemptions.map((redemption) => ({
      attemptId: redemption.attemptId,
      creditId: redemption.creditId,
      status: redemption.status,
      outcome: redemption.outcome,
      providerStartedAt: redemption.providerStartedAt?.toISOString() ?? null,
      completedAt: redemption.completedAt?.toISOString() ?? null,
      createdAt: redemption.createdAt.toISOString(),
      updatedAt: redemption.updatedAt.toISOString(),
    })),
  };
}

type CodexConnectState = {
  workspaceId?: string;
  organizationId?: string;
  actorSubjectId?: string;
  deviceAuthId?: string;
  userCode?: string;
  iat?: number;
};

const CODEX_DEVICE_EXPIRY_SECONDS = 15 * 60; // the device code expires 15 min after start (spec §1.1)

export function registerCodexRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;

  app.get("/v1/workspaces/:workspaceId/codex/source", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexSource(c, deps, grant.accountId, workspaceId);
  });

  app.patch("/v1/workspaces/:workspaceId/codex/source", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const parsed = z
      .object({
        mode: z.enum(["automatic", "workspace", "organization", "disabled"]),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "a valid Codex source mode is required",
      });
    }
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexSetSource(c, deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      mode: parsed.data.mode,
    });
  });

  app.get("/v1/organizations/:organizationId/codex/accounts", async (c) => {
    const organizationId = c.req.param("organizationId");
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    await codexRouteDisposition(deps, organizationId);

    return await coreOrganizationCodexAccounts(c, deps, organizationId, human.subjectId);
  });

  app.get("/v1/organizations/:organizationId/codex/accounts/:accountId/usage", async (c) => {
    const organizationId = c.req.param("organizationId");
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const mode = await codexRouteDisposition(deps, organizationId);
    const credentialId = c.req.param("accountId");
    if (!z.string().uuid().safeParse(credentialId).success) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    const usage = await fetchOrganizationCodexUsageForAccount(
      db,
      settings,
      {
        organizationId,
        actorSubjectId: human.subjectId,
        credentialId,
        mode,
      },
      deps.codexFetch ?? fetch,
    );
    return c.json(codexUsageJson(usage));
  });

  app.post("/v1/organizations/:organizationId/codex/connect/start", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId, {
      providerConsent: true,
    });
    // The device-code start touches no account state: public compatibility
    // (a disabled cutover still fails closed).
    await codexRouteDisposition(deps, organizationId);
    let start: Awaited<ReturnType<typeof startDeviceCode>>;
    try {
      start = await startDeviceCode();
    } catch (error) {
      throw new HTTPException(502, {
        message:
          error instanceof CodexDeviceError ? error.message : "failed to start Codex device login",
      });
    }
    return c.json({
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      intervalSeconds: start.intervalSeconds,
      state: createSignedState(githubStateSecret, {
        organizationId,
        actorSubjectId: human.subjectId,
        deviceAuthId: start.deviceAuthId,
        userCode: start.userCode,
      }),
    });
  });

  app.post("/v1/organizations/:organizationId/codex/connect/poll", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId, {
      providerConsent: true,
    });
    await codexRouteDisposition(deps, organizationId);
    const { state } = (await c.req.json().catch(() => null)) as {
      state?: string;
    };
    const payload = (state
      ? readSignedState(state, githubStateSecret)
      : null) as unknown as CodexConnectState | null;
    if (
      !payload ||
      payload.organizationId !== organizationId ||
      payload.actorSubjectId !== human.subjectId ||
      !payload.deviceAuthId ||
      !payload.userCode
    ) {
      throw new HTTPException(400, {
        message: "codex connect state is invalid or expired",
      });
    }
    if (
      typeof payload.iat === "number" &&
      Date.now() / 1000 - payload.iat > CODEX_DEVICE_EXPIRY_SECONDS
    ) {
      return c.json({ status: "expired" });
    }
    let poll: Awaited<ReturnType<typeof pollDeviceCode>>;
    try {
      poll = await pollDeviceCode({
        deviceAuthId: payload.deviceAuthId,
        userCode: payload.userCode,
      });
    } catch (error) {
      throw new HTTPException(502, {
        message: error instanceof CodexDeviceError ? error.message : "codex device poll failed",
      });
    }
    if (poll.status === "pending") return c.json({ status: "pending" });
    if (poll.status === "expired") return c.json({ status: "expired" });
    let tokens: Awaited<ReturnType<typeof exchangeDeviceCode>>;
    try {
      tokens = await exchangeDeviceCode({
        authorizationCode: poll.authorizationCode,
        codeVerifier: poll.codeVerifier,
      });
    } catch (error) {
      throw new HTTPException(502, {
        message: error instanceof CodexDeviceError ? error.message : "codex token exchange failed",
      });
    }
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new HTTPException(500, {
        message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
      });
    }
    const id = parseIdToken(tokens.idToken);
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        id_token: tokens.idToken,
      }),
    );
    await codexRouteDisposition(deps, organizationId);

    return await coreCodexConnected(c, deps, {
      accountId: organizationId,
      workspaceId: null,
      subjectId: human.subjectId,
      credential: {
        credentialEncrypted,
        providerAccountId: id.chatgptAccountId,
        providerSubjectId: id.chatgptUserId,
        planType: id.planType,
        isFedramp: id.isFedramp,
        expiresAt: accessTokenExpiry(tokens.accessToken),
        lastRefreshAt: new Date(),
        accountEmail: id.email ?? null,
        label: id.email ?? id.chatgptAccountId ?? null,
        connectedBySubjectId: (await managedCookieHuman(c, deps))?.subjectId ?? null,
      },
    });
  });

  app.post("/v1/organizations/:organizationId/codex/accounts/:accountId/activate", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const credentialId = c.req.param("accountId");
    await codexRouteDisposition(deps, organizationId);

    return await coreCodexActivate(
      c,
      deps,
      { accountId: organizationId, workspaceId: null, subjectId: human.subjectId },
      credentialId,
    );
  });

  app.patch("/v1/organizations/:organizationId/codex/settings", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const parsed = z
      .object({ rotationEnabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "rotationEnabled is required" });
    }
    await codexRouteDisposition(deps, organizationId);

    return await coreCodexSetRotation(
      c,
      deps,
      { accountId: organizationId, workspaceId: null, subjectId: human.subjectId },
      parsed.data.rotationEnabled,
    );
  });

  app.patch("/v1/organizations/:organizationId/codex/accounts/:accountId/allocator", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const parsed = z
      .object({
        enabled: z.boolean(),
        expectedVersion: z.number().int().positive(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "enabled and expectedVersion are required" });
    }
    const admin = { accountId: organizationId, workspaceId: null, subjectId: human.subjectId };
    await codexRouteDisposition(deps, organizationId);

    return await coreCodexAllocator(c, deps, admin, c.req.param("accountId"), parsed.data);
  });

  app.patch(
    "/v1/organizations/:organizationId/codex/accounts/:accountId/extra-credits",
    async (c) => {
      const organizationId = c.req.param("organizationId");
      requireSameOriginBrowserMutation(c, deps);
      const human = await requireOrganizationCodexHuman(c, deps, organizationId);
      const parsed = z
        .object({
          enabled: z.boolean(),
          expectedVersion: z.number().int().positive(),
        })
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HTTPException(400, { message: "enabled and expectedVersion are required" });
      }
      const admin = { accountId: organizationId, workspaceId: null, subjectId: human.subjectId };
      await codexRouteDisposition(deps, organizationId);

      return await coreCodexExtraCredits(c, deps, admin, c.req.param("accountId"), parsed.data);
    },
  );

  app.patch("/v1/organizations/:organizationId/codex/accounts/:accountId", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const body = (await c.req.json().catch(() => null)) as {
      label?: unknown;
    } | null;
    await codexRouteDisposition(deps, organizationId);

    return await coreCodexRename(
      c,
      deps,
      { accountId: organizationId, workspaceId: null, subjectId: human.subjectId },
      c.req.param("accountId"),
      typeof body?.label === "string" ? body.label : null,
    );
  });

  app.delete("/v1/organizations/:organizationId/codex/accounts/:accountId", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireSameOriginBrowserMutation(c, deps);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    await codexRouteDisposition(deps, organizationId);

    return await coreCodexDisconnect(c, deps, {
      accountId: organizationId,
      workspaceId: null,
      subjectId: human.subjectId,
      connectionId: c.req.param("accountId"),
    });
  });

  // Begin device-code login: returns the user code + verification URL and a
  // signed state that carries the device_auth_id back to `poll`.
  app.post("/v1/workspaces/:workspaceId/codex/connect/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    if (await managedCookieHuman(c, deps)) requireSameOriginBrowserMutation(c, deps);
    // The device-code start touches no account state.
    await codexRouteDisposition(deps, grant.accountId);
    let start: Awaited<ReturnType<typeof startDeviceCode>>;
    try {
      start = await startDeviceCode();
    } catch (error) {
      throw new HTTPException(502, {
        message:
          error instanceof CodexDeviceError ? error.message : "failed to start Codex device login",
      });
    }
    const state = createSignedState(githubStateSecret, {
      workspaceId,
      actorSubjectId: grant.subjectId,
      deviceAuthId: start.deviceAuthId,
      userCode: start.userCode,
    });
    return c.json({
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      intervalSeconds: start.intervalSeconds,
      state,
    });
  });

  // Poll for authorization: pending | expired | connected (persists on success).
  app.post("/v1/workspaces/:workspaceId/codex/connect/poll", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const connectingHuman = await managedCookieHuman(c, deps);
    if (connectingHuman) requireSameOriginBrowserMutation(c, deps);
    await codexRouteDisposition(deps, grant.accountId);
    const { state } = (await c.req.json()) as { state?: string };
    const payload = (state
      ? readSignedState(state, githubStateSecret)
      : null) as unknown as CodexConnectState | null;
    if (
      !payload ||
      payload.workspaceId !== workspaceId ||
      payload.actorSubjectId !== grant.subjectId ||
      !payload.deviceAuthId ||
      !payload.userCode
    ) {
      throw new HTTPException(400, {
        message: "codex connect state is invalid or expired",
      });
    }
    // The device code itself expires 15 minutes after start; surface that to the
    // client (the 1-hour signed-state TTL is longer than the device window).
    if (
      typeof payload.iat === "number" &&
      Date.now() / 1000 - payload.iat > CODEX_DEVICE_EXPIRY_SECONDS
    ) {
      return c.json({ status: "expired" });
    }

    let poll: Awaited<ReturnType<typeof pollDeviceCode>>;
    try {
      poll = await pollDeviceCode({
        deviceAuthId: payload.deviceAuthId,
        userCode: payload.userCode,
      });
    } catch (error) {
      throw new HTTPException(502, {
        message: error instanceof CodexDeviceError ? error.message : "codex device poll failed",
      });
    }
    if (poll.status === "pending") {
      return c.json({ status: "pending" });
    }
    if (poll.status === "expired") {
      return c.json({ status: "expired" });
    }

    let tokens: Awaited<ReturnType<typeof exchangeDeviceCode>>;
    try {
      tokens = await exchangeDeviceCode({
        authorizationCode: poll.authorizationCode,
        codeVerifier: poll.codeVerifier,
      });
    } catch (error) {
      throw new HTTPException(502, {
        message: error instanceof CodexDeviceError ? error.message : "codex token exchange failed",
      });
    }
    const id = parseIdToken(tokens.idToken);
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new HTTPException(500, {
        message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
      });
    }
    await codexRouteDisposition(deps, grant.accountId);

    // The core writer decides authority from the grant's subject: an
    // organization administrator (new or reconnected shared account), a
    // workspace administrator (reconnect of an account this workspace
    // manages), or the person in their own Personal workspace.
    return await coreCodexConnected(c, deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      credential: {
        credentialEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            id_token: tokens.idToken,
          }),
        ),
        providerAccountId: id.chatgptAccountId,
        providerSubjectId: id.chatgptUserId,
        planType: id.planType,
        isFedramp: id.isFedramp,
        expiresAt: accessTokenExpiry(tokens.accessToken),
        lastRefreshAt: new Date(),
        accountEmail: id.email ?? null,
        label: id.email ?? id.chatgptAccountId ?? null,
        connectedBySubjectId: connectingHuman?.subjectId ?? null,
      },
    });
  });

  // Connection health: the cheapest real call is GET /codex/models (a 200 proves
  // the token is accepted). Never runs a generation. Never returns the token.
  app.get("/v1/workspaces/:workspaceId/codex/status", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexStatus(
      c,
      deps,
      grant.accountId,
      workspaceId,
      (await resolveCatalogSettings(db, settings)).settings,
      grant.subjectId,
    );
  });

  // List every connected Codex account (metadata only, never decrypts) + the
  // workspace active pointer + rotation settings. Read access.
  app.get("/v1/workspaces/:workspaceId/codex/accounts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexAccounts(c, deps, grant, workspaceId);
  });

  app.post("/v1/workspaces/:workspaceId/codex/apps", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    // Authenticate the designating human before any organization state is
    // read, so an unauthenticated caller learns nothing about the cutover row.
    // The core gate fails closed without consulting the historical source.
    const { human, accountId } = await requireCodexAppsHuman(c, deps, workspaceId);
    await codexRouteDisposition(deps, accountId);

    return await coreCodexDesignateApps(c, deps, workspaceId, { human, accountId });
  });

  app.delete("/v1/workspaces/:workspaceId/codex/apps", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    // The Apps designation is its own setting, not part of inference-account
    // routing: a workspace that switched routing to organization accounts (or
    // disabled subscriptions) must still be able to turn Apps off. Clearing
    // only removes authority; the owner/permission checks below still apply.
    const { human, accountId } = await requireCodexAppsHuman(c, deps, workspaceId);
    await codexRouteDisposition(deps, accountId);

    return await coreCodexClearApps(c, deps, workspaceId, { human, accountId });
  });

  // Manually switch the workspace ACTIVE account (the one unpinned sessions use).
  // Pure pointer flip; in-flight turns pick it up on their next token fetch.
  app.post("/v1/workspaces/:workspaceId/codex/accounts/:accountId/activate", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexActivate(
      c,
      deps,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      c.req.param("accountId"),
    );
  });

  // Update rotation settings. Connection-management access. Sharded-rotation policy: the strategy picker is GONE —
  // rotation-enabled always behaves as sticky-sharded (worker-side
  // effectiveRotationStrategy normalization). `rotationStrategy` in the body is
  // ACCEPTED-BUT-IGNORED so no existing SDK/UI caller breaks (deprecation), and
  // the stored column is historical residue, not authority to restart old binaries.
  app.patch("/v1/workspaces/:workspaceId/codex/settings", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    const body = (await c.req.json().catch(() => ({}))) as {
      rotationEnabled?: unknown;
      rotationStrategy?: unknown;
    };
    const patch: { rotationEnabled?: boolean } = {};
    if (typeof body.rotationEnabled === "boolean") {
      patch.rotationEnabled = body.rotationEnabled;
    }
    if (patch.rotationEnabled === undefined && body.rotationStrategy === undefined) {
      throw new HTTPException(400, { message: "no settings to update" });
    }
    if (patch.rotationEnabled === undefined) {
      // Strategy-only writes are a deprecated no-op (no db touch): report the
      // (only) truth. Callers that also flip rotationEnabled fall through.
      return c.json({
        rotationStrategy: "sharded",
        rotationStrategyDeprecated: true,
      });
    }

    return await coreCodexSetRotation(
      c,
      deps,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      patch.rotationEnabled,
    );
  });

  // Rename an account (label only in P1).
  app.patch("/v1/workspaces/:workspaceId/codex/accounts/:accountId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    const accountId = c.req.param("accountId");
    const body = (await c.req.json()) as { label?: string | null };
    const label = typeof body.label === "string" ? body.label : null;

    return await coreCodexRename(
      c,
      deps,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      accountId,
      label,
    );
  });

  // Codex quota: independent OCC for new-turn allocator eligibility. Same-state is
  // idempotent even with a stale expected version; conflicting stale state is
  // an explicit 409 carrying the current version.
  app.patch("/v1/workspaces/:workspaceId/codex/accounts/:accountId/allocator", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    const parsed = z
      .object({
        enabled: z.boolean(),
        expectedVersion: z.number().int().positive(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "enabled and expectedVersion are required",
      });
    }

    return await coreCodexAllocator(
      c,
      deps,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      c.req.param("accountId"),
      parsed.data,
    );
  });

  app.patch("/v1/workspaces/:workspaceId/codex/accounts/:accountId/extra-credits", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    const parsed = z
      .object({
        enabled: z.boolean(),
        expectedVersion: z.number().int().positive(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "enabled and expectedVersion are required",
      });
    }

    return await coreCodexExtraCredits(
      c,
      deps,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      c.req.param("accountId"),
      parsed.data,
    );
  });

  // Disconnect ONE account by id. The accessor re-picks active when the removed
  // row was active (FK ON DELETE SET NULL + re-pick in the same RLS txn).
  app.delete("/v1/workspaces/:workspaceId/codex/accounts/:accountId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexDisconnect(c, deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      connectionId: c.req.param("accountId"),
    });
  });

  // Legacy "disconnect all" (old workspace-wide behavior), deprecated in favor of
  // the by-id route above.
  app.delete("/v1/workspaces/:workspaceId/codex", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexDisconnectAll(c, deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
    });
  });

  // Back-compat: remaining usage / limits for the ACTIVE account only. Repointed
  // through the refreshing wrapper (P2) so it no longer 401s on an idle account's
  // stale access token. Deprecated in favor of the /accounts + /usage/refresh pair.
  app.get("/v1/workspaces/:workspaceId/codex/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexUsage(c, deps, grant, workspaceId, null);
  });

  // Single-account LIVE usage read (per-row manual refresh): refresh THIS account's
  // bearer, hit /wham/usage, write the cache columns, return the normalized payload.
  app.get("/v1/workspaces/:workspaceId/codex/accounts/:accountId/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexUsage(c, deps, grant, workspaceId, c.req.param("accountId"));
  });

  // Batched LIVE refresh across every connected account, keyed by credential id.
  // A small concurrency cap + Promise.allSettled so one account's 401/error/timeout
  // can't sink the batch; each entry is independently statused. Writes the cache
  // columns as a side effect. This is what the "Refresh" button and an on-mount
  // staleness check call — NEVER a browser interval.
  app.post("/v1/workspaces/:workspaceId/codex/usage/refresh", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexUsageRefresh(c, deps, grant, workspaceId);
  });

  // Trustworthy live overview: usage and reset details settle independently per
  // account and one failed subscription cannot sink the batch. Provider calls
  // are capped at four accounts at a time and never run on a browser interval.
  app.get("/v1/workspaces/:workspaceId/codex/overview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await codexRouteDisposition(deps, grant.accountId);

    return await coreCodexOverview(c, deps, grant, workspaceId);
  });

  // Mint a five-minute HMAC confirmation bound to the actual Better Auth
  // session, human, workspace, credential, credit, and stable logical attempt.
  // This route never calls the consume endpoint and creates no attempt row when
  // the default-focused Cancel button wins.
  app.post(
    "/v1/workspaces/:workspaceId/codex/accounts/:accountId/reset-credits/prepare",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const credentialId = c.req.param("accountId");
      const { human, accountId } = await requireRedemptionHuman(c, deps, workspaceId);
      await codexRouteDisposition(deps, accountId);

      return await coreCodexResetPrepare(c, deps, {
        human,
        accountId,
        workspaceId,
        credentialId,
      });
    },
  );

  // The only Opengeni reset-credit mutation route: the person in the web app,
  // or an agent they signed in acting as them. Nothing redeems automatically
  // (no worker, scheduled, allocator or rotation path).
  app.post(
    "/v1/workspaces/:workspaceId/codex/accounts/:accountId/reset-credits/redeem",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const credentialId = c.req.param("accountId");
      const { human, accountId } = await requireRedemptionHuman(c, deps, workspaceId);
      await codexRouteDisposition(deps, accountId);

      return await coreCodexResetRedeem(c, deps, { human, accountId, workspaceId, credentialId });
    },
  );
}

// ---------------------------------------------------------------------------
// Reset credits and the overview on the shared subscription core (M3 PR 2c).
// Same routes, payloads, HMAC confirmation, single-use ledger fences and
// ambiguous-outcome recovery as the historical handlers; authority is the
// design 6.3 rule enforced by `subscription_codex_reset_authority` (an
// organization administrator or an administrator of the managing workspace,
// from a same-origin managed browser only), and the credential is read and
// refreshed through the core connection seam.

type CoreRedemptionInput = {
  human: ManagedCookieHuman;
  accountId: string;
  workspaceId: string;
  credentialId: string;
};

/** Ledger and authority reads run as the browser human, never the ambient actor. */
function asRedemptionHuman<T>(human: ManagedCookieHuman, fn: () => Promise<T>): Promise<T> {
  return withSessionRlsActorContext({ subjectId: human.subjectId }, fn);
}

/**
 * Canonical core connection for a route id (canonical or legacy alias) in the
 * workspace's pool. An organization account is redeemable only by an
 * organization administrator (M3 PR 3b); everyone else gets the legacy 409.
 */
async function coreRedemptionTarget(deps: ApiRouteDeps, input: CoreRedemptionInput) {
  const canonical = z.uuid().safeParse(input.credentialId).success
    ? await resolveSubscriptionCoreCodexConnectionId(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        connectionId: input.credentialId,
      })
    : null;
  const { accounts } = await getSubscriptionCoreCodexWorkspaceProjection(deps.db, input);
  const account = canonical ? accounts.find((candidate) => candidate.id === canonical) : undefined;
  if (!canonical || !account) throw new HTTPException(404, { message: "codex account not found" });
  return { credentialId: canonical, account };
}

function organizationManagedRedemption(): never {
  throw new HTTPException(409, {
    message: "organization Codex subscriptions are managed in Organization settings",
  });
}

/** An agent acting as a person may not redeem on the core (design 6.3). */
function requireBrowserRedemption(c: Context): void {
  if (isAgentActingAsPerson(c)) {
    throw new HTTPException(403, {
      message: "reset redemption requires a managed browser session",
    });
  }
}

function coreCodexConnectionScope(
  input: { accountId: string; workspaceId: string },
  subjectId: string,
) {
  return {
    kind: "workspace" as const,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId,
  };
}

async function coreCodexResetPrepare(c: Context, deps: ApiRouteDeps, input: CoreRedemptionInput) {
  requireBrowserRedemption(c);
  c.header("cache-control", "no-store");
  const parsed = redemptionPrepareBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(400, { message: "attemptId and creditId are required" });
  }
  const { human, accountId, workspaceId } = input;
  const { credentialId, account } = await coreRedemptionTarget(deps, input);
  return await asRedemptionHuman(human, async () => {
    const authority = await readSubscriptionCoreCodexResetAuthority(deps.db, {
      accountId,
      workspaceId,
      credentialId,
      subjectId: human.subjectId,
    });
    if (account.source === "organization" && !authority?.owned) organizationManagedRedemption();
    if (!authority) throw new HTTPException(404, { message: "codex account not found" });
    let existing = await getCodexResetRedemptionAttempt(
      deps.db,
      workspaceId,
      parsed.data.attemptId,
    );
    if (!existing && authority.owned) {
      // The same person's attempt filed in another workspace (an
      // organization account redeemed from several workspaces, or a ledger
      // row the cutover kept in its legacy workspace) is moved here so it is
      // recovered on its one upstream key; another workspace's hold on this
      // credit refuses a second logical redemption.
      const fence = await fenceSubscriptionCoreCodexResetCredit(deps.db, {
        accountId,
        workspaceId,
        credentialId,
        subjectId: human.subjectId,
        creditId: parsed.data.creditId,
        attemptId: parsed.data.attemptId,
      });
      if (fence === "held_elsewhere") {
        throw new HTTPException(409, {
          message: "this reset credit is already being redeemed from another workspace",
        });
      }
      if (fence === "refiled") {
        existing = await getCodexResetRedemptionAttempt(
          deps.db,
          workspaceId,
          parsed.data.attemptId,
        );
      }
    }
    if (!authority.owned) {
      throw new HTTPException(403, {
        message:
          "only an organization administrator or an administrator of the workspace that manages this subscription may redeem its reset credits",
      });
    }
    if (
      existing &&
      (existing.credentialId !== credentialId ||
        existing.creditId !== parsed.data.creditId ||
        existing.subjectId !== human.subjectId)
    ) {
      throw new HTTPException(409, { message: "logical redemption attempt identity mismatch" });
    }
    if (existing) {
      const adoption = await adoptCodexResetRedemptionAttempt(
        deps.db,
        {
          accountId,
          workspaceId,
          attemptId: existing.id,
          credentialId,
          creditId: existing.creditId,
          subjectId: human.subjectId,
          browserSessionHash: human.browserSessionHash,
        },
        subscriptionCoreCodexResetAuthority,
      );
      if (adoption.kind === "in_progress") {
        throw new HTTPException(409, {
          message: "this redemption is still in progress in another browser request",
        });
      }
      if (adoption.kind === "not_found") {
        throw new HTTPException(409, { message: "redemption recovery state changed" });
      }
      if (adoption.kind === "forbidden") {
        throw new HTTPException(403, { message: "redemption owner is unavailable" });
      }
      if (adoption.kind === "conflict") {
        throw new HTTPException(409, { message: "logical redemption attempt identity mismatch" });
      }
      existing = adoption.attempt;
    }
    if (authority.status !== "active" && existing?.status !== "completed") {
      throw new HTTPException(403, { message: "redemption credential is unavailable" });
    }
    const secret = deps.settings.betterAuthSecret;
    if (!secret) {
      throw new HTTPException(503, { message: "managed browser confirmation is unavailable" });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + CODEX_REDEMPTION_CONFIRMATION_SECONDS;
    const confirmationToken = await signCodexRedemptionConfirmation(secret, {
      version: 1,
      attemptId: parsed.data.attemptId,
      workspaceId,
      credentialId,
      creditId: parsed.data.creditId,
      subjectId: human.subjectId,
      browserSessionHash: human.browserSessionHash,
      expiresAt,
    });
    return c.json({
      attemptId: parsed.data.attemptId,
      confirmationToken,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      resumable: existing?.status === "provider_started" || existing?.status === "completed",
      recoveryStatus:
        existing?.status === "provider_started" || existing?.status === "completed"
          ? existing.status
          : null,
    });
  });
}

async function coreCodexResetRedeem(c: Context, deps: ApiRouteDeps, input: CoreRedemptionInput) {
  requireBrowserRedemption(c);
  c.header("cache-control", "no-store");
  const parsed = redemptionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(400, { message: "explicit redemption confirmation is required" });
  }
  const secret = deps.settings.betterAuthSecret;
  if (!secret) {
    throw new HTTPException(503, { message: "managed browser confirmation is unavailable" });
  }
  const { human, accountId, workspaceId } = input;
  const { credentialId, account } = await coreRedemptionTarget(deps, input);
  const claims = await verifyCodexRedemptionConfirmation(secret, parsed.data.confirmationToken);
  if (
    !claims ||
    claims.attemptId !== parsed.data.attemptId ||
    claims.workspaceId !== workspaceId ||
    claims.credentialId !== credentialId ||
    claims.creditId !== parsed.data.creditId ||
    claims.subjectId !== human.subjectId ||
    claims.browserSessionHash !== human.browserSessionHash
  ) {
    throw new HTTPException(403, { message: "redemption confirmation is invalid or expired" });
  }
  const db = deps.db;
  return await asRedemptionHuman(human, async () => {
    const claimHolderId = crypto.randomUUID();
    const claimed = await claimCodexResetRedemption(
      db,
      {
        id: parsed.data.attemptId,
        accountId,
        workspaceId,
        credentialId,
        subjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
        creditId: parsed.data.creditId,
        confirmationExpiresAt: new Date(claims.expiresAt * 1000),
        claimHolderId,
      },
      subscriptionCoreCodexResetAuthority,
      subscriptionCoreCodexResetCreditFence,
    );
    if (claimed.kind === "not_found") {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    if (claimed.kind === "forbidden") {
      if (account.source === "organization") organizationManagedRedemption();
      throw new HTTPException(403, { message: "redemption owner or credential is unavailable" });
    }
    if (claimed.kind === "conflict") {
      throw new HTTPException(409, { message: "logical redemption attempt identity mismatch" });
    }
    if (claimed.kind === "in_progress") {
      return c.json({ status: "in_progress", attemptId: parsed.data.attemptId }, 409);
    }
    const finishResponse = (outcome: string) =>
      c.json({ status: "completed", attemptId: parsed.data.attemptId, outcome, overview: null });
    if (claimed.kind === "completed") return finishResponse(claimed.attempt.outcome!);

    const attempt = claimed.attempt;
    const fetchImpl = (deps.codexFetch ?? fetch) as CodexFetch;
    const ledger = { accountId, workspaceId, attemptId: attempt.id, claimHolderId };
    let token: Awaited<
      ReturnType<ReturnType<typeof buildSubscriptionCoreCodexConnectionTokenResolver>["getToken"]>
    >;
    try {
      token = await buildSubscriptionCoreCodexConnectionTokenResolver(
        db,
        deps.settings,
        coreCodexConnectionScope(input, human.subjectId),
        credentialId,
        null,
      ).getToken();
    } catch {
      if (attempt.status === "processing") {
        await abandonCodexResetRedemptionBeforeProvider(db, ledger);
        return c.json(
          { status: "preflight_unavailable", attemptId: attempt.id, retryable: true },
          503,
        );
      }
      await releaseCodexResetRedemptionClaim(db, {
        ...ledger,
        failureKind: "provider_auth_unavailable",
      });
      return c.json(
        { status: "provider_unavailable", attemptId: attempt.id, retryable: true },
        503,
      );
    }
    const auth = {
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      isFedramp: token.isFedramp,
      clientVersion: CODEX_CLIENT_VERSION,
    };
    if (attempt.status === "processing") {
      const details = await fetchCodexRateLimitResetCredits(auth, fetchImpl);
      if (!details.ok) {
        await abandonCodexResetRedemptionBeforeProvider(db, ledger);
        return c.json(
          { status: "preflight_unavailable", attemptId: attempt.id, retryable: true },
          503,
        );
      }
      if (!freshActionableCredit(details.details, attempt.creditId)) {
        await abandonCodexResetRedemptionBeforeProvider(db, ledger);
        return c.json({ status: "not_actionable", attemptId: attempt.id, retryable: false }, 409);
      }
    }
    const fenced = await fenceCodexResetRedemptionSend(
      db,
      {
        ...ledger,
        credentialId,
        subjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
      },
      subscriptionCoreCodexResetAuthority,
    );
    if (fenced.kind !== "ready") {
      if (fenced.reason === "confirmation_expired") {
        return c.json(
          { status: "confirmation_expired", attemptId: attempt.id, retryable: true },
          403,
        );
      }
      if (fenced.reason === "credential_unavailable") {
        return c.json(
          { status: "provider_unavailable", attemptId: attempt.id, retryable: true },
          503,
        );
      }
      return c.json({ status: "in_progress", attemptId: attempt.id }, 409);
    }
    const sendAttempt = fenced.attempt;
    // The one upstream idempotency key of this logical attempt: an ambiguous
    // send is recovered with the same key, never reissued with a new one.
    const consumed = await consumeCodexRateLimitResetCredit(
      auth,
      { idempotencyKey: sendAttempt.upstreamIdempotencyKey, creditId: sendAttempt.creditId },
      fetchImpl,
    );
    if (!consumed.ok) {
      await releaseCodexResetRedemptionClaim(db, {
        ...ledger,
        failureKind: `provider_${consumed.reason}`,
      });
      return c.json({ status: "ambiguous", attemptId: attempt.id, retryable: true }, 503);
    }
    const completion = await completeSubscriptionCoreCodexResetRedemption(db, {
      ...ledger,
      outcome: consumed.result.outcome,
    });
    if (!completion.attempt) {
      return c.json({ status: "in_progress", attemptId: attempt.id }, 409);
    }
    void deliverSubscriptionCoreCodexWake(db, completion.wake).catch(() => undefined);
    return finishResponse(completion.attempt.outcome!);
  });
}

/**
 * The overview on the core: per-account usage and reset details settle
 * independently through the connection seam, with at most four provider
 * calls at a time and the legacy route deadline. Redemption flags follow the
 * 6.3 authority for a same-origin browser human only.
 */
async function coreCodexOverview(
  c: Context,
  deps: ApiRouteDeps,
  grant: Awaited<ReturnType<typeof requireAccessGrant>>,
  workspaceId: string,
) {
  const human = await managedHumanOrAgent(c, deps);
  const browserHuman =
    human &&
    human.subjectId === grant.subjectId &&
    !isAgentActingAsPerson(c) &&
    hasPermission(grant.permissions, "connections:write")
      ? human
      : null;
  const scope = coreCodexConnectionScope(
    { accountId: grant.accountId, workspaceId },
    grant.subjectId,
  );
  const { accounts } = await getSubscriptionCoreCodexWorkspaceProjection(deps.db, {
    accountId: grant.accountId,
    workspaceId,
  });
  const recoveries = browserHuman
    ? await asRedemptionHuman(browserHuman, () =>
        listSubscriptionCoreCodexResetRedemptionRecoveries(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: browserHuman.subjectId,
        }),
      )
    : [];
  const fetchImpl = (deps.codexFetch ?? fetch) as CodexFetch;
  const sources: CodexOverviewSources = {
    usage: async (connectionId) => {
      const { usage, recovered } = await fetchSubscriptionCoreCodexUsage(
        deps.db,
        deps.settings,
        scope,
        connectionId,
        fetchImpl,
      );
      if (recovered) {
        void deliverSubscriptionCoreCodexWake(deps.db, {
          accountId: grant.accountId,
          reason: "usage_recovered",
        }).catch(() => undefined);
      }
      return usage;
    },
    details: async (connectionId) => {
      let token;
      try {
        token = await buildSubscriptionCoreCodexConnectionTokenResolver(
          deps.db,
          deps.settings,
          scope,
          connectionId,
          null,
        ).getToken();
      } catch (error) {
        // Not readable in this workspace context: reset details are not
        // available here (reported as unsupported, not as a failure).
        if (error instanceof SubscriptionCoreCodexOperationUnavailableError) {
          return { ok: false as const, status: 404, reason: "http_error" as const };
        }
        return {
          ok: false as const,
          status: 0,
          reason:
            error instanceof CodexReloginRequired
              ? ("needs_relogin" as const)
              : ("network_error" as const),
        };
      }
      return await fetchCodexRateLimitResetCredits(
        {
          accessToken: token.accessToken,
          chatgptAccountId: token.chatgptAccountId,
          isFedramp: token.isFedramp,
          clientVersion: CODEX_CLIENT_VERSION,
        },
        fetchImpl,
      );
    },
  };
  const accessFor = async (account: CodexAccountStatus) => {
    // Organization accounts are redeemable by an organization administrator
    // (M3 PR 3b); the SQL authority decides for both sources.
    const authority = browserHuman
      ? await asRedemptionHuman(browserHuman, () =>
          readSubscriptionCoreCodexResetAuthority(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            credentialId: account.id,
            subjectId: browserHuman.subjectId,
          }),
        ).catch(() => null)
      : null;
    const canResumeRedemption = authority?.owned === true;
    const redemptionAccess: CodexRedemptionAccess =
      !browserHuman || (account.source === "organization" && !canResumeRedemption)
        ? { ownership: "managed_human_unavailable", canClaimUnownedViaReconnect: false }
        : {
            ownership: canResumeRedemption ? "current_human" : "different_human",
            canClaimUnownedViaReconnect: false,
          };
    return {
      redemptionAccess,
      canRedeem: canResumeRedemption && account.status === "active",
      canResumeRedemption,
      redemptions: canResumeRedemption
        ? recoveries.filter((recovery) => recovery.credentialId === account.id)
        : [],
    };
  };
  const overview: Record<string, Awaited<ReturnType<typeof fetchCodexAccountOverview>>> = {};
  const queue = [...accounts];
  const providerCall = createProviderCallLimiter(4);
  let routeTimedOut = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (routeTimedOut) return;
      const account = queue.shift();
      if (!account) return;
      const access = await accessFor(account);
      overview[account.id] = await fetchCodexAccountOverview(
        deps,
        workspaceId,
        account,
        access.redemptionAccess,
        access.canRedeem,
        access.canResumeRedemption,
        access.redemptions,
        providerCall,
        sources,
      );
    }
  };
  const workers = Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, accounts.length)) }, () => worker()),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    workers,
    new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        routeTimedOut = true;
        queue.length = 0;
        resolve();
      }, CODEX_OVERVIEW_ROUTE_TIMEOUT_MS);
    }),
  ]);
  if (deadline) clearTimeout(deadline);
  if (routeTimedOut) {
    // Unscheduled accounts come from the core's persisted quota only.
    const unavailableProviderCall: CodexProviderCall = async () => {
      throw new Error("Codex overview route deadline reached");
    };
    await Promise.all(
      accounts
        .filter((account) => overview[account.id] == null)
        .map(async (account) => {
          const access = await accessFor(account);
          const fallback = await fetchCodexAccountOverview(
            deps,
            workspaceId,
            account,
            access.redemptionAccess,
            false,
            access.canResumeRedemption,
            access.redemptions,
            unavailableProviderCall,
            sources,
          );
          overview[account.id] ??= fallback;
        }),
    );
    void workers.catch(() => undefined);
  }
  return c.json({ accounts: overview });
}
