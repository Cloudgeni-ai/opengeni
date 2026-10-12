import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { Database } from "../../../src/database";
import {
  loadClaudeAccountCredential,
  recordClaudeAccountUsage,
  type ClaudeAccountUsageAuthority,
} from "./account-usage";
import {
  refreshClaudeSubscriptionAccountSerialized,
  refreshOrganizationClaudeSubscriptionAccountSerialized,
} from "./accounts";
import {
  claudeRefreshedCredential,
  requestClaudeTokenRefresh,
  ClaudeSubscriptionReconnectRequired,
} from "../../../src/subscription-core-claude-oauth";

/** The account's credential changed under a legacy usage read; reload. */
export class ClaudeSubscriptionConnectionChanged extends Error {
  readonly status = 409;
  constructor() {
    super("Claude connection changed; reload usage.");
  }
}

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
        const { credential: secret, expiresAt } = claudeRefreshedCredential(
          current.secret,
          tokens,
          now(),
        );
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
