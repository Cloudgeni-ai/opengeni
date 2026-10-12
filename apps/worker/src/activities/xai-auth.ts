import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  materializeXaiCredentialForRun,
  refreshXaiSubscriptionCredentialSerialized,
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

/** The request-context options shared by the legacy and the core SuperGrok paths. */
export type XaiTurnRequestContextOptions = {
  sessionId: string;
  turnId: string;
  hostedSearch?: XaiSubscriptionRequestContext["hostedSearch"];
  onFinalContextUsage?: XaiSubscriptionRequestContext["onFinalContextUsage"];
  nextRequestId?: XaiSubscriptionRequestContext["nextRequestId"];
  streamIdleTimeoutMs?: XaiSubscriptionRequestContext["streamIdleTimeoutMs"];
  onModelRequestDiagnostic?: XaiSubscriptionRequestContext["onModelRequestDiagnostic"];
  onModelRequestEvent?: XaiSubscriptionRequestContext["onModelRequestEvent"];
};

/** One turn's SuperGrok request context from its bearer source (and, on the core, custody). */
export function xaiTurnRequestContext(
  input: XaiTurnRequestContextOptions,
  credentials: Pick<
    XaiSubscriptionRequestContext,
    "getToken" | "refresh" | "beforeProviderDispatch" | "onProviderRequestSettled"
  >,
): XaiSubscriptionRequestContext {
  return {
    clientVersion: XAI_CLIENT_VERSION,
    sessionId: input.sessionId,
    turnId: input.turnId,
    getToken: credentials.getToken,
    refresh: credentials.refresh,
    resolveModel: (model) =>
      model.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
        ? model.slice(XAI_SUBSCRIPTION_MODEL_ID_PREFIX.length)
        : model,
    ...(input.hostedSearch ? { hostedSearch: input.hostedSearch } : {}),
    ...(input.onFinalContextUsage ? { onFinalContextUsage: input.onFinalContextUsage } : {}),
    ...(input.nextRequestId ? { nextRequestId: input.nextRequestId } : {}),
    ...(input.streamIdleTimeoutMs ? { streamIdleTimeoutMs: input.streamIdleTimeoutMs } : {}),
    ...(input.onModelRequestDiagnostic
      ? { onModelRequestDiagnostic: input.onModelRequestDiagnostic }
      : {}),
    ...(input.onModelRequestEvent ? { onModelRequestEvent: input.onModelRequestEvent } : {}),
    ...(credentials.beforeProviderDispatch
      ? { beforeProviderDispatch: credentials.beforeProviderDispatch }
      : {}),
    ...(credentials.onProviderRequestSettled
      ? { onProviderRequestSettled: credentials.onProviderRequestSettled }
      : {}),
  };
}

/** The legacy SuperGrok path: materialize and refresh the legacy credential row. */
export async function buildXaiTurnRequestAuthorization(
  input: XaiTurnRequestContextOptions & {
    db: Database;
    settings: Settings;
    accountId: string;
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
    fetch?: XaiFetch;
  },
): Promise<XaiTurnRequestAuthorization> {
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
      credentialId: input.credentialId,
      authoritySnapshot: input.authoritySnapshot,
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
  };

  return {
    credentialId: input.credentialId,
    context: xaiTurnRequestContext(input, { getToken: async () => tokenSnapshot(), refresh }),
  };
}
