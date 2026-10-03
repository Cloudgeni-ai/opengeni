import {
  ClaudeSubscriptionCredential,
  environmentsEncryptionKeyBytes,
  type Settings,
} from "@opengeni/config";
import type { Database } from "./database";
import {
  loadClaudeAccountCredential,
  recordClaudeAccountUsage,
  type ClaudeAccountUsageAuthority,
} from "./claude-subscription-account-usage";
import {
  refreshClaudeSubscriptionAccountSerialized,
  refreshOrganizationClaudeSubscriptionAccountSerialized,
} from "./claude-subscription-accounts";
import {
  requestClaudeTokenRefresh,
  ClaudeSubscriptionReconnectRequired,
  ClaudeSubscriptionConnectionChanged,
} from "./claude-subscription-tokens";

/** The selected account's identity and rotating token pair are resolved together. */
export async function resolveClaudeAccountCredential(
  db: Database,
  settings: Settings,
  authority: ClaudeAccountUsageAuthority,
  options: {
    fetchImpl?: typeof fetch;
    expectedCredentialVersion?: number;
    forceRefresh?: boolean;
    observedAccessToken?: string;
    now?: () => number;
  } = {},
) {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!settings.claudeSubscriptionEnabled || !encryptionKey)
    throw new Error("Claude subscriptions are unavailable");
  const now = options.now ?? Date.now;
  const original = await loadClaudeAccountCredential(db, authority, encryptionKey);
  if (
    options.expectedCredentialVersion !== undefined &&
    original.version !== options.expectedCredentialVersion
  )
    throw new ClaudeSubscriptionConnectionChanged();
  if (
    options.observedAccessToken !== undefined &&
    original.secret.token !== options.observedAccessToken
  )
    return original;
  if (original.usage.refreshStatus === "reconnect")
    return { ...original, reconnectRequired: true as const };
  if (
    !original.secret.oauth ||
    (!options.forceRefresh && Date.parse(original.secret.oauth.expiresAt) - now() > 60_000)
  )
    return original;
  let reconnectRequired = false;
  const input = {
    ...authority,
    encryptionKey,
    observedAccessToken: original.secret.token,
    observedRefreshToken: original.secret.oauth.refreshToken,
    refresh: async (current: { secret: typeof original.secret; version: number }) => {
      if (current.version !== original.version) throw new ClaudeSubscriptionConnectionChanged();
      if (
        !current.secret.oauth ||
        (!options.forceRefresh && Date.parse(current.secret.oauth.expiresAt) - now() > 60_000)
      )
        return {
          secret: current.secret,
          expiresAt: current.secret.oauth ? new Date(current.secret.oauth.expiresAt) : null,
        };
      try {
        const tokens = await requestClaudeTokenRefresh(
          current.secret,
          options.fetchImpl ?? globalThis.fetch,
        );
        const expiresAt = new Date(now() + tokens.expires_in * 1000);
        const secret = ClaudeSubscriptionCredential.parse({
          ...current.secret,
          token: tokens.access_token,
          oauth: {
            ...current.secret.oauth,
            refreshToken: tokens.refresh_token ?? current.secret.oauth.refreshToken,
            expiresAt: expiresAt.toISOString(),
            scopes: tokens.scope.split(/\s+/).filter(Boolean),
          },
        });
        return { secret, expiresAt };
      } catch (error) {
        if (!(error instanceof ClaudeSubscriptionReconnectRequired)) throw error;
        reconnectRequired = true;
        return { secret: current.secret, expiresAt: new Date(current.secret.oauth.expiresAt) };
      }
    },
  };
  const result = authority.workspaceId
    ? await refreshClaudeSubscriptionAccountSerialized(db, {
        ...input,
        workspaceId: authority.workspaceId,
      })
    : await refreshOrganizationClaudeSubscriptionAccountSerialized(db, {
        ...input,
        workspaceId: null,
      });
  const credential = result.credential;
  if (credential.version !== original.version) throw new ClaudeSubscriptionConnectionChanged();
  if (reconnectRequired) {
    const usage = await recordClaudeAccountUsage(db, authority, {
      encryptionKey,
      token: credential.secret.token,
      expectedCredentialVersion: credential.version,
      refresh: { status: "reconnect", checkedAt: new Date(now()).toISOString() },
    });
    if (!usage) throw new ClaudeSubscriptionConnectionChanged();
    return { ...credential, usage, reconnectRequired: true as const };
  }
  const latest = await loadClaudeAccountCredential(db, authority, encryptionKey);
  if (latest.version !== original.version) throw new ClaudeSubscriptionConnectionChanged();
  return { ...credential, ...latest };
}
