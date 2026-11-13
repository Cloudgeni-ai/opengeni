import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import type { ConnectionMetadata } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { encryptEnvironmentValue, loadConnectionCredentialForBroker } from "@opengeni/db";

/** Google's OAuth 2.0 token revocation endpoint. */
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_TOKEN_ENDPOINT_ORIGINS: ReadonlySet<string> = new Set([
  "https://oauth2.googleapis.com",
  "https://accounts.google.com",
  "https://www.googleapis.com",
]);
const GOOGLE_REVOKE_TIMEOUT_MS = 5_000;

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isGoogleTokenEndpoint(value: unknown): boolean {
  const text = textValue(value);
  if (!text) return false;
  try {
    return GOOGLE_TOKEN_ENDPOINT_ORIGINS.has(new URL(text).origin);
  } catch {
    return false;
  }
}

/**
 * Disconnecting a Google OAuth connection (Gmail, Drive, Calendar or a Google
 * Integration) ends the grant at Google and removes the tokens Opengeni stored.
 *
 * Google user data access must end when the person disconnects: the refresh
 * token is revoked at Google (which ends every token of that grant), and the
 * revoked row keeps an encrypted credential without tokens. Revocation at
 * Google is best effort: when Google is unreachable the stored tokens are
 * still destroyed, so Opengeni can never use them again.
 *
 * Returns the replacement credential for the revoke write, or undefined when
 * the connection is not a Google OAuth connection (its revoke stays
 * status-only).
 */
export async function revokeGoogleOAuthGrantForDisconnect(
  deps: Pick<ApiRouteDeps, "db" | "settings" | "observability" | "googleDriveFetch">,
  connection: Pick<
    ConnectionMetadata,
    "id" | "workspaceId" | "subjectId" | "kind" | "providerDomain" | "status"
  >,
): Promise<string | undefined> {
  if (connection.kind !== "oauth2" || connection.status === "revoked") return undefined;
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) return undefined;
  let credential: Record<string, unknown> | undefined;
  try {
    const stored = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      providerDomain: connection.providerDomain,
      kind: "oauth2",
      ...(connection.subjectId
        ? { subjectId: connection.subjectId, allowSubjectOwned: true }
        : {}),
    });
    credential = stored?.credential;
  } catch (error) {
    deps.observability?.warn("Google OAuth disconnect could not read the stored credential", {
      connectionId: connection.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
  if (!credential || !isGoogleTokenEndpoint(credential.token_endpoint)) return undefined;
  // Revoking the refresh token ends the whole grant, access tokens included.
  const token = textValue(credential.refresh_token) ?? textValue(credential.access_token);
  if (token) {
    const fetchImpl = deps.googleDriveFetch ?? fetch;
    try {
      const response = await fetchImpl(GOOGLE_OAUTH_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // In the body, so the token never appears in a URL or access log.
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(GOOGLE_REVOKE_TIMEOUT_MS),
      });
      // 400 invalid_token: the grant was already revoked (for example from the
      // person's Google Account page), which is the intended end state.
      if (!response.ok && response.status !== 400) {
        deps.observability?.warn("Google OAuth token revocation failed", {
          connectionId: connection.id,
          status: response.status,
        });
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      deps.observability?.warn("Google OAuth token revocation failed", {
        connectionId: connection.id,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      revoked_at: new Date().toISOString(),
      ...(textValue(credential.token_endpoint) ? { token_endpoint: credential.token_endpoint } : {}),
      ...(textValue(credential.client_id) ? { client_id: credential.client_id } : {}),
    }),
  );
}
