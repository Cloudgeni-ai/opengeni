// Shared, id-addressed, REFRESHING Codex token resolver (P2).
//
// Hoisted here from apps/worker/src/activities/codex-auth.ts so BOTH the worker
// (turn-time bearer for the streamed run) AND the api (the /wham/usage quota-bar
// reads) drive ONE resolver — no duplicated refresh/CAS/single-flight logic. The
// worker re-exports buildCodexTokenResolver from this module for back-compat, so
// the agent-turn.ts call site is unchanged.
//
// Why @opengeni/db is the right home: the resolver only orchestrates accessors
// this package already owns (loadCodexCredentialForRun / recordCodexTokenRefresh /
// setCodexCredentialStatus / encryptEnvironmentValue) plus pure @opengeni/codex
// refresh helpers and the @opengeni/config key — keeping the refresh-CAS + RLS
// invariants co-located with the rows they protect.
//
// CROSS-PROCESS SAFETY: the process-module `inflight` map coalesces local callers,
// while a Postgres advisory transaction lock serializes API/worker replicas. A
// waiter re-reads after taking that lock and skips refresh when the version moved.
// The existing (id,version) CAS remains the final stale-family write fence.

import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  accessTokenExpiry,
  CODEX_CLIENT_VERSION,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexReloginRequired,
  type CodexTokenSnapshot,
  type CodexUsagePayload,
  type CodexFetch,
  type CodexRateLimitResetCreditsDetails,
  type ResetCreditFetchFailureReason,
  fetchCodexRateLimitResetCredits,
  fetchCodexUsage,
  normalizeCodexUsage,
  refreshCodexToken,
} from "@opengeni/codex";
import { encryptEnvironmentValue } from "./environment-crypto";
import {
  loadCodexCredentialForRun,
  recordCodexAccountUsage,
  recordCodexTokenRefresh,
  setCodexCredentialStatus,
  withCodexCredentialRefreshLock,
  type CodexCredentialForRun,
  type Database,
} from "./index";

// Single-flight per CREDENTIAL INSTANCE (row id + version), process-module scope.
// Keying by the loaded credential's id+version — NOT by workspaceId alone (P1-b) —
// is what makes a disconnect→reconnect safe: a post-reconnect getToken loads a
// DIFFERENT row (new uuid id) and so gets a distinct key, instead of coalescing
// onto the OLD in-flight refresh and writing stale rotated tokens over the freshly
// connected credential. Concurrent calls for the SAME credential still coalesce,
// so the one-time refresh token is never double-spent.
const inflight = new Map<string, Promise<CodexTokenSnapshot>>();
const CODEX_TOKEN_REFRESH_TIMEOUT_MS = 6_000;

async function withCodexTokenDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guarded = operation.then(
    (value) => value,
    (error) => {
      throw error;
    },
  );
  try {
    return await Promise.race([
      guarded,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Codex token refresh timed out")),
          CODEX_TOKEN_REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Dependencies are injectable so the lifecycle logic (single-flight, staleness,
// needs_relogin transition) is unit-testable without a database. Production uses
// the real db + codex functions via the default bag.
export type CodexAuthDeps = {
  loadCredential: typeof loadCodexCredentialForRun;
  recordRefresh: typeof recordCodexTokenRefresh;
  setStatus: typeof setCodexCredentialStatus;
  refresh: typeof refreshCodexToken;
  encrypt: typeof encryptEnvironmentValue;
  keyBytes: typeof environmentsEncryptionKeyBytes;
  withRefreshLock: typeof withCodexCredentialRefreshLock;
};

const defaultDeps: CodexAuthDeps = {
  loadCredential: loadCodexCredentialForRun,
  recordRefresh: recordCodexTokenRefresh,
  setStatus: setCodexCredentialStatus,
  refresh: refreshCodexToken,
  encrypt: encryptEnvironmentValue,
  keyBytes: environmentsEncryptionKeyBytes,
  withRefreshLock: withCodexCredentialRefreshLock,
};

export function buildCodexTokenResolver(
  db: Database,
  settings: Settings,
  workspaceId: string,
  // The RESOLVED effective credential id (pin > workspace active), threaded from
  // the worker. A mid-turn switch loads a DIFFERENT row id, gets a distinct
  // single-flight key, and the (id, version) CAS in recordCodexTokenRefresh writes
  // 0 rows against the now-inactive row — so a refresh racing a switch can never
  // clobber the newly-active account. The single-flight map needs zero change.
  credentialId: string,
  deps: CodexAuthDeps = defaultDeps,
): { getToken: () => Promise<CodexTokenSnapshot>; refresh: () => Promise<CodexTokenSnapshot> } {
  const snapshot = (cred: CodexCredentialForRun): CodexTokenSnapshot => ({
    accessToken: cred.tokens.accessToken,
    chatgptAccountId: cred.chatgptAccountId,
    isFedramp: cred.isFedramp,
  });

  const performRefresh = async (
    refreshDb: Database,
    cred: CodexCredentialForRun,
  ): Promise<CodexTokenSnapshot> => {
    try {
      // Bound even injected/custom refresh implementations that ignore abort
      // signals. The provider client has its own AbortController timeout; this
      // outer fence ensures the DB advisory transaction cannot be held forever.
      const next = await withCodexTokenDeadline(deps.refresh(cred.tokens.refreshToken));
      const tokens = {
        access_token: next.accessToken ?? cred.tokens.accessToken,
        refresh_token: next.refreshToken ?? cred.tokens.refreshToken,
        id_token: next.idToken ?? cred.tokens.idToken,
      };
      const key = deps.keyBytes(settings);
      if (!key) {
        throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
      }
      // Compare-and-set on the loaded (id, version): if a disconnect→reconnect
      // replaced the row mid-refresh, this writes 0 rows and we must NOT clobber
      // the new credential with our now-defunct rotated tokens.
      const persisted = await deps.recordRefresh(refreshDb, {
        id: cred.id,
        version: cred.version,
        workspaceId,
        credentialEncrypted: deps.encrypt(key, JSON.stringify(tokens)),
        expiresAt: accessTokenExpiry(tokens.access_token),
        lastRefreshAt: new Date(),
      });
      if (!persisted) {
        // The row changed under us. Our rotated tokens belong to a stale family;
        // fall back to whatever is connected NOW (a reconnect leaves an active
        // row). If nothing active remains, a relogin is genuinely required.
        const current = await deps.loadCredential(refreshDb, settings, workspaceId, credentialId);
        if (current && current.status === "active") {
          return snapshot(current);
        }
        throw new CodexReloginRequired(
          "Codex credential changed during token refresh; reconnect required.",
        );
      }
      return {
        accessToken: tokens.access_token,
        chatgptAccountId: cred.chatgptAccountId,
        isFedramp: cred.isFedramp,
      };
    } catch (error) {
      if (error instanceof CodexReloginRequired) {
        // Stamp needs_relogin ONLY if the row we refreshed is STILL current
        // (compare-and-set on the loaded id+version). A relogin triggered by the
        // OLD token family must never stamp needs_relogin onto a freshly
        // reconnected credential.
        await deps.setStatus(refreshDb, workspaceId, "needs_relogin", error.message, {
          id: cred.id,
          version: cred.version,
        });
      }
      throw error;
    }
  };

  // ALL refreshes — whether proactive or a 401 retry — coalesce locally and then
  // serialize globally before any rotating refresh token reaches the provider.
  const doRefresh = (cred: CodexCredentialForRun): Promise<CodexTokenSnapshot> => {
    const key = `${cred.id}:${cred.version}`;
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = deps
      .withRefreshLock(db, workspaceId, credentialId, async (lockedDb) => {
        try {
          const current = await deps.loadCredential(lockedDb, settings, workspaceId, credentialId);
          if (!current || current.status !== "active") {
            throw new CodexReloginRequired(
              "Codex credential became unavailable while waiting to refresh.",
            );
          }
          if (current.version !== cred.version) {
            return { ok: true as const, value: snapshot(current) };
          }
          return { ok: true as const, value: await performRefresh(lockedDb, current) };
        } catch (error) {
          // withCodexCredentialRefreshLock uses an advisory TRANSACTION lock.
          // performRefresh may persist `needs_relogin` before surfacing a
          // permanent OAuth failure; throwing from this callback would roll that
          // status write back with the outer transaction. Return the failure so
          // the transaction commits, then rethrow after the lock is released.
          return { ok: false as const, error };
        }
      })
      .then((outcome) => {
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      })
      .finally(() => {
        if (inflight.get(key) === promise) {
          inflight.delete(key);
        }
      });
    inflight.set(key, promise);
    return promise;
  };

  const resolve = async (force: boolean): Promise<CodexTokenSnapshot> => {
    const cred = await deps.loadCredential(db, settings, workspaceId, credentialId);
    if (!cred) {
      throw new CodexReloginRequired("No Codex subscription is connected for this workspace.");
    }
    const exp = cred.expiresAt ?? accessTokenExpiry(cred.tokens.accessToken);
    const stale =
      force ||
      (exp
        ? exp.getTime() <= Date.now() + CODEX_REFRESH_WINDOW_MS
        : cred.lastRefreshAt
          ? cred.lastRefreshAt.getTime() < Date.now() - CODEX_REFRESH_FALLBACK_MS
          : true);
    return stale ? doRefresh(cred) : snapshot(cred);
  };

  return { getToken: () => resolve(false), refresh: () => resolve(true) };
}

function errorUsagePayload(reason?: "needs_relogin"): CodexUsagePayload {
  return {
    status: "error",
    planType: null,
    fiveHour: null,
    weekly: null,
    limitReached: false,
    fetchedAt: new Date().toISOString(),
    rateLimitResetCredits: null,
    ...(reason ? { reason } : {}),
  };
}

/**
 * THE single per-account usage path both the api route and an (optional) worker
 * poll call, so the refresh discipline and the cache-write can never drift.
 *
 *   1. resolve a REFRESHING bearer for THIS account (proactive staleness refresh,
 *      single-flight, (id,version) CAS-persist) — this is what stops an idle
 *      account's expired JWT from 401-ing the usage read.
 *   2. fetch GET /wham/usage with that bearer.
 *   3. normalize (§3) into the P2/P3 contract.
 *   4. on any windows present, write the five usage-cache columns (the TTL clock).
 *
 * A refresh that stamps needs_relogin returns { status:"error", reason } and never
 * hits the provider; a transient refresh error returns a plain error payload.
 */
export async function fetchCodexUsageForAccount(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  fetchImpl: CodexFetch = fetch,
): Promise<CodexUsagePayload> {
  const resolver = buildCodexTokenResolver(db, settings, workspaceId, credentialId);
  let token: CodexTokenSnapshot;
  try {
    token = await resolver.getToken();
  } catch (error) {
    return errorUsagePayload(error instanceof CodexReloginRequired ? "needs_relogin" : undefined);
  }

  let normalized: CodexUsagePayload;
  try {
    const usage = await fetchCodexUsage(
      {
        accessToken: token.accessToken,
        chatgptAccountId: token.chatgptAccountId,
        isFedramp: token.isFedramp,
        clientVersion: CODEX_CLIENT_VERSION,
      },
      fetchImpl,
    );
    normalized = normalizeCodexUsage(usage.status, usage.payload);
  } catch {
    // A network throw on the /wham/usage read must surface as an error PAYLOAD
    // ({status:"error"} at 200), never an unhandled 500 from the route.
    return errorUsagePayload();
  }

  const parsedQuota =
    normalized.status !== "error" && (normalized.fiveHour != null || normalized.weekly != null);
  if (parsedQuota || normalized.rateLimitResetCredits) {
    const checkedAt = new Date();
    // Quota windows and reset-summary freshness are independent. A malformed
    // usage body can still carry a syntactically valid count; that count may be
    // cached without erasing or falsely refreshing the last valid quota truth.
    // Cache-write is best-effort: a disconnect under us (false) or a transient
    // write error must NOT sink the freshly-read result we are about to return.
    await recordCodexAccountUsage(db, workspaceId, credentialId, {
      ...(parsedQuota
        ? {
            primaryUsedPercent: normalized.fiveHour?.percent ?? null,
            primaryResetAt: normalized.fiveHour?.resetAt
              ? new Date(normalized.fiveHour.resetAt)
              : null,
            secondaryUsedPercent: normalized.weekly?.percent ?? null,
            secondaryResetAt: normalized.weekly?.resetAt
              ? new Date(normalized.weekly.resetAt)
              : null,
            checkedAt,
          }
        : {}),
      ...(normalized.rateLimitResetCredits
        ? {
            resetCreditAvailableCount: normalized.rateLimitResetCredits.availableCount,
            resetCreditsCheckedAt: checkedAt,
          }
        : {}),
    }).catch(() => undefined);
  }

  return normalized;
}

export type CodexRateLimitResetCreditsAccountResult =
  | { ok: true; status: number; details: CodexRateLimitResetCreditsDetails }
  | {
      ok: false;
      status: number;
      reason: ResetCreditFetchFailureReason | "needs_relogin";
    };

/**
 * Fresh detailed reset-credit inventory for one exact workspace credential.
 * The token is refreshed through the same resolver as usage and never escapes
 * this server-side function. Detailed rows are returned to the route only and
 * are never persisted as redemption authority.
 */
export async function fetchCodexRateLimitResetCreditsForAccount(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
  fetchImpl: CodexFetch = fetch,
): Promise<CodexRateLimitResetCreditsAccountResult> {
  const resolver = buildCodexTokenResolver(db, settings, workspaceId, credentialId);
  let token: CodexTokenSnapshot;
  try {
    token = await resolver.getToken();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: error instanceof CodexReloginRequired ? "needs_relogin" : "network_error",
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
}
