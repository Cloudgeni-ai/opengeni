import { createHash, randomBytes, randomUUID } from "node:crypto";
import { personalGitHubOAuthCallbackUrl, type Settings } from "@opengeni/config";
import {
  PERSONAL_GITHUB_AUTHORIZATION_URL,
  PERSONAL_GITHUB_CREDENTIAL_ROLE,
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  PERSONAL_GITHUB_PROVIDER_FAMILY,
  PERSONAL_GITHUB_REQUESTED_SCOPES,
  PERSONAL_GITHUB_TOKEN_URL,
  PERSONAL_GITHUB_USER_URL,
  PersonalGitHubConnectionMetadata,
  type PersonalGitHubDisconnectRequest,
  PersonalGitHubOAuthStartResponse,
  isPersonalGitHubConnection,
} from "@opengeni/contracts/personal-github";
import {
  hasPermission,
  requireEnvironmentEncryption,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  consumeIntegrationOAuthStateNonce,
  ConnectionDisconnectGenerationError,
  ConnectionDisconnectIdempotencyError,
  decryptEnvironmentValue,
  disconnectConnectionIdempotently,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getWorkspaceGrant,
  listConnectionsMetadata,
  namedSubjectHasLiveWorkspaceAuthority,
  persistProviderOAuthConnection,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import {
  PERSONAL_OWNER_VERIFIED_STATE_CLAIM,
  personalOnlyConnectionPrincipalMessage,
  personalOwnerStateAccepted,
  personalOwnerVerifiedInState,
} from "../connection-ownership";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

const PERSONAL_GITHUB_OAUTH_STATE_KIND = "personal_github_oauth";
const GITHUB_RESPONSE_MAX_BYTES = 256 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API_VERSION = "2022-11-28";

type PersonalGitHubOAuthState = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  personalOwnerVerified: boolean;
  canonicalManagedHumanSession: boolean;
  returnPath: string;
  encryptedPkceVerifier: string;
  oauthEnvironment: string;
  oauthClientMarker: string;
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

type GitHubToken = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: "Bearer";
  expiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
};

type GitHubIdentity = {
  id: string;
  login: string;
};

type PersonalGitHubFailureReason =
  | "account_mismatch"
  | "client_changed"
  | "connection_conflict"
  | "disabled"
  | "identity_failed"
  | "invalid_state"
  | "missing_code"
  | "not_authorized"
  | "provider_denied"
  | "scope_not_granted"
  | "state_replayed"
  | "token_exchange_failed";

class PersonalGitHubCallbackError extends Error {
  constructor(readonly reason: PersonalGitHubFailureReason) {
    super(reason);
    this.name = "PersonalGitHubCallbackError";
  }
}

export function personalGitHubClientMarker(clientId: string): string {
  return createHash("sha256").update(clientId).digest("hex").slice(0, 32);
}

export function requirePersonalGitHubOAuthSettings(settings: Settings): {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  oauthEnvironment: string;
  oauthClientMarker: string;
} {
  if (!settings.githubPersonalOauthEnabled) {
    throw new HTTPException(404, {
      message: "personal GitHub OAuth is not enabled for this deployment",
    });
  }
  const clientId = settings.githubPersonalOauthClientId?.trim();
  const clientSecret = settings.githubPersonalOauthClientSecret?.trim();
  const callbackUrl = personalGitHubOAuthCallbackUrl(settings.publicBaseUrl);
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new HTTPException(503, { message: "personal GitHub OAuth is not configured" });
  }
  return {
    clientId,
    clientSecret,
    callbackUrl,
    oauthEnvironment: settings.environment,
    oauthClientMarker: personalGitHubClientMarker(clientId),
  };
}

export async function listPersonalGitHubConnections(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string },
) {
  const visible = await listConnectionsMetadata(deps.db, input.workspaceId, input.subjectId);
  return visible.filter(
    (connection) =>
      connection.subjectId === input.subjectId && isPersonalGitHubConnection(connection),
  );
}

export async function disconnectPersonalGitHub(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    payload: PersonalGitHubDisconnectRequest;
  },
) {
  const existing = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (
    !existing ||
    existing.subjectId !== input.subjectId ||
    !isPersonalGitHubConnection(existing)
  ) {
    throw new HTTPException(404, { message: "personal GitHub connection not found" });
  }
  const metadata = PersonalGitHubConnectionMetadata.parse(existing.metadata);
  try {
    return await disconnectConnectionIdempotently(deps.db, {
      accountId: existing.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      connectionId: existing.id,
      expectedVersion: input.payload.expectedVersion,
      idempotencyKey: input.payload.idempotencyKey,
      metadata: PersonalGitHubConnectionMetadata.parse({
        ...metadata,
        disconnectedAt: new Date().toISOString(),
      }),
      lastError: null,
      updatedBySubjectId: input.subjectId,
    });
  } catch (error) {
    if (error instanceof ConnectionDisconnectIdempotencyError) {
      throw new HTTPException(409, {
        message: "personal GitHub disconnect key was already used for another operation",
      });
    }
    if (error instanceof ConnectionDisconnectGenerationError) {
      throw new HTTPException(409, {
        message: "personal GitHub connection changed; refresh before disconnecting",
      });
    }
    throw error;
  }
}

export async function startPersonalGitHubOAuth(
  deps: ApiRouteDeps,
  input: {
    access: AccessGrantAuthorization;
    workspaceId: string;
    connectionId?: string;
    returnPath?: string;
  },
) {
  const oauth = requirePersonalGitHubOAuthSettings(deps.settings);
  const { grant } = input.access;
  const existing = input.connectionId
    ? await getConnectionMetadata(deps.db, input.workspaceId, input.connectionId, grant.subjectId)
    : null;
  if (input.connectionId && !existing) {
    throw new HTTPException(404, { message: "personal GitHub connection not found" });
  }
  if (
    existing &&
    (existing.subjectId !== grant.subjectId || !isPersonalGitHubConnection(existing))
  ) {
    throw new HTTPException(422, {
      message: "connectionId is not the caller's personal GitHub connection",
    });
  }

  const key = requireEnvironmentEncryption(deps.settings);
  const verifier = randomBytes(48).toString("base64url");
  const returnPath = personalGitHubReturnPath(input.workspaceId, input.returnPath);
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    accountId: grant.accountId,
    workspaceId: input.workspaceId,
    subjectId: grant.subjectId,
    kind: PERSONAL_GITHUB_OAUTH_STATE_KIND,
    [PERSONAL_OWNER_VERIFIED_STATE_CLAIM]: true,
    canonicalManagedHumanSession: input.access.canonicalManagedHumanSession,
    returnPath,
    encryptedPkceVerifier: encryptEnvironmentValue(key, verifier),
    oauthEnvironment: oauth.oauthEnvironment,
    oauthClientMarker: oauth.oauthClientMarker,
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const authorizationUrl = new URL(PERSONAL_GITHUB_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set("client_id", oauth.clientId);
  authorizationUrl.searchParams.set("redirect_uri", oauth.callbackUrl);
  authorizationUrl.searchParams.set("scope", PERSONAL_GITHUB_REQUESTED_SCOPES.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return PersonalGitHubOAuthStartResponse.parse({
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completePersonalGitHubOAuthCallback(
  deps: ApiRouteDeps,
  input: {
    code?: string;
    state?: string;
    error?: string;
    requestUrl: string;
  },
): Promise<{ redirectTo: string }> {
  const apiBaseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const returnBaseUrl = deps.settings.webBaseUrl?.replace(/\/+$/u, "") ?? apiBaseUrl;
  let state: PersonalGitHubOAuthState | null = null;
  try {
    state = readPersonalGitHubOAuthState(input.state, deps.settings);
    await requirePersonalGitHubCallbackGrant(deps, state);
    const consumed = await consumeIntegrationOAuthStateNonce(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      nonce: state.nonce,
      expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    });
    if (!consumed) throw new PersonalGitHubCallbackError("state_replayed");
    if (input.error) throw new PersonalGitHubCallbackError("provider_denied");
    if (!input.code) throw new PersonalGitHubCallbackError("missing_code");

    const oauth = requirePersonalGitHubOAuthSettings(deps.settings);
    if (
      oauth.oauthEnvironment !== state.oauthEnvironment ||
      oauth.oauthClientMarker !== state.oauthClientMarker
    ) {
      throw new PersonalGitHubCallbackError("client_changed");
    }
    const key = requireEnvironmentEncryption(deps.settings);
    let verifier: string;
    try {
      verifier = decryptEnvironmentValue(key, state.encryptedPkceVerifier);
    } catch {
      throw new PersonalGitHubCallbackError("invalid_state");
    }
    const fetchImpl = deps.githubPersonalFetch ?? fetch;
    const token = await exchangePersonalGitHubAuthorizationCode(
      fetchImpl,
      oauth,
      input.code,
      verifier,
    );
    assertExactPersonalGitHubScopes(token.scopes);
    const identity = await fetchPersonalGitHubIdentity(fetchImpl, token.accessToken);
    await requirePersonalGitHubCallbackGrant(deps, state);

    const requested = state.connectionId
      ? await getConnectionMetadata(deps.db, state.workspaceId, state.connectionId, state.subjectId)
      : null;
    if (
      state.connectionId &&
      (!requested ||
        requested.version !== state.connectionVersion ||
        !isPersonalGitHubConnection(requested))
    ) {
      throw new PersonalGitHubCallbackError("connection_conflict");
    }
    const requestedMetadata = requested
      ? PersonalGitHubConnectionMetadata.parse(requested.metadata)
      : null;
    if (requestedMetadata && requestedMetadata.providerPrincipalId !== identity.id) {
      throw new PersonalGitHubCallbackError("account_mismatch");
    }
    if (!requested) {
      const active = (
        await listPersonalGitHubConnections(deps, {
          workspaceId: state.workspaceId,
          subjectId: state.subjectId,
        })
      ).filter((connection) => connection.status !== "revoked");
      if (
        active.some(
          (connection) =>
            PersonalGitHubConnectionMetadata.parse(connection.metadata).providerPrincipalId !==
            identity.id,
        )
      ) {
        throw new PersonalGitHubCallbackError("account_mismatch");
      }
    }

    const now = new Date().toISOString();
    const metadata = PersonalGitHubConnectionMetadata.parse({
      ...(requested?.metadata ?? {}),
      credentialRole: PERSONAL_GITHUB_CREDENTIAL_ROLE,
      providerFamily: PERSONAL_GITHUB_PROVIDER_FAMILY,
      providerPrincipalId: identity.id,
      githubUserId: identity.id,
      githubLogin: identity.login,
      oauthEnvironment: oauth.oauthEnvironment,
      oauthClientMarker: oauth.oauthClientMarker,
      credentialBindingId: requestedMetadata?.credentialBindingId ?? randomUUID(),
      connectedAt: requestedMetadata?.connectedAt ?? now,
      lastVerifiedAt: now,
      disconnectedAt: null,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt?.toISOString() ?? null,
    });
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: token.accessToken,
        ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
        token_type: token.tokenType,
        ...(token.expiresAt ? { expires_at: token.expiresAt.toISOString() } : {}),
        ...(token.refreshTokenExpiresAt
          ? { refresh_token_expires_at: token.refreshTokenExpiresAt.toISOString() }
          : {}),
        scope: token.scopes.join(" "),
        token_endpoint: PERSONAL_GITHUB_TOKEN_URL,
        client_id: oauth.clientId,
        token_endpoint_auth_method: "client_secret_post",
        scope_parameter_supported: false,
      }),
    );
    const connection = await persistProviderOAuthConnection(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      visibleToSubjectId: state.subjectId,
      providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
      kind: "oauth2",
      status: "active",
      credentialEncrypted,
      grantedScopes: token.scopes,
      expiresAt: token.expiresAt,
      metadata,
      createdBySubjectId: state.subjectId,
      updatedBySubjectId: state.subjectId,
      credentialRole: PERSONAL_GITHUB_CREDENTIAL_ROLE,
      providerFamily: PERSONAL_GITHUB_PROVIDER_FAMILY,
      providerPrincipalId: identity.id,
      requireLiveUserAuthority: true,
      requiredLiveUserPermission: "connections:write",
      allowCanonicalPersonalWorkspaceOwner: state.canonicalManagedHumanSession,
      exclusiveProviderPrincipalPerOwner: true,
      preserveExistingMetadataKeys: ["credentialBindingId", "connectedAt"],
      ...(state.connectionId
        ? {
            requestedConnectionId: state.connectionId,
            requestedConnectionVersion: state.connectionVersion,
          }
        : {}),
    });
    if (!connection) throw new PersonalGitHubCallbackError("connection_conflict");
    return {
      redirectTo: personalGitHubCallbackReturnUrl(returnBaseUrl, state.returnPath, "success", {
        connectionId: connection.id,
      }),
    };
  } catch (error) {
    return {
      redirectTo: personalGitHubCallbackReturnUrl(
        returnBaseUrl,
        state?.returnPath ?? "/integrations",
        "error",
        { reason: personalGitHubFailureReason(error) },
      ),
    };
  }
}

export function personalGitHubReviewUrl(settings: Settings): string | null {
  const clientId = settings.githubPersonalOauthClientId?.trim();
  return clientId
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`
    : null;
}

function readPersonalGitHubOAuthState(
  raw: string | undefined,
  settings: Settings,
): PersonalGitHubOAuthState {
  if (!raw) throw new PersonalGitHubCallbackError("invalid_state");
  let secret: string;
  try {
    secret = requireIntegrationsStateSecret(settings);
  } catch {
    throw new PersonalGitHubCallbackError("disabled");
  }
  const payload = readSignedState(raw, secret) as Record<string, unknown> | null;
  if (!payload || payload.kind !== PERSONAL_GITHUB_OAUTH_STATE_KIND) {
    throw new PersonalGitHubCallbackError("invalid_state");
  }
  const iat = numberValue(payload.iat);
  const connectionId = optionalString(payload.connectionId);
  const connectionVersion = numberValue(payload.connectionVersion);
  const issuedAtMs = iat === null ? null : iat * 1000;
  const nowMs = Date.now();
  if (
    iat === null ||
    !Number.isInteger(iat) ||
    issuedAtMs === null ||
    issuedAtMs > nowMs + 60_000 ||
    nowMs >= issuedAtMs + oauthStateTtlMs ||
    (connectionVersion !== null && !Number.isInteger(connectionVersion)) ||
    Boolean(connectionId) !== Boolean(connectionVersion)
  ) {
    throw new PersonalGitHubCallbackError("invalid_state");
  }
  const workspaceId = requiredString(payload.workspaceId);
  return {
    accountId: requiredString(payload.accountId),
    workspaceId,
    subjectId: requiredString(payload.subjectId),
    personalOwnerVerified: personalOwnerVerifiedInState(payload),
    canonicalManagedHumanSession: payload.canonicalManagedHumanSession === true,
    returnPath: personalGitHubReturnPath(workspaceId, requiredString(payload.returnPath)),
    encryptedPkceVerifier: requiredString(payload.encryptedPkceVerifier),
    oauthEnvironment: requiredString(payload.oauthEnvironment),
    oauthClientMarker: requiredString(payload.oauthClientMarker),
    ...(connectionId ? { connectionId, connectionVersion: connectionVersion! } : {}),
    nonce: requiredString(payload.nonce),
    iat,
  };
}

async function requirePersonalGitHubCallbackGrant(
  deps: ApiRouteDeps,
  state: PersonalGitHubOAuthState,
): Promise<void> {
  if (
    !personalOwnerStateAccepted({
      ownership: "personal",
      subjectId: state.subjectId,
      personalOwnerVerified: state.personalOwnerVerified,
    })
  ) {
    throw new PersonalGitHubCallbackError("not_authorized");
  }
  const grant = await getWorkspaceGrant(deps.db, state.subjectId, state.workspaceId);
  if (
    grant &&
    grant.accountId === state.accountId &&
    hasPermission(grant.permissions, "connections:write")
  ) {
    return;
  }
  if (
    state.canonicalManagedHumanSession &&
    (await namedSubjectHasLiveWorkspaceAuthority(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
    }))
  ) {
    return;
  }
  throw new PersonalGitHubCallbackError("not_authorized");
}

async function exchangePersonalGitHubAuthorizationCode(
  fetchImpl: FetchLike,
  oauth: ReturnType<typeof requirePersonalGitHubOAuthSettings>,
  code: string,
  verifier: string,
): Promise<GitHubToken> {
  let response: Response;
  try {
    response = await fetchImpl(PERSONAL_GITHUB_TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "OpenGeni",
      },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: oauth.callbackUrl,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PersonalGitHubCallbackError("token_exchange_failed");
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await consumeBoundedJson(response, "GitHub OAuth error response");
    throw new PersonalGitHubCallbackError("token_exchange_failed");
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    GITHUB_RESPONSE_MAX_BYTES,
    "GitHub OAuth token response",
  ).catch(() => {
    throw new PersonalGitHubCallbackError("token_exchange_failed");
  });
  const accessToken = optionalString(payload.access_token);
  const tokenType = optionalString(payload.token_type)?.toLowerCase();
  if (!accessToken || tokenType !== "bearer") {
    throw new PersonalGitHubCallbackError("token_exchange_failed");
  }
  const expiresIn = positiveInteger(payload.expires_in);
  const refreshToken = optionalString(payload.refresh_token);
  if (expiresIn !== null && !refreshToken) {
    throw new PersonalGitHubCallbackError("token_exchange_failed");
  }
  const refreshExpiresIn = positiveInteger(payload.refresh_token_expires_in);
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
    refreshTokenExpiresAt:
      refreshExpiresIn === null ? null : new Date(Date.now() + refreshExpiresIn * 1000),
    scopes: parseGitHubScopes(optionalString(payload.scope)),
  };
}

async function fetchPersonalGitHubIdentity(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<GitHubIdentity> {
  let response: Response;
  try {
    response = await fetchImpl(PERSONAL_GITHUB_USER_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "OpenGeni",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PersonalGitHubCallbackError("identity_failed");
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await consumeBoundedJson(response, "GitHub identity error response");
    throw new PersonalGitHubCallbackError("identity_failed");
  }
  const headerScopes = response.headers.get("x-oauth-scopes");
  if (headerScopes) assertExactPersonalGitHubScopes(parseGitHubScopes(headerScopes));
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    GITHUB_RESPONSE_MAX_BYTES,
    "GitHub identity response",
  ).catch(() => {
    throw new PersonalGitHubCallbackError("identity_failed");
  });
  const id = positiveInteger(payload.id);
  const login = optionalString(payload.login);
  if (id === null || !Number.isSafeInteger(id) || !login || login.length > 100) {
    throw new PersonalGitHubCallbackError("identity_failed");
  }
  return { id: String(id), login };
}

function assertExactPersonalGitHubScopes(scopes: string[]): void {
  const exact = [...new Set(scopes)].sort();
  if (exact.length !== 1 || exact[0] !== "repo") {
    throw new PersonalGitHubCallbackError("scope_not_granted");
  }
}

function parseGitHubScopes(raw: string | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/u)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function personalGitHubReturnPath(workspaceId: string, raw?: string): string {
  const fallback = `/workspaces/${workspaceId}/capabilities`;
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://opengeni.invalid");
  } catch {
    throw new HTTPException(400, { message: "invalid personal GitHub return path" });
  }
  const workspacePrefix = `/workspaces/${workspaceId}`;
  if (
    parsed.origin !== "https://opengeni.invalid" ||
    (parsed.pathname !== workspacePrefix && !parsed.pathname.startsWith(`${workspacePrefix}/`))
  ) {
    throw new HTTPException(400, { message: "invalid personal GitHub return path" });
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function personalGitHubCallbackReturnUrl(
  baseUrl: string,
  returnPath: string,
  status: "success" | "error",
  params: Record<string, string>,
): string {
  let safePath: string;
  try {
    const match = returnPath.match(/^\/workspaces\/([^/]+)/u);
    safePath = match ? personalGitHubReturnPath(match[1]!, returnPath) : "/integrations";
  } catch {
    safePath = "/integrations";
  }
  const url = new URL(safePath, `${baseUrl.replace(/\/+$/u, "")}/`);
  url.searchParams.set("github_personal_oauth", status);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value.slice(0, 256));
  return url.toString();
}

function personalGitHubFailureReason(error: unknown): PersonalGitHubFailureReason {
  if (error instanceof PersonalGitHubCallbackError) return error.reason;
  if (error instanceof HTTPException && error.status === 404) return "disabled";
  return "connection_conflict";
}

async function consumeBoundedJson(response: Response, label: string): Promise<void> {
  await readResponseJsonBounded(response, GITHUB_RESPONSE_MAX_BYTES, label).catch(async () => {
    await response.body?.cancel().catch(() => undefined);
  });
}

function requiredString(value: unknown): string {
  const parsed = optionalString(value);
  if (!parsed) throw new PersonalGitHubCallbackError("invalid_state");
  return parsed;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export const PERSONAL_GITHUB_CONNECTION_PRINCIPAL_MESSAGE =
  personalOnlyConnectionPrincipalMessage("My GitHub account");
