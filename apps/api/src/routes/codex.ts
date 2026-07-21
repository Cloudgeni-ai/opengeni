// Codex (ChatGPT) subscription connect / status / usage routes.
//
// Connect uses the device-code flow split into two stateless calls: `start`
// returns a user code + verification URL and an HMAC-signed state carrying the
// device_auth_id; the client opens the URL, authorizes, then drives `poll` on the
// returned interval. No browser redirect and no 15-minute server block, so nothing
// is added to isAuthExempt. Secrets never leave the server: status/usage read the
// decrypted token only to call the codex backend; the token is never returned.

import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  accessTokenExpiry,
  buildCodexUsageWindowFromCache,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_FIVE_HOUR_WINDOW_SECONDS,
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_ID,
  CODEX_WEEKLY_WINDOW_SECONDS,
  CodexDeviceError,
  consumeCodexRateLimitResetCredit,
  exchangeDeviceCode,
  fetchCodexModels,
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
  buildCodexTokenResolver,
  claimCodexResetRedemption,
  completeCodexResetRedemption,
  disconnectAllCodexAccounts,
  disconnectCodexAccount,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  fetchCodexUsageForAccount,
  fetchCodexRateLimitResetCreditsForAccount,
  fenceCodexResetRedemptionSend,
  getCodexResetRedemptionAttempt,
  getCodexCredentialStatus,
  getCodexRotationSettings,
  listPendingCodexCapacityWakeTargets,
  listCodexAccountStatuses,
  listCodexResetRedemptionRecoveries,
  releaseCodexResetRedemptionClaim,
  updateCodexAllocatorEligibility,
  loadCodexCredentialForRun,
  renameCodexAccount,
  setActiveCodexCredential,
  setInitialActiveCodexCredential,
  updateCodexRotationSettings,
  upsertCodexSubscriptionCredential,
  withCodexCapacityMutation,
  type CodexAccountStatus,
  type CodexCapacityWakeTarget,
} from "@opengeni/db";

// The picker surfaces codex models under their own "no credits" provider group so
// they read distinctly from the platform provider's same-named model.
const CODEX_PROVIDER_LABEL = "Codex subscription · no credits";

// The wire shape for one Codex account (metadata only; never the secret column).
// P2: fiveHour/weekly ride along, built from the CACHED usage columns (zero
// provider calls, zero decrypts) so the bars render instantly off this read.
function codexAccountJson(row: CodexAccountStatus) {
  return {
    id: row.id,
    chatgptAccountId: row.chatgptAccountId,
    label: row.label,
    email: row.accountEmail,
    plan: row.planType,
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
    allocatorEnabled: row.allocatorEnabled,
    allocatorVersion: row.allocatorVersion,
    allocatorUpdatedAt: row.allocatorUpdatedAt,
    resetCreditAvailableCount: row.resetCreditAvailableCount,
    resetCreditsCheckedAt: row.resetCreditsCheckedAt,
    // P3 rotation cooldown: when set and in the future, this account is cooling-down.
    exhaustedUntil: row.exhaustedUntil,
  };
}

// The /codex/usage{,/refresh,/:id} wire wrapper: the rich normalized payload
// carries its own `status`, surfaced at the top level for back-compat with the
// existing CodexUsage = { status; usage } shape.
function codexUsageJson(payload: CodexUsagePayload): {
  status: CodexUsagePayload["status"];
  usage: CodexUsagePayload;
} {
  return { status: payload.status, usage: payload };
}

export function codexModelsForPicker(liveSlugs: readonly string[]): Array<{
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  api: "responses";
}> {
  const available = new Set(liveSlugs);
  const missing = CODEX_FALLBACK_MODEL_SLUGS.filter((slug) => !available.has(slug));
  if (missing.length > 0) {
    throw new Error(`Codex catalog is missing required models: ${missing.join(", ")}`);
  }
  return CODEX_FALLBACK_MODEL_SLUGS.map((slug) => ({
    id: `${CODEX_MODEL_ID_PREFIX}${slug}`,
    label: slug.replace(/^gpt-/, "GPT-"),
    provider: CODEX_PROVIDER_ID,
    providerLabel: CODEX_PROVIDER_LABEL,
    api: "responses" as const,
  }));
}
import { createSignedState, readSignedState } from "@opengeni/github";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

async function managedCookieHuman(
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
  const session = await deps.managedAuth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session?.user?.id || !session.session?.id) return null;
  return {
    subjectId: `user:${session.user.id}`,
    browserSessionHash: await hashCodexBrowserSession(session.session.id),
  };
}

function requireSameOriginBrowserMutation(c: Context, deps: ApiRouteDeps): void {
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HTTPException(403, {
      message: "JSON browser request required",
    });
  }
  if (!deps.settings.publicBaseUrl) {
    throw new HTTPException(503, {
      message: "managed browser origin is not configured",
    });
  }
  const expectedOrigin = new URL(deps.settings.publicBaseUrl).origin;
  if (c.req.header("origin") !== expectedOrigin) {
    throw new HTTPException(403, {
      message: "same-origin browser request required",
    });
  }
  if (c.req.header("sec-fetch-site")?.toLowerCase() !== "same-origin") {
    throw new HTTPException(403, {
      message: "same-origin fetch metadata required",
    });
  }
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
  // Normal managed auth prefers a bearer over a cookie. This irreversible route
  // rejects the header before grant resolution so an API key/delegated/agent
  // token can never borrow a browser cookie that happens to ride along. Exact
  // JSON content type plus Origin and Fetch Metadata fail closed before auth.
  if (c.req.header("authorization")) {
    throw new HTTPException(403, {
      message: "authorization bearer is not allowed for redemption",
    });
  }
  requireSameOriginBrowserMutation(c, deps);
  const human = await managedCookieHuman(c, deps);
  if (!human) {
    throw new HTTPException(401, {
      message: "managed browser session required",
    });
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
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

async function fetchCodexAccountOverview(
  deps: ApiRouteDeps,
  workspaceId: string,
  row: CodexAccountStatus,
  canRedeem: boolean,
  canResumeRedemption: boolean,
  redemptions: Awaited<ReturnType<typeof listCodexResetRedemptionRecoveries>> = [],
  providerCall: CodexProviderCall = async (operation) => await operation(),
) {
  const fetchImpl = (deps.codexFetch ?? fetch) as CodexFetch;
  const [usageSettled, detailsSettled] = await Promise.allSettled([
    providerCall(
      async () =>
        await fetchCodexUsageForAccount(deps.db, deps.settings, workspaceId, row.id, fetchImpl),
    ),
    providerCall(
      async () =>
        await fetchCodexRateLimitResetCreditsForAccount(
          deps.db,
          deps.settings,
          workspaceId,
          row.id,
          fetchImpl,
        ),
    ),
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
  deviceAuthId?: string;
  userCode?: string;
  iat?: number;
};

async function signalCodexCapacityTargets(
  deps: ApiRouteDeps,
  targets: CodexCapacityWakeTarget[],
): Promise<void> {
  await Promise.allSettled(
    targets.map((target) =>
      deps.workflowClient.signalCodexCapacity
        ? deps.workflowClient.signalCodexCapacity({
            accountId: target.accountId,
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            workflowId: target.workflowId,
            wakeRevision: target.wakeRevision,
            workflowWakeRevision: target.workflowWakeRevision,
          })
        : deps.workflowClient.wakeSessionWorkflow({
            accountId: target.accountId,
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            workflowId: target.workflowId,
            wakeRevision: target.workflowWakeRevision,
          }),
    ),
  );
}

async function signalPendingCodexCapacityTargets(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<void> {
  const targets = await listPendingCodexCapacityWakeTargets(deps.db, workspaceId).catch(() => []);
  await signalCodexCapacityTargets(deps, targets);
}

const CODEX_DEVICE_EXPIRY_SECONDS = 15 * 60; // the device code expires 15 min after start (spec §1.1)

export function registerCodexRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;

  // Begin device-code login: returns the user code + verification URL and a
  // signed state that carries the device_auth_id back to `poll`.
  app.post("/v1/workspaces/:workspaceId/codex/connect/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const { state } = (await c.req.json()) as { state?: string };
    const payload = (state
      ? readSignedState(state, githubStateSecret)
      : null) as unknown as CodexConnectState | null;
    if (
      !payload ||
      payload.workspaceId !== workspaceId ||
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
    const connectingHuman = await managedCookieHuman(c, deps);
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new HTTPException(500, {
        message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
      });
    }
    await ensureCodexRotationSettings(db, grant.accountId, workspaceId);
    const mutation = await withCodexCapacityMutation(
      db,
      { workspaceId, reason: "codex_credential_connected" },
      async (tx) => {
        const upserted = await upsertCodexSubscriptionCredential(tx, {
          accountId: grant.accountId,
          workspaceId,
          credentialEncrypted: encryptEnvironmentValue(
            key,
            JSON.stringify({
              access_token: tokens.accessToken,
              refresh_token: tokens.refreshToken,
              id_token: tokens.idToken,
            }),
          ),
          chatgptAccountId: id.chatgptAccountId,
          scopes: null, // device grant scopes are discovered at runtime, not asserted here
          planType: id.planType,
          isFedramp: id.isFedramp,
          expiresAt: accessTokenExpiry(tokens.accessToken),
          lastRefreshAt: new Date(),
          accountEmail: id.email ?? null,
          label: id.email ?? id.chatgptAccountId ?? null,
          connectedBySubjectId:
            connectingHuman?.subjectId === grant.subjectId ? connectingHuman.subjectId : null,
        });
        return { result: upserted, changed: upserted.kind === "upserted" };
      },
    );
    const upserted = mutation.result;
    if (upserted.kind === "unresolved_redemption") {
      throw new HTTPException(409, {
        message:
          "this subscription has an unresolved reset redemption; recover it before changing ownership",
      });
    }
    // Ensure the per-workspace rotation-settings row exists, then auto-activate
    // the FIRST account only. Additional new accounts do NOT auto-activate — a
    // manual switch is required (no auto-rotation in P1). A re-connect of the
    // already-active account is a no-op for the pointer.
    // Keep both rotation bits false on first connect. The deployment flag makes
    // the compatible allocator available, but the workspace-local cutover bit
    // is enabled only by an explicit settings write after every worker replica
    // understands leasing.
    const rotation = await getCodexRotationSettings(db, workspaceId);
    let isActive = rotation?.activeCredentialId === upserted.id;
    if (!isActive && rotation?.activeCredentialId == null) {
      isActive = await setInitialActiveCodexCredential(db, workspaceId, upserted.id);
    }
    await signalCodexCapacityTargets(deps, mutation.wakeTargets);
    return c.json({ status: "connected", plan: id.planType, accountId: upserted.id, isActive });
  });

  // Connection health: the cheapest real call is GET /codex/models (a 200 proves
  // the token is accepted). Never runs a generation. Never returns the token.
  app.get("/v1/workspaces/:workspaceId/codex/status", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const status = await getCodexCredentialStatus(db, workspaceId);
    if (!status) {
      return c.json({ connected: false });
    }
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const activeRow = accounts.find((account) => account.id === status.credentialId) ?? null;
    const activeAccount = activeRow
      ? {
          id: activeRow.id,
          label:
            activeRow.label ??
            activeRow.accountEmail ??
            activeRow.planType ??
            activeRow.chatgptAccountId,
          chatgptAccountId: activeRow.chatgptAccountId,
        }
      : null;
    let valid = false;
    let models: ReturnType<typeof codexModelsForPicker> = [];
    let catalogError: string | null = null;
    try {
      const cred = status.credentialId
        ? await loadCodexCredentialForRun(db, settings, workspaceId, status.credentialId)
        : null;
      if (cred) {
        const live = await fetchCodexModels({
          accessToken: cred.tokens.accessToken,
          chatgptAccountId: cred.chatgptAccountId,
          isFedramp: cred.isFedramp,
          clientVersion: CODEX_CLIENT_VERSION,
        });
        if (live.ok) {
          models = codexModelsForPicker(live.slugs);
          valid = true;
        } else {
          catalogError = `Codex models request failed with status ${live.status}`;
        }
      }
    } catch (error) {
      valid = false;
      catalogError = error instanceof Error ? error.message : String(error);
    }
    return c.json({
      connected: status.connected,
      plan: status.planType,
      valid,
      expiresAt: status.expiresAt,
      lastError: catalogError ?? status.lastError,
      models, // ClientModel[] the picker surfaces under the "no credits" group
      activeAccount, // the account a session runs on when unpinned (label for the indicator)
      accountCount: accounts.length,
    });
  });

  // List every connected Codex account (metadata only, never decrypts) + the
  // workspace active pointer + rotation settings. Read access.
  app.get("/v1/workspaces/:workspaceId/codex/accounts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const [accounts, rotation] = await Promise.all([
      listCodexAccountStatuses(db, workspaceId),
      getCodexRotationSettings(db, workspaceId),
    ]);
    const activeAccountId = rotation?.activeCredentialId ?? null;
    return c.json({
      accounts: accounts.map(codexAccountJson),
      activeAccountId,
      settings: {
        rotationEnabled: rotation?.rotationEnabled ?? false,
        // sharded-rotation policy: rotation-enabled always behaves as sticky-sharded; report the
        // effective truth, never the stored legacy residue.
        rotationStrategy: "sharded",
        activeCredentialId: activeAccountId,
      },
    });
  });

  // Manually switch the workspace ACTIVE account (the one unpinned sessions use).
  // Pure pointer flip; in-flight turns pick it up on their next token fetch.
  app.post("/v1/workspaces/:workspaceId/codex/accounts/:accountId/activate", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const accountId = c.req.param("accountId");
    const mutation = await withCodexCapacityMutation(
      db,
      { workspaceId, reason: "codex_active_credential_changed" },
      async (tx) => {
        const activated = await setActiveCodexCredential(tx, workspaceId, accountId);
        return { result: activated, changed: activated };
      },
    );
    const activated = mutation.result;
    if (!activated) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    await signalCodexCapacityTargets(deps, mutation.wakeTargets);
    return c.json({ activated: true, accountId });
  });

  // Update rotation settings. admin access. sharded-rotation policy: the strategy picker is GONE —
  // rotation-enabled always behaves as sticky-sharded (worker-side
  // effectiveRotationStrategy normalization). `rotationStrategy` in the body is
  // ACCEPTED-BUT-IGNORED so no existing SDK/UI caller breaks (deprecation), and
  // the stored column is only legacy residue kept for old-binary rollback.
  app.patch("/v1/workspaces/:workspaceId/codex/settings", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
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
      return c.json({ rotationStrategy: "sharded", rotationStrategyDeprecated: true });
    }
    await ensureCodexRotationSettings(db, grant.accountId, workspaceId);
    const mutation = await withCodexCapacityMutation(
      db,
      { workspaceId, reason: "codex_rotation_settings_changed" },
      async (tx) => {
        const updated = await updateCodexRotationSettings(tx, workspaceId, patch);
        return { result: updated, changed: updated !== null };
      },
    );
    const updated = mutation.result;
    if (!updated) {
      throw new HTTPException(404, {
        message: "codex rotation settings not found",
      });
    }
    await signalCodexCapacityTargets(deps, mutation.wakeTargets);
    return c.json({
      rotationEnabled: updated.rotationEnabled,
      // sharded-rotation policy: sharded is the only behavior; the stored column is residue.
      rotationStrategy: "sharded",
      activeCredentialId: updated.activeCredentialId,
    });
  });

  // Rename an account (label only in P1).
  app.patch("/v1/workspaces/:workspaceId/codex/accounts/:accountId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const accountId = c.req.param("accountId");
    const body = (await c.req.json()) as { label?: string | null };
    const label = typeof body.label === "string" ? body.label : null;
    const renamed = await renameCodexAccount(db, workspaceId, accountId, label);
    if (!renamed) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const row = accounts.find((account) => account.id === accountId);
    if (!row) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    return c.json(codexAccountJson(row));
  });

  // Codex quota: independent OCC for new-turn allocator eligibility. Same-state is
  // idempotent even with a stale expected version; conflicting stale state is
  // an explicit 409 carrying the current version.
  app.patch("/v1/workspaces/:workspaceId/codex/accounts/:accountId/allocator", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
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
    const mutation = await updateCodexAllocatorEligibility(db, {
      accountId: grant.accountId,
      workspaceId,
      credentialId: c.req.param("accountId"),
      subjectId: grant.subjectId,
      enabled: parsed.data.enabled,
      expectedVersion: parsed.data.expectedVersion,
    });
    const result = mutation.result;
    if (result.kind === "not_found") {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    const response = {
      allocatorEnabled: result.allocatorEnabled,
      allocatorVersion: result.allocatorVersion,
      allocatorUpdatedAt: result.allocatorUpdatedAt,
      changed: result.kind === "updated",
    };
    await signalCodexCapacityTargets(deps, mutation.wakeTargets);
    return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
  });

  // Disconnect ONE account by id. The accessor re-picks active when the removed
  // row was active (FK ON DELETE SET NULL + re-pick in the same RLS txn).
  app.delete("/v1/workspaces/:workspaceId/codex/accounts/:accountId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const accountId = c.req.param("accountId");
    const mutation = await withCodexCapacityMutation(
      db,
      { workspaceId, reason: "codex_credential_disconnected" },
      async (tx) => {
        const result = await disconnectCodexAccount(tx, workspaceId, accountId);
        return { result, changed: result.removed };
      },
    );
    const result = mutation.result;
    if (result.blockedByUnresolvedRedemption) {
      throw new HTTPException(409, {
        message:
          "this subscription has an unresolved reset redemption; recover it before disconnecting",
      });
    }
    await signalCodexCapacityTargets(deps, mutation.wakeTargets);
    return c.json({ disconnected: result.removed, newActiveId: result.newActiveCredentialId });
  });

  // Legacy "disconnect all" (old workspace-wide behavior), deprecated in favor of
  // the by-id route above.
  app.delete("/v1/workspaces/:workspaceId/codex", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const mutation = await withCodexCapacityMutation(
      db,
      { workspaceId, reason: "codex_credentials_disconnected" },
      async (tx) => {
        const result = await disconnectAllCodexAccounts(tx, workspaceId);
        return { result, changed: result.removed > 0 };
      },
    );
    const result = mutation.result;
    if (result.blockedCredentialIds.length > 0) {
      throw new HTTPException(409, {
        message:
          "one or more subscriptions have unresolved reset redemptions; recover them before disconnecting",
      });
    }
    await signalCodexCapacityTargets(deps, mutation.wakeTargets);
    return c.json({ disconnected: result.removed > 0 });
  });

  // Back-compat: remaining usage / limits for the ACTIVE account only. Repointed
  // through the refreshing wrapper (P2) so it no longer 401s on an idle account's
  // stale access token. Deprecated in favor of the /accounts + /usage/refresh pair.
  app.get("/v1/workspaces/:workspaceId/codex/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const status = await getCodexCredentialStatus(db, workspaceId);
    if (!status?.credentialId) {
      throw new HTTPException(404, {
        message: "codex subscription is not connected",
      });
    }
    const payload = await fetchCodexUsageForAccount(db, settings, workspaceId, status.credentialId);
    await signalPendingCodexCapacityTargets(deps, workspaceId);
    return c.json(codexUsageJson(payload));
  });

  // Single-account LIVE usage read (per-row manual refresh): refresh THIS account's
  // bearer, hit /wham/usage, write the cache columns, return the normalized payload.
  app.get("/v1/workspaces/:workspaceId/codex/accounts/:accountId/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const accountId = c.req.param("accountId");
    // Constrain to a real account in this workspace (RLS already scopes, but a 404
    // for an unknown id is friendlier than an opaque needs_relogin payload).
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    if (!accounts.some((account) => account.id === accountId)) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    const payload = await fetchCodexUsageForAccount(db, settings, workspaceId, accountId);
    await signalPendingCodexCapacityTargets(deps, workspaceId);
    return c.json(codexUsageJson(payload));
  });

  // Batched LIVE refresh across every connected account, keyed by credential id.
  // A small concurrency cap + Promise.allSettled so one account's 401/error/timeout
  // can't sink the batch; each entry is independently statused. Writes the cache
  // columns as a side effect. This is what the "Refresh" button and an on-mount
  // staleness check call — NEVER a browser interval.
  app.post("/v1/workspaces/:workspaceId/codex/usage/refresh", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const usage: Record<string, { status: CodexUsagePayload["status"]; usage: CodexUsagePayload }> =
      {};
    const queue = [...accounts];
    const CONCURRENCY = 4;
    const worker = async (): Promise<void> => {
      for (;;) {
        const account = queue.shift();
        if (!account) return;
        const settled = await Promise.allSettled([
          fetchCodexUsageForAccount(db, settings, workspaceId, account.id),
        ]);
        const result = settled[0];
        usage[account.id] =
          result.status === "fulfilled"
            ? codexUsageJson(result.value)
            : {
                status: "error",
                usage: {
                  status: "error",
                  planType: null,
                  fiveHour: null,
                  weekly: null,
                  limitReached: false,
                  fetchedAt: new Date().toISOString(),
                  rateLimitResetCredits: null,
                },
              };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, accounts.length)) }, () => worker()),
    );
    await signalPendingCodexCapacityTargets(deps, workspaceId);
    return c.json({ usage });
  });

  // Trustworthy live overview: usage and reset details settle independently per
  // account and one failed subscription cannot sink the batch. Provider calls
  // are capped at four accounts at a time and never run on a browser interval.
  app.get("/v1/workspaces/:workspaceId/codex/overview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const human = await managedCookieHuman(c, deps);
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const ownerRecoveries =
      human &&
      human.subjectId === grant.subjectId &&
      hasPermission(grant.permissions, "workspace:admin")
        ? await listCodexResetRedemptionRecoveries(db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: human.subjectId,
          })
        : [];
    const overview: Record<string, Awaited<ReturnType<typeof fetchCodexAccountOverview>>> = {};
    const queue = [...accounts];
    // Usage + detailed inventory are two independent calls per account. Limit
    // the actual provider calls, not merely account workers, so aggregate
    // concurrency never exceeds four.
    const providerCall = createProviderCallLimiter(4);
    let routeTimedOut = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (routeTimedOut) return;
        const account = queue.shift();
        if (!account) return;
        const canResumeRedemption = Boolean(
          human &&
          human.subjectId === grant.subjectId &&
          human.subjectId === account.connectedBySubjectId &&
          hasPermission(grant.permissions, "workspace:admin"),
        );
        const canRedeem = canResumeRedemption && account.status === "active";
        overview[account.id] = await fetchCodexAccountOverview(
          deps,
          workspaceId,
          account,
          canRedeem,
          canResumeRedemption,
          canResumeRedemption
            ? ownerRecoveries.filter((recovery) => recovery.credentialId === account.id)
            : [],
          providerCall,
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
      // Fill every unscheduled account from persisted cache without performing
      // more provider work. In-flight account operations remain rejection-
      // handled and are themselves bounded; they cannot delay this response or
      // leave limiter waiters permanently queued.
      const unavailableProviderCall: CodexProviderCall = async () => {
        throw new Error("Codex overview route deadline reached");
      };
      await Promise.all(
        accounts
          .filter((account) => overview[account.id] == null)
          .map(async (account) => {
            const canResumeRedemption = Boolean(
              human &&
              human.subjectId === grant.subjectId &&
              human.subjectId === account.connectedBySubjectId &&
              hasPermission(grant.permissions, "workspace:admin"),
            );
            const fallback = await fetchCodexAccountOverview(
              deps,
              workspaceId,
              account,
              false,
              canResumeRedemption,
              canResumeRedemption
                ? ownerRecoveries.filter((recovery) => recovery.credentialId === account.id)
                : [],
              unavailableProviderCall,
            );
            // A bounded in-flight worker may have completed while fallback was
            // assembled; prefer that fresh truth when present.
            overview[account.id] ??= fallback;
          }),
      );
      void workers.catch(() => undefined);
    }
    // Overview writes the same authoritative usage snapshots as the explicit
    // refresh routes. Deliver any committed capacity outbox entries instead of
    // leaving quota-recovered waiters dormant until a later unrelated refresh.
    void signalPendingCodexCapacityTargets(deps, workspaceId).catch(() => undefined);
    return c.json({ accounts: overview });
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
      c.header("cache-control", "no-store");
      const parsed = redemptionPrepareBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HTTPException(400, {
          message: "attemptId and creditId are required",
        });
      }
      const accounts = await listCodexAccountStatuses(db, workspaceId);
      const account = accounts.find((candidate) => candidate.id === credentialId);
      if (!account) throw new HTTPException(404, { message: "codex account not found" });
      let existing = await getCodexResetRedemptionAttempt(db, workspaceId, parsed.data.attemptId);
      if (account.connectedBySubjectId !== human.subjectId) {
        throw new HTTPException(403, {
          message: "only the human who connected this subscription may redeem its reset credits",
        });
      }
      if (
        existing &&
        (existing.credentialId !== credentialId ||
          existing.creditId !== parsed.data.creditId ||
          existing.subjectId !== human.subjectId)
      ) {
        throw new HTTPException(409, {
          message: "logical redemption attempt identity mismatch",
        });
      }
      if (existing) {
        const adoption = await adoptCodexResetRedemptionAttempt(db, {
          accountId,
          workspaceId,
          attemptId: existing.id,
          credentialId,
          creditId: existing.creditId,
          subjectId: human.subjectId,
          browserSessionHash: human.browserSessionHash,
        });
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
          throw new HTTPException(409, {
            message: "logical redemption attempt identity mismatch",
          });
        }
        existing = adoption.attempt;
      }
      // Starting or retrying provider work requires a healthy credential. A
      // completed attempt is different: its provider outcome is durable truth,
      // and a lost HTTP response must remain replayable after a later health
      // transition without another consume call.
      if (account.status !== "active" && existing?.status !== "completed") {
        throw new HTTPException(403, { message: "redemption credential is unavailable" });
      }
      const secret = settings.betterAuthSecret;
      if (!secret) {
        throw new HTTPException(503, {
          message: "managed browser confirmation is unavailable",
        });
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
        // A completed attempt may have lost its HTTP response after its outcome
        // committed. Keep that exact logical id replayable without another
        // provider consume call, just like an ambiguous provider_started attempt.
        resumable: existing?.status === "provider_started" || existing?.status === "completed",
        recoveryStatus:
          existing?.status === "provider_started" || existing?.status === "completed"
            ? existing.status
            : null,
      });
    },
  );

  // The only OpenGeni reset-credit mutation route. There is intentionally no
  // SDK/MCP/worker/scheduled/background equivalent.
  app.post(
    "/v1/workspaces/:workspaceId/codex/accounts/:accountId/reset-credits/redeem",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const credentialId = c.req.param("accountId");
      const { human, accountId } = await requireRedemptionHuman(c, deps, workspaceId);
      c.header("cache-control", "no-store");
      const parsed = redemptionBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HTTPException(400, {
          message: "explicit redemption confirmation is required",
        });
      }
      const secret = settings.betterAuthSecret;
      if (!secret) {
        throw new HTTPException(503, {
          message: "managed browser confirmation is unavailable",
        });
      }
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
        throw new HTTPException(403, {
          message: "redemption confirmation is invalid or expired",
        });
      }

      const claimHolderId = crypto.randomUUID();
      const claimed = await claimCodexResetRedemption(db, {
        id: parsed.data.attemptId,
        accountId,
        workspaceId,
        credentialId,
        subjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
        creditId: parsed.data.creditId,
        confirmationExpiresAt: new Date(claims.expiresAt * 1000),
        claimHolderId,
      });
      if (claimed.kind === "not_found") {
        throw new HTTPException(404, { message: "codex account not found" });
      }
      if (claimed.kind === "forbidden") {
        throw new HTTPException(403, {
          message: "redemption owner or credential is unavailable",
        });
      }
      if (claimed.kind === "conflict") {
        throw new HTTPException(409, {
          message: "logical redemption attempt identity mismatch",
        });
      }
      if (claimed.kind === "in_progress") {
        return c.json({ status: "in_progress", attemptId: parsed.data.attemptId }, 409);
      }

      const finishResponse = (outcome: string) =>
        c.json({
          status: "completed",
          attemptId: parsed.data.attemptId,
          outcome,
          // Durable provider truth must never wait for best-effort provider
          // readback. The browser refreshes overview independently after this
          // response; a hung account cannot suppress a completed outcome.
          overview: null,
        });
      if (claimed.kind === "completed") {
        return finishResponse(claimed.attempt.outcome!);
      }

      const attempt = claimed.attempt;
      const fetchImpl = (deps.codexFetch ?? fetch) as CodexFetch;
      if (attempt.status === "processing") {
        const details = await fetchCodexRateLimitResetCreditsForAccount(
          db,
          settings,
          workspaceId,
          credentialId,
          fetchImpl,
        );
        if (!details.ok) {
          await abandonCodexResetRedemptionBeforeProvider(db, {
            accountId,
            workspaceId,
            attemptId: attempt.id,
            claimHolderId,
          });
          return c.json(
            {
              status: "preflight_unavailable",
              attemptId: attempt.id,
              retryable: true,
            },
            503,
          );
        }
        if (!freshActionableCredit(details.details, attempt.creditId)) {
          await abandonCodexResetRedemptionBeforeProvider(db, {
            accountId,
            workspaceId,
            attemptId: attempt.id,
            claimHolderId,
          });
          return c.json(
            {
              status: "not_actionable",
              attemptId: attempt.id,
              retryable: false,
            },
            409,
          );
        }
      }

      let token: Awaited<ReturnType<ReturnType<typeof buildCodexTokenResolver>["getToken"]>>;
      try {
        token = await buildCodexTokenResolver(db, settings, workspaceId, credentialId).getToken();
      } catch {
        if (attempt.status === "processing") {
          await abandonCodexResetRedemptionBeforeProvider(db, {
            accountId,
            workspaceId,
            attemptId: attempt.id,
            claimHolderId,
          });
        } else {
          await releaseCodexResetRedemptionClaim(db, {
            accountId,
            workspaceId,
            attemptId: attempt.id,
            claimHolderId,
            failureKind: "provider_auth_unavailable",
          });
        }
        return c.json(
          {
            status: "provider_unavailable",
            attemptId: attempt.id,
            retryable: true,
          },
          503,
        );
      }
      const fenced = await fenceCodexResetRedemptionSend(db, {
        accountId,
        workspaceId,
        attemptId: attempt.id,
        claimHolderId,
        credentialId,
        subjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
      });
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
      const consumed = await consumeCodexRateLimitResetCredit(
        {
          accessToken: token.accessToken,
          chatgptAccountId: token.chatgptAccountId,
          isFedramp: token.isFedramp,
          clientVersion: CODEX_CLIENT_VERSION,
        },
        {
          idempotencyKey: sendAttempt.upstreamIdempotencyKey,
          creditId: sendAttempt.creditId,
        },
        fetchImpl,
      );
      if (!consumed.ok) {
        await releaseCodexResetRedemptionClaim(db, {
          accountId,
          workspaceId,
          attemptId: attempt.id,
          claimHolderId,
          failureKind: `provider_${consumed.reason}`,
        });
        return c.json({ status: "ambiguous", attemptId: attempt.id, retryable: true }, 503);
      }
      const completion = await completeCodexResetRedemption(db, {
        accountId,
        workspaceId,
        attemptId: attempt.id,
        claimHolderId,
        outcome: consumed.result.outcome,
      });
      const completed = completion.result;
      if (!completed) {
        return c.json({ status: "in_progress", attemptId: attempt.id }, 409);
      }
      // The outbox is durable; signaling is best-effort and must not hold the
      // owning human's already-completed provider outcome hostage.
      void signalCodexCapacityTargets(deps, completion.wakeTargets).catch(() => undefined);
      return finishResponse(completed.outcome!);
    },
  );
}
