import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  materializeXaiCredentialForRun,
  refreshXaiSubscriptionCredential,
  type Database,
} from "@opengeni/db";
import type { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import {
  refreshXaiToken,
  XAI_CLIENT_VERSION,
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XaiSubscriptionReloginRequired,
  xaiAccessTokenExpiry,
  type XaiFetch,
  type XaiSubscriptionRequestContext,
  type XaiSubscriptionTokenSnapshot,
} from "@opengeni/xai-subscription";

export type XaiTurnRequestAuthorization = {
  context: XaiSubscriptionRequestContext;
  credentialId: string;
};

export async function buildXaiTurnRequestAuthorization(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  sessionId: string;
  turnId: string;
  credentialId: string;
  authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
  fetch?: XaiFetch;
  hostedSearch?: XaiSubscriptionRequestContext["hostedSearch"];
  onFinalContextUsage?: XaiSubscriptionRequestContext["onFinalContextUsage"];
  nextRequestId?: XaiSubscriptionRequestContext["nextRequestId"];
}): Promise<XaiTurnRequestAuthorization> {
  const encryptionKey = environmentsEncryptionKeyBytes(input.settings);
  if (!encryptionKey) {
    throw new Error("SuperGrok subscriptions require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  }
  let credential = await materializeXaiCredentialForRun(input.db, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    credentialId: input.credentialId,
    authoritySnapshot: input.authoritySnapshot,
    encryptionKey,
  });

  const tokenSnapshot = (): XaiSubscriptionTokenSnapshot => {
    const accessToken = credential.secret.accessToken;
    const userId = credential.providerAccountId;
    if (!accessToken || !userId) {
      throw new XaiSubscriptionReloginRequired(
        "The SuperGrok connection is missing a verified token identity. Reconnect the account.",
      );
    }
    return { accessToken, userId };
  };

  const refresh = async (): Promise<XaiSubscriptionTokenSnapshot> => {
    const refreshToken = credential.secret.refreshToken;
    if (!refreshToken) {
      throw new XaiSubscriptionReloginRequired(
        "The SuperGrok connection cannot be refreshed. Reconnect the account.",
      );
    }
    const tokens = await refreshXaiToken(refreshToken, {
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const expiresAt =
      xaiAccessTokenExpiry(tokens.accessToken) ??
      new Date(Date.now() + tokens.expiresInSeconds * 1_000);
    credential = await refreshXaiSubscriptionCredential(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      credentialId: input.credentialId,
      authoritySnapshot: input.authoritySnapshot,
      encryptionKey,
      secret: {
        version: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
      providerAccountId: credential.providerAccountId,
      label: credential.label,
      accountEmail: credential.accountEmail,
      planType: credential.planType,
      expiresAt,
    });
    return tokenSnapshot();
  };

  return {
    credentialId: input.credentialId,
    context: {
      clientVersion: XAI_CLIENT_VERSION,
      sessionId: input.sessionId,
      turnId: input.turnId,
      getToken: async () => tokenSnapshot(),
      refresh,
      resolveModel: (model) =>
        model.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
          ? model.slice(XAI_SUBSCRIPTION_MODEL_ID_PREFIX.length)
          : model,
      ...(input.hostedSearch ? { hostedSearch: input.hostedSearch } : {}),
      ...(input.onFinalContextUsage ? { onFinalContextUsage: input.onFinalContextUsage } : {}),
      ...(input.nextRequestId ? { nextRequestId: input.nextRequestId } : {}),
    },
  };
}
