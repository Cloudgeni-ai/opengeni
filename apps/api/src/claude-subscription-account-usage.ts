import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  resolveClaudeAccountCredential,
  recordClaudeAccountUsage,
  ClaudeSubscriptionConnectionChanged,
  ClaudeSubscriptionRefreshUnavailable,
  type ClaudeAccountUsageAuthority,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requestClaudeUsage } from "./claude-subscription-usage";

/** Profile quota requests never run inference and never select a different account. */
export async function refreshClaudeAccountUsage(
  db: Database,
  settings: Settings,
  authority: ClaudeAccountUsageAuthority,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const credential = await resolveClaudeAccountCredential(db, settings, authority, {
    fetchImpl,
  }).catch((error) => {
    if (error instanceof ClaudeSubscriptionRefreshUnavailable)
      throw new HTTPException(503, { message: error.message, cause: error });
    throw error;
  });
  if ("reconnectRequired" in credential) return credential.usage;
  const current = credential.usage;
  if (
    current.refreshStatus === "scope_required" ||
    (current.refreshCheckedAt && Date.now() - Date.parse(current.refreshCheckedAt) < 30_000)
  )
    return current;
  const result = credential.secret.oauth?.scopes.includes("user:profile")
    ? await requestClaudeUsage(credential.secret.token, fetchImpl)
    : { status: "scope_required" as const, observation: null, checkedAt: new Date().toISOString() };
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) throw new Error("Claude credential encryption is unavailable");
  const usage = await recordClaudeAccountUsage(db, authority, {
    encryptionKey,
    token: credential.secret.token,
    expectedCredentialVersion: credential.version,
    ...(result.observation ? { observation: result.observation } : {}),
    refresh: { status: result.status, checkedAt: result.checkedAt },
  });
  if (!usage) throw new ClaudeSubscriptionConnectionChanged();
  return usage;
}
