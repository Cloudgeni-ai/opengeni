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

// Single-flight per workspace, process-module scope. One Temporal worker per
// process makes this the right grain; concurrent cross-workspace turns are keyed
// apart by workspaceId, and a refresh-token is one-time so we never double-spend it.
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
      await deps.recordRefresh(db, {
        workspaceId,
        credentialEncrypted: deps.encrypt(key, JSON.stringify(tokens)),
        expiresAt: accessTokenExpiry(tokens.access_token),
        lastRefreshAt: new Date(),
      });
      return { accessToken: tokens.access_token, chatgptAccountId: cred.chatgptAccountId, isFedramp: cred.isFedramp };
    } catch (error) {
      if (error instanceof CodexReloginRequired) {
        await deps.setStatus(db, workspaceId, "needs_relogin", error.message);
      }
      throw error;
    }
  };

  // ALL refreshes — whether triggered by proactive staleness (getToken) or by a
  // 401 retry (refresh) — coalesce onto one in-flight promise per workspace, so
  // concurrent model calls in a turn can never double-spend the one-time refresh
  // token (which would trigger refresh_token_reused -> needs_relogin).
  const doRefresh = (cred: CodexCredentialForRun): Promise<CodexTokenSnapshot> => {
    const existing = inflight.get(workspaceId);
    if (existing) {
      return existing;
    }
    const promise = performRefresh(cred).finally(() => {
      if (inflight.get(workspaceId) === promise) {
        inflight.delete(workspaceId);
      }
    });
    inflight.set(workspaceId, promise);
    return promise;
  };

  const resolve = async (force: boolean): Promise<CodexTokenSnapshot> => {
    const cred = await deps.loadCredential(db, settings, workspaceId);
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
