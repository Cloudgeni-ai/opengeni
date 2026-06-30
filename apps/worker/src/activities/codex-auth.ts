// db-backed Codex token lifecycle for a turn: proactive refresh, single-flight
// per workspace, and permanent-failure status surfacing. This is where the
// database meets the pure @opengeni/codex refresh client. The returned getToken/
// refresh are handed to codexRequestStorage so codexSubscriptionFetch can resolve
// the per-workspace bearer at call time.

import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  type CodexCredentialForRun,
  type Database,
  encryptEnvironmentValue,
  loadCodexCredentialForRun,
  recordCodexTokenRefresh,
  setCodexCredentialStatus,
} from "@opengeni/db";
import {
  accessTokenExpiry,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexReloginRequired,
  type CodexTokenSnapshot,
  refreshCodexToken,
} from "@opengeni/codex";

// Single-flight per CREDENTIAL INSTANCE (row id + version), process-module scope.
// One Temporal worker per process makes this the right grain. Keying by the
// loaded credential's id+version — NOT by workspaceId alone (P1-b) — is what makes
// a disconnect→reconnect safe: a post-reconnect getToken loads a DIFFERENT row
// (new uuid id) and so gets a distinct key, instead of coalescing onto the OLD
// in-flight refresh and writing stale rotated tokens over the freshly connected
// credential (which would invalidate the new token family → 401 → needs_relogin →
// a second, independent "no active subscription"). Concurrent calls for the SAME
// credential still coalesce, so the one-time refresh token is never double-spent.
const inflight = new Map<string, Promise<CodexTokenSnapshot>>();

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
};

const defaultDeps: CodexAuthDeps = {
  loadCredential: loadCodexCredentialForRun,
  recordRefresh: recordCodexTokenRefresh,
  setStatus: setCodexCredentialStatus,
  refresh: refreshCodexToken,
  encrypt: encryptEnvironmentValue,
  keyBytes: environmentsEncryptionKeyBytes,
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

  const performRefresh = async (cred: CodexCredentialForRun): Promise<CodexTokenSnapshot> => {
    try {
      const next = await deps.refresh(cred.tokens.refreshToken);
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
      const persisted = await deps.recordRefresh(db, {
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
        const current = await deps.loadCredential(db, settings, workspaceId, credentialId);
        if (current && current.status === "active") {
          return snapshot(current);
        }
        throw new CodexReloginRequired("Codex credential changed during token refresh; reconnect required.");
      }
      return { accessToken: tokens.access_token, chatgptAccountId: cred.chatgptAccountId, isFedramp: cred.isFedramp };
    } catch (error) {
      if (error instanceof CodexReloginRequired) {
        // Stamp needs_relogin ONLY if the row we refreshed is STILL current
        // (compare-and-set on the loaded id+version). A relogin triggered by the
        // OLD token family must never stamp needs_relogin onto a freshly
        // reconnected credential.
        await deps.setStatus(db, workspaceId, "needs_relogin", error.message, { id: cred.id, version: cred.version });
      }
      throw error;
    }
  };

  // ALL refreshes — whether triggered by proactive staleness (getToken) or by a
  // 401 retry (refresh) — coalesce onto one in-flight promise per workspace, so
  // concurrent model calls in a turn can never double-spend the one-time refresh
  // token (which would trigger refresh_token_reused -> needs_relogin).
  const doRefresh = (cred: CodexCredentialForRun): Promise<CodexTokenSnapshot> => {
    // Key by the credential INSTANCE (id+version), so a reconnect's new row never
    // coalesces onto the old row's in-flight refresh (P1-b). The row id is a uuid,
    // globally unique across the delete+reinsert a disconnect→reconnect performs.
    const key = `${cred.id}:${cred.version}`;
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = performRefresh(cred).finally(() => {
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
