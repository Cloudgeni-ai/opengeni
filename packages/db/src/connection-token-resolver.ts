import { environmentsEncryptionKeyBytes, type McpServerConnectionRef, type Settings } from "@opengeni/config";
import { encryptEnvironmentValue } from "./environment-crypto";
import {
  loadConnectionCredentialForBroker,
  recordConnectionTokenRefresh,
  recordConnectionUsed,
  setConnectionStatus,
  type ConnectionCredentialForBroker,
  type Database,
} from "./index";

export type ResolveConnectionCredentialResult =
  | { status: "ok"; headers: Record<string, string>; connectionId: string; expiresAt?: Date | null }
  | {
    status: "auth_needed";
    reason: "missing_connection" | "expired" | "insufficient_scope" | "refresh_failed";
    providerDomain: string;
    connectionId?: string;
    scopes?: string[];
    resource?: string;
    authorizationUrl?: string;
  };
type AuthNeededReason = Extract<ResolveConnectionCredentialResult, { status: "auth_needed" }>["reason"];

export type ResolveConnectionCredentialInput = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  toolId?: string;
  connectionRef: McpServerConnectionRef;
  forceRefresh?: boolean;
};

export type ConnectionBrokerDeps = {
  loadCredential: typeof loadConnectionCredentialForBroker;
  recordRefresh: typeof recordConnectionTokenRefresh;
  setStatus: typeof setConnectionStatus;
  recordUsed: typeof recordConnectionUsed;
  refresh: typeof refreshOAuthConnectionCredential;
  encrypt: typeof encryptEnvironmentValue;
  keyBytes: typeof environmentsEncryptionKeyBytes;
  now: () => Date;
};

const defaultDeps: ConnectionBrokerDeps = {
  loadCredential: loadConnectionCredentialForBroker,
  recordRefresh: recordConnectionTokenRefresh,
  setStatus: setConnectionStatus,
  recordUsed: recordConnectionUsed,
  refresh: refreshOAuthConnectionCredential,
  encrypt: encryptEnvironmentValue,
  keyBytes: environmentsEncryptionKeyBytes,
  now: () => new Date(),
};

const inflight = new Map<string, Promise<ConnectionCredentialForBroker>>();
const REFRESH_WINDOW_MS = 60_000;

export function buildConnectionTokenResolver(
  db: Database,
  settings: Settings,
  deps: ConnectionBrokerDeps = defaultDeps,
): (input: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult> {
  const load = async (input: ResolveConnectionCredentialInput): Promise<ConnectionCredentialForBroker | null> => {
    const request: Parameters<typeof loadConnectionCredentialForBroker>[2] = {
      workspaceId: input.workspaceId,
      providerDomain: input.connectionRef.providerDomain,
      // I1 deliberately accepts workspace-shared connections only at runtime.
      allowSubjectOwned: false,
    };
    if (input.connectionRef.connectionId !== undefined) {
      request.connectionId = input.connectionRef.connectionId;
    }
    if (input.connectionRef.kind !== undefined) {
      request.kind = input.connectionRef.kind;
    }
    if (input.subjectId !== undefined) {
      request.subjectId = input.subjectId;
    }
    return deps.loadCredential(db, settings, request);
  };

  const snapshot = async (cred: ConnectionCredentialForBroker, ref: McpServerConnectionRef): Promise<ResolveConnectionCredentialResult> => {
    if (cred.status !== "active") {
      return authNeededForStatus(cred, ref);
    }
    const missingScopes = missingRequestedScopes(ref.scopes, cred.grantedScopes);
    if (missingScopes.length > 0) {
      return {
        status: "auth_needed",
        reason: "insufficient_scope",
        providerDomain: ref.providerDomain,
        connectionId: cred.id,
        scopes: missingScopes,
        ...(ref.resource ? { resource: ref.resource } : {}),
      };
    }
    const headers = headersForCredential(cred);
    if (!headers) {
      return {
        status: "auth_needed",
        reason: "refresh_failed",
        providerDomain: ref.providerDomain,
        connectionId: cred.id,
        ...(ref.scopes ? { scopes: ref.scopes } : {}),
        ...(ref.resource ? { resource: ref.resource } : {}),
      };
    }
    await deps.recordUsed(db, cred.workspaceId, cred.id);
    return {
      status: "ok",
      headers,
      connectionId: cred.id,
      expiresAt: cred.expiresAt,
    };
  };

  const performRefresh = async (cred: ConnectionCredentialForBroker, ref: McpServerConnectionRef): Promise<ConnectionCredentialForBroker> => {
    const key = deps.keyBytes(settings);
    if (!key) {
      throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
    }
    const refreshed = await deps.refresh(cred, ref);
    const refreshRecord: Parameters<typeof recordConnectionTokenRefresh>[1] = {
      id: cred.id,
      version: cred.version,
      workspaceId: cred.workspaceId,
      credentialEncrypted: deps.encrypt(key, JSON.stringify(refreshed.credential)),
      expiresAt: refreshed.expiresAt,
      lastRefreshAt: deps.now(),
    };
    if (refreshed.grantedScopes !== undefined) {
      refreshRecord.grantedScopes = refreshed.grantedScopes;
    }
    const persisted = await deps.recordRefresh(db, refreshRecord);
    if (persisted) {
      const current = await load({
        workspaceId: cred.workspaceId,
        serverId: "",
        connectionRef: { ...ref, connectionId: cred.id },
      });
      if (current) {
        return current;
      }
    }
    const winner = await load({
      workspaceId: cred.workspaceId,
      serverId: "",
      connectionRef: { ...ref, connectionId: cred.id },
    });
    if (winner?.status === "active") {
      return winner;
    }
    throw new Error("connection credential changed during token refresh");
  };

  const refreshSingleFlight = (cred: ConnectionCredentialForBroker, ref: McpServerConnectionRef): Promise<ConnectionCredentialForBroker> => {
    const key = `${cred.id}:${cred.version}`;
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = performRefresh(cred, ref).finally(() => {
      if (inflight.get(key) === promise) {
        inflight.delete(key);
      }
    });
    inflight.set(key, promise);
    return promise;
  };

  return async (input) => {
    const ref = input.connectionRef;
    let cred: ConnectionCredentialForBroker | null;
    try {
      cred = await load(input);
    } catch {
      return authNeeded(ref, "refresh_failed");
    }
    if (!cred) {
      return authNeeded(ref, "missing_connection");
    }
    if (cred.status !== "active") {
      return authNeededForStatus(cred, ref);
    }
    if (shouldRefresh(cred, input.forceRefresh === true, deps.now())) {
      try {
        cred = await refreshSingleFlight(cred, ref);
      } catch (error) {
        // Only a rejected grant may poison the connection; transient failures
        // (network errors, AS 5xx) leave it active so the next resolve retries.
        if (isPermanentRefreshError(error)) {
          await deps.setStatus(db, input.workspaceId, "needs_reauth", error instanceof Error ? error.message : String(error), {
            id: cred.id,
            version: cred.version,
          }).catch(() => undefined);
        }
        return authNeeded(ref, "refresh_failed", cred.id);
      }
    }
    return await snapshot(cred, ref);
  };
}

export class ConnectionRefreshHttpError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number) {
    super(`connection refresh failed with HTTP ${httpStatus}`);
    this.name = "ConnectionRefreshHttpError";
    this.httpStatus = httpStatus;
  }
}

// The token endpoint rejecting the grant itself means re-auth is the only way
// forward. 429 (throttling) and 408 are transient despite being 4xx; network
// failures and AS 5xx are likewise retryable.
function isPermanentRefreshError(error: unknown): boolean {
  return error instanceof ConnectionRefreshHttpError
    && error.httpStatus >= 400 && error.httpStatus < 500
    && error.httpStatus !== 408 && error.httpStatus !== 429;
}

function shouldRefresh(cred: ConnectionCredentialForBroker, force: boolean, now: Date): boolean {
  if (cred.kind !== "oauth2") {
    return false;
  }
  if (force) {
    return true;
  }
  if (!cred.expiresAt) {
    return false;
  }
  return cred.expiresAt.getTime() <= now.getTime() + REFRESH_WINDOW_MS;
}

function authNeeded(ref: McpServerConnectionRef, reason: AuthNeededReason, connectionId?: string): ResolveConnectionCredentialResult {
  return {
    status: "auth_needed",
    reason,
    providerDomain: ref.providerDomain,
    ...(connectionId ? { connectionId } : {}),
    ...(ref.scopes ? { scopes: ref.scopes } : {}),
    ...(ref.resource ? { resource: ref.resource } : {}),
  };
}

function authNeededForStatus(cred: ConnectionCredentialForBroker, ref: McpServerConnectionRef): ResolveConnectionCredentialResult {
  if (cred.status === "revoked") {
    return authNeeded(ref, "missing_connection", cred.id);
  }
  return authNeeded(ref, cred.expiresAt && cred.expiresAt.getTime() <= Date.now() ? "expired" : "refresh_failed", cred.id);
}

function missingRequestedScopes(requested: string[] | undefined, granted: string[]): string[] {
  if (!requested?.length) {
    return [];
  }
  const grantedSet = new Set(granted);
  return requested.filter((scope) => !grantedSet.has(scope));
}

function headersForCredential(cred: ConnectionCredentialForBroker): Record<string, string> | null {
  if (cred.kind === "api_key") {
    return stringRecord((cred.credential as { headers?: unknown }).headers);
  }
  if (cred.kind === "oauth2") {
    const accessToken = stringValue((cred.credential as { access_token?: unknown }).access_token);
    if (!accessToken) {
      return null;
    }
    const tokenType = stringValue((cred.credential as { token_type?: unknown }).token_type) || "Bearer";
    return { authorization: `${tokenType} ${accessToken}` };
  }
  return stringRecord((cred.credential as { headers?: unknown }).headers);
}

export async function refreshOAuthConnectionCredential(
  cred: ConnectionCredentialForBroker,
  ref: McpServerConnectionRef,
): Promise<{ credential: Record<string, unknown>; expiresAt: Date | null; grantedScopes?: string[] }> {
  if (cred.kind !== "oauth2") {
    return { credential: cred.credential, expiresAt: cred.expiresAt, grantedScopes: cred.grantedScopes };
  }
  const refreshToken = stringValue((cred.credential as { refresh_token?: unknown }).refresh_token);
  const tokenEndpoint =
    stringValue((cred.credential as { token_endpoint?: unknown }).token_endpoint)
    ?? stringValue((cred.metadata as { tokenEndpoint?: unknown }).tokenEndpoint)
    ?? stringValue((cred.metadata as { token_endpoint?: unknown }).token_endpoint);
  if (!refreshToken || !tokenEndpoint) {
    throw new Error("connection has no refresh token endpoint");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  // Public clients (token_endpoint_auth_method "none") must identify themselves
  // in the token request body (RFC 6749 §3.2.1); grant flows persist the
  // client_id they authorized with into the bundle/metadata.
  const clientId =
    stringValue((cred.credential as { client_id?: unknown }).client_id)
    ?? stringValue((cred.metadata as { clientId?: unknown }).clientId)
    ?? stringValue((cred.metadata as { client_id?: unknown }).client_id);
  if (clientId) {
    body.set("client_id", clientId);
  }
  const resource = ref.resource ?? stringValue((cred.credential as { resource?: unknown }).resource);
  if (resource) {
    body.set("resource", resource);
  }
  if (ref.scopes?.length) {
    body.set("scope", ref.scopes.join(" "));
  }
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new ConnectionRefreshHttpError(response.status);
  }
  const payload = await response.json() as Record<string, unknown>;
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) {
    throw new Error("connection refresh response did not include access_token");
  }
  const expiresAt = expiresAtFromTokenResponse(payload, cred.expiresAt);
  const scopeText = stringValue(payload.scope);
  const nextCredential = {
    ...cred.credential,
    access_token: accessToken,
    refresh_token: stringValue(payload.refresh_token) ?? refreshToken,
    token_type: stringValue(payload.token_type) ?? stringValue((cred.credential as { token_type?: unknown }).token_type) ?? "Bearer",
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
    ...(resource ? { resource } : {}),
    ...(scopeText ? { scope: scopeText } : {}),
  };
  return {
    credential: nextCredential,
    expiresAt,
    ...(scopeText ? { grantedScopes: scopeText.split(/\s+/).filter(Boolean) } : {}),
  };
}

function expiresAtFromTokenResponse(payload: Record<string, unknown>, fallback: Date | null): Date | null {
  const expiresAt = stringValue(payload.expires_at);
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  if (expiresIn && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }
  return fallback;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      return null;
    }
    out[key] = raw;
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
