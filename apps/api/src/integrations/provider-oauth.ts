import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import {
  integrationDefinitionProviderDomain,
  integrationDefinitionById,
  type IntegrationDefinition,
} from "@opengeni/capabilities";
import {
  parseIntegrationsOauthClientsJson,
  type IntegrationOAuthClientConfig,
  type Settings,
} from "@opengeni/config";
import {
  API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
  ApiIntegrationOAuthConnectionMetadata,
  OAuthStartResponse,
  type ApiIntegrationOAuthStartRequest,
  type ConnectionOwnership,
} from "@opengeni/contracts";
import { hasPermission, requireEnvironmentEncryption, type ApiRouteDeps } from "@opengeni/core";
import {
  consumeIntegrationOAuthStateNonce,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getWorkspaceGrant,
  loadConnectionCredentialForBroker,
  persistProviderOAuthConnection,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  OAUTH_MAX_RESPONSE_BYTES,
  pinnedFetch,
  readResponseJsonBounded,
  type FetchLike,
} from "@opengeni/network";
import { HTTPException } from "hono/http-exception";

import {
  assertConnectionOwnershipAllowedForPrincipal,
  personalOwnerStateAccepted,
  personalOwnerVerifiedInState,
  PERSONAL_OWNER_VERIFIED_STATE_CLAIM,
} from "../connection-ownership";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";
import {
  assertOwnershipAllowed,
  builtInOAuthProfileFor,
  DEFAULT_OAUTH_PROFILE,
  type OAuthProviderProfile,
} from "./oauth-profiles";

const PROVIDER_OAUTH_CALLBACK_PATH = "/v1/integrations/provider-oauth/callback";
const PROVIDER_OAUTH_TIMEOUT_MS = 15_000;
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MICROSOFT_USERINFO_URL =
  "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName,mail";

type ProviderOAuthClient = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
};

type ProviderOAuthState = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  ownership: ConnectionOwnership;
  personalOwnerVerified: boolean;
  definitionId: string;
  definitionFingerprint: string;
  providerDomain: string;
  authorizeScopes: string[];
  encryptedPkceVerifier: string;
  clientId: string;
  tokenEndpointAuthMethod: ProviderOAuthClient["tokenEndpointAuthMethod"];
  returnPath: string;
  connectionId?: string;
  connectionVersion?: number;
  expectedProviderPrincipalId?: string;
  nonce: string;
  iat: number;
};

type ProviderToken = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: Date | null;
  scopes: string[];
};

type ProviderIdentity = {
  principalId: string;
  email: string | null;
  displayName: string | null;
};

type ProviderOAuthFailureReason =
  | "state_invalid"
  | "state_replayed"
  | "provider_denied"
  | "missing_code"
  | "client_unavailable"
  | "token_exchange_failed"
  | "scope_not_granted"
  | "identity_verification_failed"
  | "account_mismatch"
  | "refresh_token_missing"
  | "connection_conflict"
  | "provider_unavailable"
  | "persistence_failed";

class ProviderOAuthCallbackError extends Error {
  constructor(readonly reason: ProviderOAuthFailureReason) {
    super(reason);
    this.name = "ProviderOAuthCallbackError";
  }
}

export async function startApiIntegrationProviderOAuth(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    /**
     * False for every principal that cannot own a personal Connection (API
     * keys, the configured key, services, agent attempts). Resolved by the
     * route from the live authenticated principal, never inferred here.
     */
    personalOwnershipAllowed: boolean;
    requestUrl: string;
    payload: ApiIntegrationOAuthStartRequest;
  },
): Promise<OAuthStartResponse> {
  const definition = requiredDefinition(input.payload.definitionId);
  const providerDomain = integrationDefinitionProviderDomain(definition);
  const existing = input.payload.connectionId
    ? await getConnectionMetadata(
        deps.db,
        input.workspaceId,
        input.payload.connectionId,
        input.subjectId,
      )
    : null;
  if (input.payload.connectionId && !existing) {
    throw new HTTPException(404, { message: "Connection not found" });
  }
  const existingMetadata = existing
    ? requireProviderOAuthConnection(existing, {
        subjectId: input.subjectId,
        providerDomain,
        providerFamily: definition.provider.id,
      })
    : null;
  const existingOwnership: ConnectionOwnership | null = existing
    ? existing.subjectId === null
      ? "workspace"
      : "personal"
    : null;
  if (
    input.payload.ownership &&
    existingOwnership &&
    input.payload.ownership !== existingOwnership
  ) {
    throw new HTTPException(422, {
      message: "The selected Connection ownership does not match this OAuth request",
    });
  }
  // This flow used to resolve an omitted ownership to `personal`, inverting the
  // documented workspace-owned default. Resolving it to `workspace` instead
  // would have been the opposite defect: an executed probe on
  // `microsoft-outlook-mail` confirmed it flips a newly connected mailbox from
  // subject-scoped to workspace-shared for API/SDK callers, which is a real
  // narrow -> broad widening. So an ambiguous omission is refused outright and
  // the caller must choose. A profile that allows exactly one ownership is not
  // ambiguous (Gmail and hosted Slack MCP are personal-only), and a reconnect
  // takes the existing row's ownership.
  const profile = providerOAuthProfile(definition, providerDomain);
  const ownership =
    existingOwnership ?? input.payload.ownership ?? soleAllowedOwnership(profile) ?? null;
  if (ownership === null) {
    throw new HTTPException(422, {
      message:
        'ownership is required: choose "workspace" to share this Connection with the workspace, ' +
        'or "personal" to connect only for yourself',
    });
  }
  assertOwnershipAllowed(profile, ownership);
  assertConnectionOwnershipAllowedForPrincipal(ownership, input.personalOwnershipAllowed);
  const authorizeScopes = uniqueStrings([
    ...(existing?.grantedScopes ?? []),
    ...definition.authentication.scopes,
  ]);
  const client = providerClientForDefinition(deps.settings, definition);
  const verifier = randomBytes(48).toString("base64url");
  const key = requireEnvironmentEncryption(deps.settings);
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const redirectUri = `${baseUrl}${providerOAuthCallbackPath(definition)}`;
  const returnPath = safeReturnPath(
    input.payload.returnPath ?? `/workspaces/${input.workspaceId}/capabilities`,
  );
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    ownership,
    // Signed record that a live principal was checked; the callback has no
    // principal of its own and enforces exactly this decision.
    [PERSONAL_OWNER_VERIFIED_STATE_CLAIM]: input.personalOwnershipAllowed,
    definitionId: definition.id,
    definitionFingerprint: providerDefinitionFingerprint(definition),
    providerDomain,
    authorizeScopes,
    encryptedPkceVerifier: encryptEnvironmentValue(key, verifier),
    clientId: client.clientId,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    returnPath,
    ...(existing
      ? {
          connectionId: existing.id,
          connectionVersion: existing.version,
          expectedProviderPrincipalId: existingMetadata!.providerPrincipalId,
        }
      : {}),
  });
  const authorizationUrl = new URL(definition.authentication.authorizationUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", authorizeScopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorizationUrl.searchParams.set("prompt", "select_account");
  if (definition.provider.id === "google") {
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("include_granted_scopes", "true");
    authorizationUrl.searchParams.set("prompt", "consent select_account");
  }
  return OAuthStartResponse.parse({
    state,
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completeApiIntegrationProviderOAuth(
  deps: ApiRouteDeps,
  input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    requestUrl: string;
  },
): Promise<{ redirectTo: string }> {
  const apiBaseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const returnBaseUrl = deps.settings.webBaseUrl?.replace(/\/+$/, "") ?? apiBaseUrl;
  let state: ProviderOAuthState | null = null;
  try {
    state = readProviderOAuthState(input.state, deps.settings);
    requireProviderOAuthOwner(state);
    await requireProviderOAuthGrant(deps, state);
    const consumed = await consumeIntegrationOAuthStateNonce(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      nonce: state.nonce,
      expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    });
    if (!consumed) throw new ProviderOAuthCallbackError("state_replayed");
    if (input.error) throw new ProviderOAuthCallbackError("provider_denied");
    if (!input.code) throw new ProviderOAuthCallbackError("missing_code");

    const definition = integrationDefinitionById(state.definitionId);
    if (!definition) throw new ProviderOAuthCallbackError("state_invalid");
    if (
      state.definitionFingerprint !== providerDefinitionFingerprint(definition) ||
      state.providerDomain !== integrationDefinitionProviderDomain(definition) ||
      definition.authentication.scopes.some((scope) => !state!.authorizeScopes.includes(scope))
    ) {
      throw new ProviderOAuthCallbackError("state_invalid");
    }
    const client = providerClientForDefinition(deps.settings, definition);
    if (
      client.clientId !== state.clientId ||
      client.tokenEndpointAuthMethod !== state.tokenEndpointAuthMethod
    ) {
      throw new ProviderOAuthCallbackError("client_unavailable");
    }
    const key = requireEnvironmentEncryption(deps.settings);
    const verifier = decryptEnvironmentValue(key, state.encryptedPkceVerifier);
    const redirectUri = `${apiBaseUrl}${providerOAuthCallbackPath(definition)}`;
    const token = await exchangeProviderAuthorizationCode(deps, definition, client, {
      code: input.code,
      verifier,
      redirectUri,
    });
    if (!providerScopesInclude(definition, token.scopes, state.authorizeScopes)) {
      throw new ProviderOAuthCallbackError("scope_not_granted");
    }
    const grantedScopes = token.scopes.length > 0 ? token.scopes : state.authorizeScopes;
    const identity = await verifyProviderIdentity(deps, definition, token);
    if (
      state.expectedProviderPrincipalId &&
      state.expectedProviderPrincipalId !== identity.principalId
    ) {
      throw new ProviderOAuthCallbackError("account_mismatch");
    }
    await requireProviderOAuthGrant(deps, state);

    const existing = state.connectionId
      ? await getConnectionMetadata(deps.db, state.workspaceId, state.connectionId, state.subjectId)
      : null;
    if (state.connectionId && (!existing || existing.version !== state.connectionVersion)) {
      throw new ProviderOAuthCallbackError("connection_conflict");
    }
    const existingMetadata = existing
      ? requireProviderOAuthConnection(existing, {
          subjectId: state.subjectId,
          providerDomain: state.providerDomain,
          providerFamily: definition.provider.id,
        })
      : null;
    if (existingMetadata && existingMetadata.providerPrincipalId !== identity.principalId) {
      throw new ProviderOAuthCallbackError("account_mismatch");
    }
    let refreshToken = token.refreshToken;
    if (!refreshToken && existing) {
      const previous = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
        workspaceId: state.workspaceId,
        connectionId: existing.id,
        providerDomain: state.providerDomain,
        kind: "oauth2",
        ...(existing.subjectId ? { subjectId: state.subjectId, allowSubjectOwned: true } : {}),
      });
      refreshToken = optionalString(previous?.credential.refresh_token);
    }
    if (!refreshToken) {
      throw new ProviderOAuthCallbackError("refresh_token_missing");
    }
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: token.accessToken,
        refresh_token: refreshToken,
        token_type: token.tokenType,
        ...(token.expiresAt ? { expires_at: token.expiresAt.toISOString() } : {}),
        scope: grantedScopes.join(" "),
        token_endpoint: definition.authentication.tokenUrl,
        client_id: client.clientId,
        ...(client.clientSecret
          ? {
              client_secret: client.clientSecret,
              token_endpoint_auth_method: client.tokenEndpointAuthMethod,
            }
          : { token_endpoint_auth_method: "none" }),
      }),
    );
    const ownerSubjectId = state.ownership === "personal" ? state.subjectId : null;
    const metadata = ApiIntegrationOAuthConnectionMetadata.parse({
      ...(existing?.metadata ?? {}),
      credentialRole: API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
      providerFamily: definition.provider.id,
      providerPrincipalId: identity.principalId,
      providerEmail: identity.email,
      providerDisplayName: identity.displayName,
      authorizedDefinitionIds: uniqueStrings([
        ...(existingMetadata?.authorizedDefinitionIds ?? []),
        definition.id,
      ]),
      verifiedAt: new Date().toISOString(),
    });
    const connection = await persistProviderOAuthConnection(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: ownerSubjectId,
      visibleToSubjectId: state.subjectId,
      providerDomain: state.providerDomain,
      kind: "oauth2",
      status: "active",
      credentialEncrypted,
      grantedScopes,
      expiresAt: token.expiresAt,
      metadata,
      createdBySubjectId: state.subjectId,
      updatedBySubjectId: state.subjectId,
      credentialRole: API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
      providerFamily: definition.provider.id,
      providerPrincipalId: identity.principalId,
      ...(state.connectionId
        ? {
            requestedConnectionId: state.connectionId,
            requestedConnectionVersion: state.connectionVersion,
          }
        : {}),
    });
    if (!connection) throw new ProviderOAuthCallbackError("connection_conflict");
    return {
      redirectTo: providerOAuthReturnUrl(returnBaseUrl, state.returnPath, "success", {
        definitionId: definition.id,
        connectionId: connection.id,
        providerDomain: connection.providerDomain,
        ownership: state.ownership,
      }),
    };
  } catch (error) {
    return {
      redirectTo: providerOAuthReturnUrl(
        returnBaseUrl,
        state?.returnPath ?? "/integrations",
        "error",
        {
          ...(state?.definitionId ? { definitionId: state.definitionId } : {}),
          reason: providerOAuthFailureReason(error),
        },
      ),
    };
  }
}

/**
 * The ownership fences that apply to a curated Definition, read from the same
 * profile table the MCP OAuth start uses. No curated Definition targets a
 * personal-only provider today (they are Google Workspace and Microsoft Graph
 * APIs), so this resolves to the default profile and its workspace default;
 * matching by provider domain keeps the Slack/Gmail fences in force if one ever
 * does, instead of letting this flow mint an ownership their profile forbids.
 */
/** The profile's ownership when it allows exactly one, else null (ambiguous). */
function soleAllowedOwnership(profile: OAuthProviderProfile): ConnectionOwnership | null {
  return profile.allowedOwnership.length === 1 ? profile.allowedOwnership[0]! : null;
}

function providerOAuthProfile(
  definition: IntegrationDefinition,
  providerDomain: string,
): OAuthProviderProfile {
  return (
    builtInOAuthProfileFor({ mcpUrl: definition.baseUrl, providerDomain }) ?? DEFAULT_OAUTH_PROFILE
  );
}

function requiredDefinition(id: string): IntegrationDefinition {
  const definition = integrationDefinitionById(id);
  if (!definition) throw new HTTPException(404, { message: "Unknown Integration definition" });
  return definition;
}

function providerClientForDefinition(
  settings: Settings,
  definition: IntegrationDefinition,
): ProviderOAuthClient {
  const configured = parseIntegrationsOauthClientsJson(settings.integrationsOauthClientsJson);
  const candidates = providerClientKeys(definition);
  let entry: IntegrationOAuthClientConfig | undefined;
  for (const candidate of candidates) {
    entry = configured[candidate] ?? configured[candidate.replace(/\/+$/, "")];
    if (entry) break;
  }
  if (!entry) {
    const normalized = new Set(candidates.map((value) => value.replace(/\/+$/, "")));
    entry = Object.entries(configured).find(([key]) =>
      normalized.has(key.replace(/\/+$/, "")),
    )?.[1];
  }
  if (
    !entry &&
    definition.provider.id === "google" &&
    settings.googleDriveClientId?.trim() &&
    settings.googleDriveClientSecret?.trim()
  ) {
    return {
      clientId: settings.googleDriveClientId.trim(),
      clientSecret: settings.googleDriveClientSecret.trim(),
      tokenEndpointAuthMethod: "client_secret_post",
    };
  }
  if (!entry) {
    throw new HTTPException(503, {
      message: `${definition.name} requires an operator OAuth client configuration`,
    });
  }
  return {
    clientId: entry.clientId,
    ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}),
    tokenEndpointAuthMethod: entry.tokenEndpointAuthMethod,
  };
}

export function isApiIntegrationProviderOAuthState(
  value: string | undefined,
  settings: Settings,
): boolean {
  try {
    readProviderOAuthState(value, settings);
    return true;
  } catch {
    return false;
  }
}

function providerOAuthCallbackPath(definition: IntegrationDefinition): string {
  // Google definitions share the established MCP OAuth callback. The
  // route distinguishes signed provider state from MCP state, while the
  // separate google-drive callback remains available for the legacy Drive
  // installation flow.
  return definition.provider.id === "google"
    ? "/v1/integrations/oauth/callback"
    : PROVIDER_OAUTH_CALLBACK_PATH;
}

function providerClientKeys(definition: IntegrationDefinition): string[] {
  const authorization = new URL(definition.authentication.authorizationUrl);
  const token = new URL(definition.authentication.tokenUrl);
  return uniqueStrings([
    definition.authentication.authorizationUrl,
    authorization.origin,
    definition.authentication.tokenUrl,
    token.origin,
    ...(definition.provider.id === "google"
      ? ["https://accounts.google.com"]
      : [
          "https://login.microsoftonline.com/common/v2.0",
          "https://login.microsoftonline.com/common",
          "https://login.microsoftonline.com",
        ]),
  ]);
}

function providerDefinitionFingerprint(definition: IntegrationDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: definition.id,
        provider: definition.provider,
        baseUrl: definition.baseUrl,
        authorizationUrl: definition.authentication.authorizationUrl,
        tokenUrl: definition.authentication.tokenUrl,
        scopes: [...definition.authentication.scopes],
      }),
    )
    .digest("hex");
}

function readProviderOAuthState(raw: string | undefined, settings: Settings): ProviderOAuthState {
  if (!raw) throw new ProviderOAuthCallbackError("state_invalid");
  const payload = readSignedState(raw, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload) throw new ProviderOAuthCallbackError("state_invalid");
  const iat = numberValue(payload.iat);
  const now = Math.floor(Date.now() / 1000);
  if (iat === undefined || now < iat || now - iat > oauthStateTtlMs / 1000) {
    throw new ProviderOAuthCallbackError("state_invalid");
  }
  const ownership = payload.ownership;
  const tokenEndpointAuthMethod = payload.tokenEndpointAuthMethod;
  if (
    (ownership !== "workspace" && ownership !== "personal") ||
    (tokenEndpointAuthMethod !== "none" &&
      tokenEndpointAuthMethod !== "client_secret_post" &&
      tokenEndpointAuthMethod !== "client_secret_basic")
  ) {
    throw new ProviderOAuthCallbackError("state_invalid");
  }
  const connectionId = optionalString(payload.connectionId);
  const connectionVersion = numberValue(payload.connectionVersion);
  if (Boolean(connectionId) !== Boolean(connectionVersion)) {
    throw new ProviderOAuthCallbackError("state_invalid");
  }
  const authorizeScopes = stringArray(payload.authorizeScopes);
  if (authorizeScopes.length === 0 || authorizeScopes.length > 256) {
    throw new ProviderOAuthCallbackError("state_invalid");
  }
  return {
    accountId: requiredStateString(payload.accountId),
    workspaceId: requiredStateString(payload.workspaceId),
    subjectId: requiredStateString(payload.subjectId),
    ownership,
    personalOwnerVerified: personalOwnerVerifiedInState(payload),
    definitionId: requiredStateString(payload.definitionId),
    definitionFingerprint: requiredStateString(payload.definitionFingerprint),
    providerDomain: requiredStateString(payload.providerDomain),
    authorizeScopes,
    encryptedPkceVerifier: requiredStateString(payload.encryptedPkceVerifier),
    clientId: requiredStateString(payload.clientId),
    tokenEndpointAuthMethod,
    returnPath: safeReturnPath(requiredStateString(payload.returnPath)),
    ...(connectionId ? { connectionId, connectionVersion: connectionVersion! } : {}),
    ...(optionalString(payload.expectedProviderPrincipalId)
      ? { expectedProviderPrincipalId: optionalString(payload.expectedProviderPrincipalId)! }
      : {}),
    nonce: requiredStateString(payload.nonce),
    iat,
  };
}

async function exchangeProviderAuthorizationCode(
  deps: ApiRouteDeps,
  definition: IntegrationDefinition,
  client: ProviderOAuthClient,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<ProviderToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (client.clientSecret && client.tokenEndpointAuthMethod === "client_secret_post") {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
  } else if (client.clientSecret && client.tokenEndpointAuthMethod === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
  }
  const response = await providerFetch(deps, definition.authentication.tokenUrl, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderOAuthCallbackError("token_exchange_failed");
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    `${definition.name} OAuth token response`,
  ).catch(() => {
    throw new ProviderOAuthCallbackError("token_exchange_failed");
  });
  const accessToken = optionalString(payload.access_token);
  if (!accessToken) throw new ProviderOAuthCallbackError("token_exchange_failed");
  const expiresIn = numberValue(payload.expires_in);
  return {
    accessToken,
    ...(optionalString(payload.refresh_token)
      ? { refreshToken: optionalString(payload.refresh_token)! }
      : {}),
    tokenType: optionalString(payload.token_type) ?? "Bearer",
    expiresAt: expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes: stringArrayFromText(optionalString(payload.scope)),
  };
}

async function verifyProviderIdentity(
  deps: ApiRouteDeps,
  definition: IntegrationDefinition,
  token: ProviderToken,
): Promise<ProviderIdentity> {
  const url = definition.provider.id === "google" ? GOOGLE_USERINFO_URL : MICROSOFT_USERINFO_URL;
  const response = await providerFetch(deps, url, {
    headers: {
      accept: "application/json",
      authorization: `${normalizeBearerScheme(token.tokenType)} ${token.accessToken}`,
    },
  });
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderOAuthCallbackError("identity_verification_failed");
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    `${definition.name} identity response`,
  ).catch(() => {
    throw new ProviderOAuthCallbackError("identity_verification_failed");
  });
  if (definition.provider.id === "google") {
    const principalId = optionalString(payload.sub);
    if (!principalId) throw new ProviderOAuthCallbackError("identity_verification_failed");
    return {
      principalId,
      email: optionalString(payload.email) ?? null,
      displayName: optionalString(payload.name) ?? null,
    };
  }
  const principalId = optionalString(payload.id);
  if (!principalId) throw new ProviderOAuthCallbackError("identity_verification_failed");
  return {
    principalId,
    email: optionalString(payload.mail) ?? optionalString(payload.userPrincipalName) ?? null,
    displayName: optionalString(payload.displayName) ?? null,
  };
}

async function providerFetch(
  deps: ApiRouteDeps,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await pinnedFetch(
      url,
      {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(PROVIDER_OAUTH_TIMEOUT_MS),
      },
      deps.settings,
      {
        ...(deps.apiIntegrationOAuthFetch
          ? { fetchImpl: deps.apiIntegrationOAuthFetch as FetchLike }
          : {}),
        label: "API Integration provider OAuth request",
        requireHttpsOutsideLocalTest: true,
      },
    );
  } catch (error) {
    if (error instanceof ProviderOAuthCallbackError) throw error;
    throw new ProviderOAuthCallbackError("provider_unavailable");
  }
}

async function requireProviderOAuthGrant(
  deps: ApiRouteDeps,
  state: Pick<ProviderOAuthState, "accountId" | "workspaceId" | "subjectId">,
): Promise<void> {
  const grant = await getWorkspaceGrant(deps.db, state.subjectId, state.workspaceId);
  if (
    !grant ||
    grant.accountId !== state.accountId ||
    !hasPermission(grant.permissions, "connections:write")
  ) {
    throw new ProviderOAuthCallbackError("connection_conflict");
  }
}

/**
 * A state minted before the start-side principal fence existed can still be in
 * flight for one `oauthStateTtlMs` window, and it carries no
 * `personalOwnerVerified` claim. Such a state must not land a personal
 * Connection.
 */
function requireProviderOAuthOwner(state: ProviderOAuthState): void {
  if (!personalOwnerStateAccepted(state)) {
    throw new ProviderOAuthCallbackError("connection_conflict");
  }
}

function requireProviderOAuthConnection(
  connection: NonNullable<Awaited<ReturnType<typeof getConnectionMetadata>>>,
  input: {
    subjectId: string;
    providerDomain: string;
    providerFamily: IntegrationDefinition["provider"]["id"];
  },
) {
  const metadata = ApiIntegrationOAuthConnectionMetadata.safeParse(connection.metadata);
  if (
    connection.kind !== "oauth2" ||
    connection.providerDomain !== input.providerDomain ||
    (connection.subjectId !== null && connection.subjectId !== input.subjectId) ||
    !metadata.success ||
    metadata.data.providerFamily !== input.providerFamily
  ) {
    throw new HTTPException(422, {
      message: "Connection is not compatible with this Integration definition",
    });
  }
  return metadata.data;
}

function providerScopesInclude(
  definition: IntegrationDefinition,
  returnedScopes: string[],
  fallbackScopes: string[],
): boolean {
  const effective = returnedScopes.length > 0 ? returnedScopes : fallbackScopes;
  const normalize = (value: string) => {
    if (definition.provider.id === "microsoft") return value.toLowerCase();
    if (definition.provider.id === "google") {
      if (value === "email" || value === "https://www.googleapis.com/auth/userinfo.email") {
        return "email";
      }
      if (value === "profile" || value === "https://www.googleapis.com/auth/userinfo.profile") {
        return "profile";
      }
    }
    return value;
  };
  const granted = new Set(effective.map(normalize));
  return definition.authentication.scopes.every((scope) => granted.has(normalize(scope)));
}

function providerOAuthReturnUrl(
  baseUrl: string,
  returnPath: string,
  status: "success" | "error",
  params: Record<string, string>,
): string {
  const url = new URL(safeReturnPath(returnPath), `${baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("integration_oauth", status);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value.slice(0, 512));
  return url.toString();
}

function providerOAuthFailureReason(error: unknown): ProviderOAuthFailureReason {
  if (error instanceof ProviderOAuthCallbackError) return error.reason;
  if (error instanceof HTTPException && error.status === 503) return "client_unavailable";
  if (error instanceof HTTPException) return "connection_conflict";
  return "persistence_failed";
}

function safeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new HTTPException(400, { message: "OAuth returnPath must be a relative path" });
  }
  const parsed = new URL(value, "https://opengeni.local");
  if (parsed.origin !== "https://opengeni.local" || parsed.pathname.startsWith("//")) {
    throw new HTTPException(400, { message: "OAuth returnPath must be a relative path" });
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function normalizeBearerScheme(value: string): string {
  return /^bearer$/i.test(value) ? "Bearer" : value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}

function stringArrayFromText(value: string | undefined): string[] {
  return value ? uniqueStrings(value.split(/\s+/)) : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStateString(value: unknown): string {
  const result = optionalString(value);
  if (!result) throw new ProviderOAuthCallbackError("state_invalid");
  return result;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
