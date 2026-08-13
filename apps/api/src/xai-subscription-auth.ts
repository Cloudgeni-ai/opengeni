import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import {
  materializeXaiCredentialForRun,
  refreshXaiSubscriptionCredentialSerialized,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  selectXaiCredentialForUse,
  type Database,
} from "@opengeni/db";
import {
  refreshXaiToken,
  XAI_CLIENT_VERSION,
  XaiSubscriptionReloginRequired,
  xaiAccessTokenExpiry,
  type XaiFetch,
  type XaiProxyAuthContext,
} from "@opengeni/xai-subscription";

export type XaiSubscriptionAuthorization = {
  context: XaiProxyAuthContext;
  credentialId: string;
  authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
  rotationEnabled: boolean;
};

export async function buildXaiSubscriptionAuthorization(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  shardKey: string;
  pinnedCredentialId?: string | null;
  pinSource?: "manual" | "policy" | null;
  authoritySnapshot?: XaiProviderAccountAuthoritySnapshotV1;
  sessionId?: string;
  fetch?: XaiFetch;
}): Promise<XaiSubscriptionAuthorization> {
  const encryptionKey = environmentsEncryptionKeyBytes(input.settings);
  if (!encryptionKey) {
    throw new Error("SuperGrok subscriptions require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  }
  const authoritySnapshot =
    input.authoritySnapshot ??
    (await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(input.db, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    }));
  const selected = await selectXaiCredentialForUse(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    authoritySnapshot,
    shardKey: input.shardKey,
    pinnedCredentialId: input.pinnedCredentialId ?? null,
    pinSource: input.pinSource ?? null,
  });
  if (!selected.credentialId) {
    throw new Error("No eligible SuperGrok subscription account is available");
  }
  const credentialId = selected.credentialId;
  let credential = await materializeXaiCredentialForRun(input.db, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    credentialId,
    authoritySnapshot,
    encryptionKey,
  });
  const tokenSnapshot = () => {
    if (!credential.secret.accessToken || !credential.providerAccountId) {
      throw new XaiSubscriptionReloginRequired(
        "The SuperGrok connection is missing a verified token identity. Reconnect the account.",
      );
    }
    return {
      accessToken: credential.secret.accessToken,
      userId: credential.providerAccountId,
    };
  };
  return {
    credentialId,
    authoritySnapshot,
    rotationEnabled: selected.rotationEnabled,
    context: {
      clientVersion: XAI_CLIENT_VERSION,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      getToken: async () => tokenSnapshot(),
      refresh: async () => {
        const observedAccessToken = credential.secret.accessToken;
        const observedRefreshToken = credential.secret.refreshToken;
        if (!observedRefreshToken) {
          throw new XaiSubscriptionReloginRequired(
            "The SuperGrok connection cannot be refreshed. Reconnect the account.",
          );
        }
        const result = await refreshXaiSubscriptionCredentialSerialized(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          credentialId,
          authoritySnapshot,
          encryptionKey,
          observedAccessToken,
          observedRefreshToken,
          refresh: async (current) => {
            const refreshToken = current.secret.refreshToken;
            if (!refreshToken) {
              throw new XaiSubscriptionReloginRequired(
                "The SuperGrok connection cannot be refreshed. Reconnect the account.",
              );
            }
            const tokens = await refreshXaiToken(refreshToken, {
              ...(input.fetch ? { fetch: input.fetch } : {}),
            });
            return {
              secret: {
                version: 1,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
              },
              expiresAt:
                xaiAccessTokenExpiry(tokens.accessToken) ??
                new Date(Date.now() + tokens.expiresInSeconds * 1_000),
            };
          },
        });
        credential = result.credential;
        return tokenSnapshot();
      },
    },
  };
}
