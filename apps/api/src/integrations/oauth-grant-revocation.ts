import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import type { ConnectionMetadata } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  encryptEnvironmentValue,
  GOOGLE_OAUTH_GRANT_FAMILY,
  loadConnectionCredentialForBroker,
  oauthGrantFamilyForTokenEndpoint,
  oauthGrantSharedWithLiveConnection,
  type OAuthGrantFamily,
} from "@opengeni/db";

/** Google's OAuth 2.0 token revocation endpoint. */
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const OAUTH_REVOKE_TIMEOUT_MS = 5_000;

type DisconnectDeps = Pick<ApiRouteDeps, "db" | "settings" | "observability" | "googleDriveFetch">;
type DisconnectingConnection = Pick<
  ConnectionMetadata,
  "id" | "workspaceId" | "subjectId" | "kind" | "providerDomain" | "status"
>;

/**
 * A provider whose grant Opengeni ends on disconnect, with an RFC 7009
 * revocation endpoint. Each is a shared-grant family: revoking one token ends
 * every token the same account gave the same client, so the revoke happens
 * only when no other live connection anywhere may hold that grant.
 */
type OAuthGrantRevoker = {
  family: OAuthGrantFamily;
  revocationEndpoint: string;
  fetchImpl: (deps: DisconnectDeps) => typeof fetch;
};

const OAUTH_GRANT_REVOKERS: readonly OAuthGrantRevoker[] = [
  {
    family: GOOGLE_OAUTH_GRANT_FAMILY,
    revocationEndpoint: GOOGLE_OAUTH_REVOKE_URL,
    fetchImpl: (deps) => deps.googleDriveFetch ?? fetch,
  },
];

export type OAuthGrantDisconnect = {
  /** Encrypted credential without tokens, written by the revoke itself. */
  replacementCredentialEncrypted: string;
  /**
   * Ends the grant at the provider when no other live connection may hold it.
   * Call it only after the revoke write committed, so a disconnect that loses
   * its version check never cuts off a connection that stays active. Absent
   * when there is no token to revoke.
   */
  revokeAtProvider?: () => Promise<void>;
};

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function storedCredential(
  deps: DisconnectDeps,
  connection: Pick<ConnectionMetadata, "id" | "workspaceId" | "subjectId" | "providerDomain">,
): Promise<Record<string, unknown> | undefined> {
  const stored = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    providerDomain: connection.providerDomain,
    kind: "oauth2",
    ...(connection.subjectId ? { subjectId: connection.subjectId, allowSubjectOwned: true } : {}),
  });
  return stored?.credential;
}

type RevokeDecision = "revoked" | "kept_shared" | "kept_check_unavailable" | "kept_check_failed";

/**
 * Whether the grant may be ended at the provider: only when the
 * deployment-wide check (every workspace and organization, migration 1611)
 * answers that no other live connection may hold it. A check that is not yet
 * granted or fails keeps the grant: ending it could cut off a connection
 * elsewhere, while keeping it only leaves an unused grant at the provider.
 */
async function revokeDecision(
  deps: DisconnectDeps,
  connectionId: string,
  clientId: string | undefined,
  family: OAuthGrantFamily,
): Promise<RevokeDecision> {
  try {
    const shared = await oauthGrantSharedWithLiveConnection(deps.db, {
      connectionId,
      clientId,
      family,
    });
    if (shared === null) return "kept_check_unavailable";
    return shared ? "kept_shared" : "revoked";
  } catch {
    return "kept_check_failed";
  }
}

async function revokeToken(
  deps: DisconnectDeps,
  revoker: OAuthGrantRevoker,
  connectionId: string,
  token: string,
): Promise<void> {
  try {
    const response = await revoker.fetchImpl(deps)(revoker.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // In the body, so the token never appears in a URL or access log.
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(OAUTH_REVOKE_TIMEOUT_MS),
    });
    // 400 invalid_token: the grant was already revoked (for example from the
    // person's account page at the provider), which is the intended end state.
    if (!response.ok && response.status !== 400) {
      deps.observability?.warn("OAuth grant revocation failed", {
        connectionId,
        provider: revoker.family.id,
        status: response.status,
      });
    }
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    deps.observability?.warn("OAuth grant revocation failed", {
      connectionId,
      provider: revoker.family.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Disconnecting an OAuth connection of a provider that revokes on disconnect
 * (Google: Gmail, Drive, Calendar or a Google Integration) removes the tokens
 * Opengeni stored and, when this is the grant's last live connection
 * anywhere in the deployment, ends the grant at the provider.
 *
 * The revoked row keeps an encrypted credential without tokens, so Opengeni
 * can never use them again. The provider revoke is best effort: an
 * unreachable provider never blocks the disconnect.
 *
 * Returns undefined when the connection is not such a connection (its revoke
 * stays status-only).
 */
export async function prepareOAuthGrantDisconnect(
  deps: DisconnectDeps,
  connection: DisconnectingConnection,
): Promise<OAuthGrantDisconnect | undefined> {
  if (connection.kind !== "oauth2" || connection.status === "revoked") return undefined;
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) return undefined;
  let credential: Record<string, unknown> | undefined;
  try {
    credential = await storedCredential(deps, connection);
  } catch (error) {
    deps.observability?.warn("OAuth disconnect could not read the stored credential", {
      connectionId: connection.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
  if (!credential) return undefined;
  const family = oauthGrantFamilyForTokenEndpoint(
    credential.token_endpoint,
    OAUTH_GRANT_REVOKERS.map((revoker) => revoker.family),
  );
  const revoker = OAUTH_GRANT_REVOKERS.find((candidate) => candidate.family === family);
  if (!revoker) return undefined;
  const tokenEndpoint = textValue(credential.token_endpoint);
  const clientId = textValue(credential.client_id);
  const replacementCredentialEncrypted = encryptEnvironmentValue(
    key,
    JSON.stringify({
      revoked_at: new Date().toISOString(),
      ...(tokenEndpoint ? { token_endpoint: tokenEndpoint } : {}),
      ...(clientId ? { client_id: clientId } : {}),
    }),
  );
  // Revoking the refresh token ends the whole grant, access tokens included.
  const token = textValue(credential.refresh_token) ?? textValue(credential.access_token);
  if (!token) return { replacementCredentialEncrypted };
  return {
    replacementCredentialEncrypted,
    revokeAtProvider: async () => {
      // Decided after this connection's revoke committed, so the check sees
      // the deployment as it is once this connection is gone.
      const decision = await revokeDecision(deps, connection.id, clientId, revoker.family);
      const fields = { connectionId: connection.id, provider: revoker.family.id, decision };
      // A failed check (for example a family the database doesn't pin) is
      // safe, since the grant is kept, but must be visible.
      if (decision === "kept_check_failed") {
        deps.observability?.warn("OAuth grant revocation decision", fields);
      } else {
        deps.observability?.info("OAuth grant revocation decision", fields);
      }
      if (decision === "revoked") await revokeToken(deps, revoker, connection.id, token);
    },
  };
}
