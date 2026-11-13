import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import type { ConnectionMetadata } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  encryptEnvironmentValue,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
} from "@opengeni/db";
import { GOOGLE_SUBJECT_KEY } from "./oauth-profiles";

/** Google's OAuth 2.0 token revocation endpoint. */
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_TOKEN_ENDPOINT_ORIGINS: ReadonlySet<string> = new Set([
  "https://oauth2.googleapis.com",
  "https://accounts.google.com",
  "https://www.googleapis.com",
]);
const GOOGLE_REVOKE_TIMEOUT_MS = 5_000;
/** Verified metadata naming the Google account of a Gmail, Drive or Calendar
 * connector, or of a Google Integration connection. */
const GOOGLE_ACCOUNT_EMAIL_KEYS = [
  "gmailEmail",
  "googleDriveEmail",
  "googleCalendarEmail",
  "providerEmail",
] as const;

type DisconnectDeps = Pick<ApiRouteDeps, "db" | "settings" | "observability" | "googleDriveFetch">;
type DisconnectingConnection = Pick<
  ConnectionMetadata,
  "id" | "workspaceId" | "subjectId" | "kind" | "providerDomain" | "status" | "metadata"
>;

export type GoogleOAuthDisconnect = {
  /** Encrypted credential without tokens, written by the revoke itself. */
  replacementCredentialEncrypted: string;
  /**
   * Ends the grant at Google. Call it only after the revoke write committed,
   * so a disconnect that loses its version check never cuts off a connection
   * that stays active. Absent when nothing should be revoked at Google.
   */
  revokeAtGoogle?: () => Promise<void>;
};

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

function googleAccountIdentity(metadata: Record<string, unknown>): {
  subjects: Set<string>;
  emails: Set<string>;
} {
  const subjects = new Set<string>();
  const subject = textValue(metadata[GOOGLE_SUBJECT_KEY]);
  if (subject) subjects.add(subject);
  const principal = textValue(metadata.providerPrincipalId);
  // Google Integration connections record Google's `sub` as the principal.
  if (principal && metadata.providerFamily === "google") subjects.add(principal);
  const emails = new Set<string>();
  for (const key of GOOGLE_ACCOUNT_EMAIL_KEYS) {
    const email = textValue(metadata[key]);
    if (email) emails.add(email.trim().toLowerCase());
  }
  return { subjects, emails };
}

function disjoint(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return false;
  return true;
}

/** True only when verified metadata proves two connections are different
 * Google accounts; unknown identity counts as possibly the same account. */
function provablyDifferentGoogleAccounts(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const a = googleAccountIdentity(left);
  const b = googleAccountIdentity(right);
  // Google's account ID never changes or is reused, so it alone decides.
  if (a.subjects.size > 0 && b.subjects.size > 0) return disjoint(a.subjects, b.subjects);
  if (a.emails.size > 0 && b.emails.size > 0) return disjoint(a.emails, b.emails);
  return false;
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

/**
 * Google revokes a grant for the whole Google Cloud project: revoking one
 * refresh token also ends every other token the same Google account gave
 * Opengeni's Google client (Gmail, Drive and Calendar share one client).
 * Another live connection of that account must keep working, so the grant is
 * then left in place; this connection's tokens are still destroyed.
 */
async function sharesGoogleGrantWithLiveConnection(
  deps: DisconnectDeps,
  connection: DisconnectingConnection,
  clientId: string | undefined,
  viewerSubjectId: string,
): Promise<boolean> {
  const candidates = (
    await listConnectionsMetadata(deps.db, connection.workspaceId, viewerSubjectId)
  ).filter(
    (candidate) =>
      candidate.id !== connection.id &&
      candidate.kind === "oauth2" &&
      candidate.status !== "revoked" &&
      !provablyDifferentGoogleAccounts(connection.metadata, candidate.metadata),
  );
  for (const candidate of candidates) {
    let credential: Record<string, unknown> | undefined;
    try {
      credential = await storedCredential(deps, candidate);
    } catch {
      // An unreadable credential cannot be used, so it holds no grant to keep.
      continue;
    }
    if (!credential || !isGoogleTokenEndpoint(credential.token_endpoint)) continue;
    const candidateClientId = textValue(credential.client_id);
    if (!clientId || !candidateClientId || candidateClientId === clientId) return true;
  }
  return false;
}

async function revokeGoogleToken(
  deps: DisconnectDeps,
  connectionId: string,
  token: string,
): Promise<void> {
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
        connectionId,
        status: response.status,
      });
    }
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    deps.observability?.warn("Google OAuth token revocation failed", {
      connectionId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Disconnecting a Google OAuth connection (Gmail, Drive, Calendar or a Google
 * Integration) removes the tokens Opengeni stored and ends the grant at Google.
 *
 * The revoked row keeps an encrypted credential without tokens, so Opengeni
 * can never use them again. The grant is revoked at Google (best effort: an
 * unreachable Google never blocks the disconnect) unless another live
 * connection visible to the person may hold the same grant.
 *
 * Returns undefined when the connection is not a Google OAuth connection (its
 * revoke stays status-only).
 */
export async function prepareGoogleOAuthDisconnect(
  deps: DisconnectDeps,
  connection: DisconnectingConnection,
  viewerSubjectId: string,
): Promise<GoogleOAuthDisconnect | undefined> {
  if (connection.kind !== "oauth2" || connection.status === "revoked") return undefined;
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) return undefined;
  let credential: Record<string, unknown> | undefined;
  try {
    credential = await storedCredential(deps, connection);
  } catch (error) {
    deps.observability?.warn("Google OAuth disconnect could not read the stored credential", {
      connectionId: connection.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
  if (!credential || !isGoogleTokenEndpoint(credential.token_endpoint)) return undefined;
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
  let shared: boolean;
  try {
    shared = await sharesGoogleGrantWithLiveConnection(deps, connection, clientId, viewerSubjectId);
  } catch (error) {
    deps.observability?.warn("Google OAuth disconnect could not check for a shared grant", {
      connectionId: connection.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
    shared = true;
  }
  if (shared) {
    deps.observability?.info("Google OAuth grant kept for another live connection", {
      connectionId: connection.id,
    });
    return { replacementCredentialEncrypted };
  }
  return {
    replacementCredentialEncrypted,
    revokeAtGoogle: async () => await revokeGoogleToken(deps, connection.id, token),
  };
}
