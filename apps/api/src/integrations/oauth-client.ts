import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseIntegrationsOauthClientsJson, type Settings } from "@opengeni/config";
import { OAuthStartResponse, type OAuthStartRequest } from "@opengeni/contracts";
import { requireEnvironmentEncryption } from "@opengeni/core";
import type { Observability } from "@opengeni/observability";
import {
  consumeIntegrationOAuthStateNonce,
  createConnection,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectionMetadata,
  listConnectionsMetadata,
  loadIntegrationOAuthClient,
  normalizeBearerScheme,
  storeIntegrationOAuthClient,
  updateConnection,
  type Database,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  DestinationPolicyError,
  OAUTH_MAX_RESPONSE_BYTES,
  isLocalTestEnvironment,
  pinnedFetch,
  readResponseJsonBounded,
  validateHttpUrl,
} from "@opengeni/network";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { canonicalProviderDomain } from "./provider-domain";

export const oauthStateTtlMs = 10 * 60 * 1000;
export { OAUTH_MAX_RESPONSE_BYTES } from "@opengeni/network";

type OAuthClientDeps = {
  db: Database;
  settings: Settings;
  observability?: Observability | undefined;
};

export type OAuthStartContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  requestUrl: string;
  payload: OAuthStartRequest;
};

export type OAuthCallbackResult = {
  redirectTo: string;
};

type WwwAuthenticateChallenge = {
  resourceMetadata?: string;
  scope?: string[];
  error?: string;
};

type ProtectedResourceMetadata = {
  resource?: string;
  authorizationServers: string[];
  scopesSupported: string[];
  raw: Record<string, unknown>;
};

type AuthorizationServerMetadata = {
  issuer: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientIdMetadataDocumentSupported: boolean;
  tokenEndpointAuthMethodsSupported: string[];
  codeChallengeMethodsSupported: string[];
  raw: Record<string, unknown>;
};

type OAuthClientRegistration = {
  method: "operator" | "manual" | "cimd" | "dcr";
  issuer: string;
  authorizationServer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
};

type OAuthStatePayload = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  providerDomain: string;
  mcpUrl: string;
  resource: string;
  requestedScopes: string[];
  authorizeScopes: string[];
  encryptedPkceVerifier: string;
  clientId: string;
  tokenEndpoint: string;
  authorizationServer: string;
  issuer: string;
  clientRegistrationMethod: OAuthClientRegistration["method"];
  tokenEndpointAuthMethod: OAuthClientRegistration["tokenEndpointAuthMethod"];
  encryptedClientSecret?: string;
  returnPath: string;
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

type TokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: Date | null;
  scopeText?: string;
  raw: Record<string, unknown>;
};

type OAuthCallbackStage = "state_verify" | "token_exchange" | "tools_list" | "persist";

class OAuthCallbackStageError extends Error {
  constructor(
    readonly stage: OAuthCallbackStage,
    readonly reason: string,
    readonly cause: unknown,
  ) {
    super(errorMessage(cause));
    this.name = "OAuthCallbackStageError";
  }
}

export async function startMcpOAuth(
  deps: OAuthClientDeps,
  context: OAuthStartContext,
): Promise<OAuthStartResponse> {
  const { db, settings } = deps;
  const mcpUrl = canonicalMcpResource(context.payload.mcpUrl ?? context.payload.resource);
  const providerDomain = canonicalProviderDomain(
    context.payload.providerDomain ?? new URL(mcpUrl).hostname,
  );
  const returnPath = safeReturnPath(context.payload.returnPath ?? "/integrations");
  const baseUrl = integrationBaseUrl(settings.publicBaseUrl, context.requestUrl);
  const redirectUri = `${baseUrl}/v1/integrations/oauth/callback`;
  const metadataUrl = `${baseUrl}/v1/integrations/oauth/client-metadata.json`;
  const existing = await existingOAuthConnectionForStart(db, {
    workspaceId: context.workspaceId,
    subjectId: context.subjectId,
    providerDomain,
    connectionId: context.payload.connectionId,
  });
  if (context.payload.connectionId && !existing) {
    throw new HTTPException(404, { message: "connection not found" });
  }

  const discovery = await discoverMcpOAuth(mcpUrl, settings);
  const resource = discovery.prm.resource ? canonicalOAuthResource(discovery.prm.resource) : mcpUrl;
  const verifier = randomPkceVerifier();
  const authorizeScopes = chooseAuthorizeScopes(
    context.payload.requestedScopes,
    discovery.challenge.scope,
    discovery.prm.scopesSupported,
  );
  const client = await registerOAuthClient(
    db,
    settings,
    discovery.as,
    metadataUrl,
    redirectUri,
    authorizeScopes,
    context.payload.oauthClient,
  );
  const key = requireEnvironmentEncryption(settings);
  const state = createSignedState(requireIntegrationsStateSecret(settings), {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    subjectId: context.subjectId,
    providerDomain,
    mcpUrl,
    resource,
    requestedScopes: uniqueStrings(context.payload.requestedScopes ?? []),
    authorizeScopes,
    encryptedPkceVerifier: encryptEnvironmentValue(key, verifier),
    clientId: client.clientId,
    tokenEndpoint: discovery.as.tokenEndpoint,
    authorizationServer: client.authorizationServer,
    issuer: client.issuer,
    clientRegistrationMethod: client.method,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    ...(client.method === "manual" && client.clientSecret
      ? { encryptedClientSecret: encryptEnvironmentValue(key, client.clientSecret) }
      : {}),
    returnPath,
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const authorizationUrl = buildAuthorizationUrl({
    endpoint: discovery.as.authorizationEndpoint,
    settings,
    clientId: client.clientId,
    redirectUri,
    state,
    resource,
    verifier,
    scopes: authorizeScopes,
  });
  return OAuthStartResponse.parse({
    state,
    authorizationUrl,
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completeMcpOAuthCallback(
  deps: OAuthClientDeps,
  input: { code?: string | undefined; state?: string | undefined; requestUrl: string },
): Promise<OAuthCallbackResult> {
  const { db, settings, observability } = deps;
  let state: OAuthStatePayload | null = null;
  if (!input.state) {
    const error = new OAuthCallbackStageError(
      "state_verify",
      "state_invalid",
      new Error("missing OAuth state"),
    );
    logOAuthCallbackFailure(observability, error, state);
    return { redirectTo: callbackReturnPath("/integrations", "error", { reason: error.reason }) };
  }
  try {
    state = readOAuthState(input.state, settings);
    if (!input.code) {
      return {
        redirectTo: callbackReturnPath(state.returnPath, "error", { reason: "missing_code" }),
      };
    }
    const consumed = await consumeIntegrationOAuthStateNonce(db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      nonce: state.nonce,
      expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    });
    if (!consumed) {
      throw new HTTPException(400, { message: "OAuth state has already been used" });
    }
  } catch (error) {
    const staged = new OAuthCallbackStageError("state_verify", "state_invalid", error);
    logOAuthCallbackFailure(observability, staged, state);
    return {
      redirectTo: callbackReturnPath(state?.returnPath ?? "/integrations", "error", {
        reason: staged.reason,
      }),
    };
  }

  try {
    const baseUrl = integrationBaseUrl(settings.publicBaseUrl, input.requestUrl);
    const redirectUri = `${baseUrl}/v1/integrations/oauth/callback`;
    const key = requireEnvironmentEncryption(settings);
    const verifier = decryptEnvironmentValue(key, state.encryptedPkceVerifier);
    const client = await clientForState(db, settings, state);
    const token = await runCallbackStage("token_exchange", "token_exchange_failed", () =>
      exchangeAuthorizationCode(settings, {
        code: input.code!,
        verifier,
        redirectUri,
        resource: state.resource,
        tokenEndpoint: state.tokenEndpoint,
        client,
      }),
    );
    const verification = await verifyMcpToolsListNonFatal(observability, settings, state, token);
    const scopes = grantedScopes(token.scopeText, state.authorizeScopes);
    const credential = credentialBundle(token, state, client);
    const metadata = {
      resource: state.resource,
      mcpUrl: state.mcpUrl,
      authorizationServer: state.authorizationServer,
      authorizationServerIssuer: state.issuer,
      tokenEndpoint: state.tokenEndpoint,
      clientId: client.clientId,
      clientRegistrationMethod: state.clientRegistrationMethod,
      mcpToolsVerification: verification.metadata,
      ...(verification.tools ? { mcpTools: verification.tools } : {}),
    };
    const credentialEncrypted = encryptEnvironmentValue(key, JSON.stringify(credential));
    const connection = await runCallbackStage("persist", "persist_failed", () =>
      state.connectionId
        ? updateConnection(db, {
            workspaceId: state.workspaceId,
            connectionId: state.connectionId,
            visibleToSubjectId: state.subjectId,
            expectedVersion: state.connectionVersion,
            providerDomain: state.providerDomain,
            kind: "oauth2",
            status: "active",
            credentialEncrypted,
            grantedScopes: scopes,
            expiresAt: token.expiresAt,
            metadata,
            updatedBySubjectId: state.subjectId,
          })
        : createConnection(db, {
            accountId: state.accountId,
            workspaceId: state.workspaceId,
            subjectId: null,
            providerDomain: state.providerDomain,
            kind: "oauth2",
            credentialEncrypted,
            grantedScopes: scopes,
            expiresAt: token.expiresAt,
            metadata,
            createdBySubjectId: state.subjectId,
          }),
    );
    if (!connection) {
      throw new HTTPException(409, {
        message: "connection changed during OAuth reconnect; start again",
      });
    }
    // Carry the canonical providerDomain (not just the id) so the SPA can build
    // the enable connectionRef straight from the redirect, without a listConnections
    // round-trip that could fail (transient, or a grant lacking connections:read)
    // and leave the connection created but the capability un-enabled.
    return {
      redirectTo: callbackReturnPath(state.returnPath, "success", {
        connectionId: connection.id,
        providerDomain: connection.providerDomain,
        ...(verification.metadata.status === "failed" ? { verification: "failed" } : {}),
      }),
    };
  } catch (error) {
    const staged =
      error instanceof OAuthCallbackStageError
        ? error
        : new OAuthCallbackStageError("persist", "persist_failed", error);
    logOAuthCallbackFailure(observability, staged, state);
    return { redirectTo: callbackReturnPath(state.returnPath, "error", { reason: staged.reason }) };
  }
}

export function integrationBaseUrl(publicBaseUrl: string | undefined, requestUrl: string): string {
  return (publicBaseUrl ?? new URL(requestUrl).origin).replace(/\/+$/, "");
}

export function requireIntegrationsStateSecret(settings: Settings): string {
  const secret = settings.integrationsStateSecret?.trim();
  if (!secret) {
    throw new HTTPException(503, {
      message: "integrations OAuth requires OPENGENI_INTEGRATIONS_STATE_SECRET",
    });
  }
  return secret;
}

async function discoverMcpOAuth(
  resource: string,
  settings: Settings,
): Promise<{
  challenge: WwwAuthenticateChallenge;
  prm: ProtectedResourceMetadata;
  as: AuthorizationServerMetadata;
}> {
  const challenge = await probeMcpChallenge(resource, settings);
  const prm = await discoverProtectedResourceMetadata(
    resource,
    settings,
    challenge.resourceMetadata,
  );
  const authorizationServer = prm.authorizationServers[0];
  if (!authorizationServer) {
    throw new HTTPException(422, {
      message: "MCP protected resource metadata did not advertise an authorization server",
    });
  }
  const as = await discoverAuthorizationServerMetadata(authorizationServer, settings);
  if (!as.codeChallengeMethodsSupported.includes("S256")) {
    throw new HTTPException(422, {
      message: "authorization server does not support required PKCE S256",
    });
  }
  return { challenge, prm, as };
}

async function probeMcpChallenge(
  resource: string,
  settings: Settings,
): Promise<WwwAuthenticateChallenge> {
  const response = await fetchOAuth(resource, settings, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  try {
    if (response.status !== 401) {
      return {};
    }
    return parseWwwAuthenticate(response.headers.get("www-authenticate"));
  } finally {
    await cancelResponseBody(response);
  }
}

async function discoverProtectedResourceMetadata(
  resource: string,
  settings: Settings,
  advertisedUrl?: string,
): Promise<ProtectedResourceMetadata> {
  const candidates = uniqueStrings([
    ...(advertisedUrl ? [advertisedUrl] : []),
    ...wellKnownCandidates(resource, "oauth-protected-resource"),
  ]);
  for (const candidate of candidates) {
    const payload = await fetchJsonObject(candidate, settings).catch((error) => {
      if (error instanceof HTTPException) {
        throw error;
      }
      return null;
    });
    if (!payload) {
      continue;
    }
    const authorizationServers = stringArray(payload.authorization_servers);
    if (authorizationServers.length === 0) {
      continue;
    }
    return {
      authorizationServers,
      scopesSupported: stringArray(payload.scopes_supported),
      raw: payload,
      ...(stringValue(payload.resource) ? { resource: stringValue(payload.resource)! } : {}),
    };
  }
  throw new HTTPException(422, { message: "could not discover MCP protected resource metadata" });
}

async function discoverAuthorizationServerMetadata(
  authorizationServer: string,
  settings: Settings,
): Promise<AuthorizationServerMetadata> {
  const safeAuthorizationServer = oauthEndpointUrl(
    authorizationServer,
    settings,
    "OAuth authorization server",
  ).replace(/\/+$/, "");
  const candidates = uniqueStrings([
    safeAuthorizationServer,
    ...wellKnownCandidates(safeAuthorizationServer, "oauth-authorization-server"),
    ...wellKnownCandidates(safeAuthorizationServer, "openid-configuration"),
  ]);
  for (const candidate of candidates) {
    const payload = await fetchJsonObject(candidate, settings).catch((error) => {
      if (error instanceof HTTPException) {
        throw error;
      }
      return null;
    });
    if (!payload) {
      continue;
    }
    const authorizationEndpoint = stringValue(payload.authorization_endpoint);
    const tokenEndpoint = stringValue(payload.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) {
      continue;
    }
    const safeAuthorizationEndpoint = oauthEndpointUrl(
      authorizationEndpoint,
      settings,
      "OAuth authorization endpoint",
    );
    const safeTokenEndpoint = oauthEndpointUrl(tokenEndpoint, settings, "OAuth token endpoint");
    const registrationEndpoint = stringValue(payload.registration_endpoint);
    const issuer = oauthEndpointUrl(
      stringValue(payload.issuer) ?? safeAuthorizationServer,
      settings,
      "OAuth issuer",
    );
    const safeRegistrationEndpoint = registrationEndpoint
      ? oauthEndpointUrl(registrationEndpoint, settings, "OAuth registration endpoint")
      : undefined;
    return {
      issuer,
      authorizationServer: safeAuthorizationServer,
      authorizationEndpoint: safeAuthorizationEndpoint,
      tokenEndpoint: safeTokenEndpoint,
      clientIdMetadataDocumentSupported: payload.client_id_metadata_document_supported === true,
      tokenEndpointAuthMethodsSupported: stringArray(payload.token_endpoint_auth_methods_supported),
      codeChallengeMethodsSupported: stringArray(payload.code_challenge_methods_supported),
      raw: payload,
      ...(safeRegistrationEndpoint ? { registrationEndpoint: safeRegistrationEndpoint } : {}),
    };
  }
  throw new HTTPException(422, {
    message: "could not discover OAuth authorization server metadata",
  });
}

async function registerOAuthClient(
  db: Database,
  settings: Settings,
  as: AuthorizationServerMetadata,
  metadataUrl: string,
  redirectUri: string,
  scopes: string[],
  manual: OAuthStartRequest["oauthClient"],
): Promise<OAuthClientRegistration> {
  const operator = operatorClientForAs(settings, as);
  if (operator) {
    return operator;
  }
  if (as.clientIdMetadataDocumentSupported) {
    return {
      method: "cimd",
      issuer: as.issuer,
      authorizationServer: as.authorizationServer,
      clientId: metadataUrl,
      tokenEndpointAuthMethod: "none",
    };
  }
  if (manual) {
    return {
      method: "manual",
      issuer: as.issuer,
      authorizationServer: as.authorizationServer,
      clientId: manual.clientId,
      ...(manual.clientSecret ? { clientSecret: manual.clientSecret } : {}),
      tokenEndpointAuthMethod: tokenAuthMethod(
        manual.tokenEndpointAuthMethod,
        Boolean(manual.clientSecret),
      ),
    };
  }
  return await getOrCreateDynamicClientRegistration(db, settings, as, redirectUri, scopes);
}

async function getOrCreateDynamicClientRegistration(
  db: Database,
  settings: Settings,
  as: AuthorizationServerMetadata,
  redirectUri: string,
  scopes: string[],
): Promise<OAuthClientRegistration> {
  const storedClient = await loadIntegrationOAuthClient(db, settings, as.issuer);
  if (storedClient && storedDcrClientSatisfiesPolicy(storedClient, scopes)) {
    return {
      method: "dcr",
      issuer: storedClient.issuer,
      authorizationServer: storedClient.authorizationServer,
      clientId: storedClient.clientId,
      ...(storedClient.clientSecret ? { clientSecret: storedClient.clientSecret } : {}),
      tokenEndpointAuthMethod: tokenAuthMethod(
        storedClient.tokenEndpointAuthMethod,
        Boolean(storedClient.clientSecret),
      ),
    };
  }
  if (!as.registrationEndpoint) {
    throw new HTTPException(422, {
      message: "manual OAuth client credentials are required for this authorization server",
    });
  }
  const dcr = await dynamicClientRegistration(settings, as, redirectUri, scopes);
  const key = dcr.clientSecret ? requireEnvironmentEncryption(settings) : null;
  const storeInput = {
    issuer: as.issuer,
    authorizationServer: as.authorizationServer,
    clientId: dcr.clientId,
    clientSecretEncrypted:
      dcr.clientSecret && key ? encryptEnvironmentValue(key, dcr.clientSecret) : null,
    tokenEndpointAuthMethod: dcr.tokenEndpointAuthMethod,
    metadata: registrationMetadata(as, scopes),
  };
  const storedWinner = await storeIntegrationOAuthClient(db, storeInput);
  if (storedWinner.clientId !== dcr.clientId) {
    const winner = await loadIntegrationOAuthClient(db, settings, as.issuer);
    if (!winner) {
      throw new HTTPException(422, {
        message: "OAuth client registration could not be loaded after a registration race",
      });
    }
    return dcrRegistrationFromStored(winner);
  }
  return dcr;
}

function storedDcrClientSatisfiesPolicy(
  stored: { metadata: Record<string, unknown> },
  scopes: string[],
): boolean {
  return registeredScopesMatch(stored.metadata, scopes);
}

function registeredScopesMatch(metadata: Record<string, unknown>, scopes: string[]): boolean {
  return stableScopeKey(stringArray(metadata.registeredScopes)) === stableScopeKey(scopes);
}

function stableScopeKey(scopes: string[]): string {
  return uniqueStrings(scopes).sort().join(" ");
}

function registrationMetadata(
  as: AuthorizationServerMetadata,
  scopes: string[],
): Record<string, unknown> {
  return {
    registrationEndpoint: as.registrationEndpoint,
    registeredAt: new Date().toISOString(),
    registeredScopes: uniqueStrings(scopes),
  };
}

function dcrRegistrationFromStored(stored: {
  issuer: string;
  authorizationServer: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: string;
}): OAuthClientRegistration {
  return {
    method: "dcr",
    issuer: stored.issuer,
    authorizationServer: stored.authorizationServer,
    clientId: stored.clientId,
    ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
    tokenEndpointAuthMethod: tokenAuthMethod(
      stored.tokenEndpointAuthMethod,
      Boolean(stored.clientSecret),
    ),
  };
}

function operatorClientForAs(
  settings: Settings,
  as: AuthorizationServerMetadata,
): OAuthClientRegistration | null {
  const entry = operatorClientEntryFor(settings, [as.issuer, as.authorizationServer]);
  if (!entry) {
    return null;
  }
  return {
    method: "operator",
    issuer: as.issuer,
    authorizationServer: as.authorizationServer,
    clientId: entry.clientId,
    ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}),
    tokenEndpointAuthMethod: tokenAuthMethod(
      entry.tokenEndpointAuthMethod,
      Boolean(entry.clientSecret),
    ),
  };
}

function operatorClientEntryFor(
  settings: Settings,
  candidates: string[],
): ReturnType<typeof parseIntegrationsOauthClientsJson>[string] | null {
  const configured = parseIntegrationsOauthClientsJson(settings.integrationsOauthClientsJson);
  const exactKeys = uniqueStrings(
    candidates.flatMap((candidate) => [candidate, normalizedIssuerKey(candidate)]),
  );
  for (const key of exactKeys) {
    const entry = configured[key];
    if (entry) {
      return entry;
    }
  }
  const normalizedCandidates = new Set(candidates.map(normalizedIssuerKey));
  for (const [key, entry] of Object.entries(configured)) {
    if (normalizedCandidates.has(normalizedIssuerKey(key))) {
      return entry;
    }
  }
  return null;
}

function normalizedIssuerKey(value: string): string {
  return value.replace(/\/+$/, "");
}

async function dynamicClientRegistration(
  settings: Settings,
  as: AuthorizationServerMetadata,
  redirectUri: string,
  scopes: string[],
): Promise<OAuthClientRegistration> {
  if (!as.registrationEndpoint) {
    throw new HTTPException(422, {
      message: "authorization server does not support dynamic client registration",
    });
  }
  const response = await fetchOAuth(as.registrationEndpoint, settings, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "OpenGeni",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    }),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new HTTPException(422, {
      message: `dynamic client registration failed with HTTP ${response.status}`,
    });
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "OAuth dynamic registration response",
  );
  const clientId = stringValue(payload.client_id);
  if (!clientId) {
    throw new HTTPException(422, {
      message: "dynamic client registration response did not include client_id",
    });
  }
  const clientSecret = stringValue(payload.client_secret);
  return {
    method: "dcr",
    issuer: as.issuer,
    authorizationServer: as.authorizationServer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    tokenEndpointAuthMethod: tokenAuthMethod(
      stringValue(payload.token_endpoint_auth_method),
      Boolean(clientSecret),
    ),
  };
}

async function existingOAuthConnectionForStart(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    providerDomain: string;
    connectionId?: string | undefined;
  },
) {
  if (input.connectionId) {
    return await getConnectionMetadata(db, input.workspaceId, input.connectionId, input.subjectId);
  }
  const visible = await listConnectionsMetadata(db, input.workspaceId, input.subjectId);
  return (
    visible.find(
      (connection) =>
        connection.subjectId === null &&
        connection.kind === "oauth2" &&
        connection.status === "active" &&
        connection.providerDomain === input.providerDomain,
    ) ?? null
  );
}

function buildAuthorizationUrl(input: {
  endpoint: string;
  settings: Settings;
  clientId: string;
  redirectUri: string;
  state: string;
  resource: string;
  verifier: string;
  scopes: string[];
}): string {
  const endpoint = oauthEndpointUrl(input.endpoint, input.settings, "OAuth authorization endpoint");
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("resource", input.resource);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", pkceChallenge(input.verifier));
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(" "));
  }
  return url.toString();
}

function readOAuthState(state: string, settings: Settings): OAuthStatePayload {
  const payload = readSignedState(state, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload) {
    throw new HTTPException(400, { message: "invalid or expired OAuth state" });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const iat = numberValue(payload.iat);
  if (iat === undefined || nowSeconds - iat > oauthStateTtlMs / 1000 || nowSeconds < iat) {
    throw new HTTPException(400, { message: "invalid or expired OAuth state" });
  }
  const resource = requiredString(payload.resource, "state.resource");
  const parsed = {
    accountId: requiredString(payload.accountId, "state.accountId"),
    workspaceId: requiredString(payload.workspaceId, "state.workspaceId"),
    subjectId: requiredString(payload.subjectId, "state.subjectId"),
    providerDomain: requiredString(payload.providerDomain, "state.providerDomain"),
    mcpUrl: stringValue(payload.mcpUrl) ?? resource,
    resource,
    requestedScopes: stringArray(payload.requestedScopes),
    authorizeScopes: stringArray(payload.authorizeScopes),
    encryptedPkceVerifier: requiredString(
      payload.encryptedPkceVerifier,
      "state.encryptedPkceVerifier",
    ),
    clientId: requiredString(payload.clientId, "state.clientId"),
    tokenEndpoint: oauthEndpointUrl(
      requiredString(payload.tokenEndpoint, "state.tokenEndpoint"),
      settings,
      "OAuth token endpoint",
    ),
    authorizationServer: oauthEndpointUrl(
      requiredString(payload.authorizationServer, "state.authorizationServer"),
      settings,
      "OAuth authorization server",
    ).replace(/\/+$/, ""),
    issuer: oauthEndpointUrl(
      requiredString(payload.issuer, "state.issuer"),
      settings,
      "OAuth issuer",
    ),
    clientRegistrationMethod: registrationMethod(payload.clientRegistrationMethod),
    tokenEndpointAuthMethod: tokenAuthMethod(stringValue(payload.tokenEndpointAuthMethod), false),
    ...(stringValue(payload.encryptedClientSecret)
      ? { encryptedClientSecret: stringValue(payload.encryptedClientSecret)! }
      : {}),
    returnPath: safeReturnPath(stringValue(payload.returnPath) ?? "/integrations"),
    nonce: requiredString(payload.nonce, "state.nonce"),
    iat,
  };
  const connectionId = stringValue(payload.connectionId);
  const connectionVersion = numberValue(payload.connectionVersion);
  return {
    ...parsed,
    ...(connectionId ? { connectionId } : {}),
    ...(connectionVersion !== undefined ? { connectionVersion } : {}),
  };
}

async function clientForState(
  db: Database,
  settings: Settings,
  state: OAuthStatePayload,
): Promise<OAuthClientRegistration> {
  if (state.clientRegistrationMethod === "cimd") {
    return {
      method: "cimd",
      issuer: state.issuer,
      authorizationServer: state.authorizationServer,
      clientId: state.clientId,
      tokenEndpointAuthMethod: "none",
    };
  }
  if (state.clientRegistrationMethod === "manual") {
    const key = requireEnvironmentEncryption(settings);
    return {
      method: "manual",
      issuer: state.issuer,
      authorizationServer: state.authorizationServer,
      clientId: state.clientId,
      ...(state.encryptedClientSecret
        ? { clientSecret: decryptEnvironmentValue(key, state.encryptedClientSecret) }
        : {}),
      tokenEndpointAuthMethod: state.tokenEndpointAuthMethod,
    };
  }
  if (state.clientRegistrationMethod === "dcr") {
    const stored = await loadIntegrationOAuthClient(db, settings, state.issuer);
    if (
      !stored ||
      stored.clientId !== state.clientId ||
      stored.issuer !== state.issuer ||
      stored.authorizationServer !== state.authorizationServer
    ) {
      throw new HTTPException(400, { message: "OAuth client registration is no longer available" });
    }
    return {
      method: "dcr",
      issuer: stored.issuer,
      authorizationServer: stored.authorizationServer,
      clientId: stored.clientId,
      ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
      tokenEndpointAuthMethod: tokenAuthMethod(
        stored.tokenEndpointAuthMethod,
        Boolean(stored.clientSecret),
      ),
    };
  }
  const entry = operatorClientEntryFor(settings, [state.issuer, state.authorizationServer]);
  if (!entry || entry.clientId !== state.clientId) {
    throw new HTTPException(400, {
      message: "operator OAuth client credentials are no longer available",
    });
  }
  return {
    method: "operator",
    issuer: state.issuer,
    authorizationServer: state.authorizationServer,
    clientId: entry.clientId,
    ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}),
    tokenEndpointAuthMethod: tokenAuthMethod(
      entry.tokenEndpointAuthMethod,
      Boolean(entry.clientSecret),
    ),
  };
}

async function exchangeAuthorizationCode(
  settings: Settings,
  input: {
    code: string;
    verifier: string;
    redirectUri: string;
    resource: string;
    tokenEndpoint: string;
    client: OAuthClientRegistration;
  },
): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.verifier);
  body.set("resource", input.resource);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (input.client.clientSecret && input.client.tokenEndpointAuthMethod === "client_secret_post") {
    body.set("client_id", input.client.clientId);
    body.set("client_secret", input.client.clientSecret);
  } else if (
    input.client.clientSecret &&
    input.client.tokenEndpointAuthMethod === "client_secret_basic"
  ) {
    headers.authorization = `Basic ${Buffer.from(`${input.client.clientId}:${input.client.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", input.client.clientId);
  }
  const response = await fetchOAuth(input.tokenEndpoint, settings, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    const oauthError = await oauthErrorFromResponse(response);
    throw new OAuthCallbackStageError(
      "token_exchange",
      oauthError ?? "token_exchange_failed",
      new Error(`OAuth token endpoint returned HTTP ${response.status}`),
    );
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "OAuth token response",
  );
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) {
    throw new Error("OAuth token response did not include access_token");
  }
  return {
    accessToken,
    tokenType: stringValue(payload.token_type) ?? "Bearer",
    expiresAt: expiresAtFromTokenResponse(payload),
    raw: payload,
    ...(stringValue(payload.refresh_token)
      ? { refreshToken: stringValue(payload.refresh_token)! }
      : {}),
    ...(stringValue(payload.scope) ? { scopeText: stringValue(payload.scope)! } : {}),
  };
}

async function runCallbackStage<T>(
  callbackStage: OAuthCallbackStage,
  fallbackReason: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OAuthCallbackStageError) {
      throw error;
    }
    throw new OAuthCallbackStageError(callbackStage, fallbackReason, error);
  }
}

function logOAuthCallbackFailure(
  observability: Observability | undefined,
  error: OAuthCallbackStageError,
  state: OAuthStatePayload | null,
): void {
  observability?.error("MCP OAuth callback failed", {
    "opengeni.oauth.stage": error.stage,
    "opengeni.oauth.reason": error.reason,
    "opengeni.oauth.provider_domain": state?.providerDomain,
    "opengeni.oauth.resource_host": state ? safeHost(state.resource) : undefined,
    "opengeni.oauth.authorization_server": state?.authorizationServer,
    "opengeni.oauth.issuer": state?.issuer,
    "opengeni.oauth.client_registration_method": state?.clientRegistrationMethod,
    error: sanitizedError(error.cause),
  });
}

function logOAuthVerificationWarning(
  observability: Observability | undefined,
  error: OAuthCallbackStageError,
  state: OAuthStatePayload,
): void {
  observability?.warn("MCP OAuth tools/list verification failed after token exchange", {
    "opengeni.oauth.stage": error.stage,
    "opengeni.oauth.reason": error.reason,
    "opengeni.oauth.provider_domain": state.providerDomain,
    "opengeni.oauth.resource_host": safeHost(state.resource),
    "opengeni.oauth.mcp_host": safeHost(state.mcpUrl),
    "opengeni.oauth.authorization_server": state.authorizationServer,
    "opengeni.oauth.issuer": state.issuer,
    "opengeni.oauth.client_registration_method": state.clientRegistrationMethod,
    error: sanitizedError(error.cause),
  });
}

function sanitizedError(error: unknown): string {
  if (error instanceof HTTPException) {
    return `HTTPException ${error.status}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeHost(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).host;
  } catch {
    return undefined;
  }
}

async function oauthErrorFromResponse(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    await cancelResponseBody(response);
    return null;
  }
  // Consume the original response, not a clone. The pinned transport owns a
  // per-response dispatcher, so leaving the original body unread would retain
  // its socket pool after a token endpoint error.
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "OAuth token error response",
  ).catch(() => null);
  const error = stringValue(payload?.error);
  if (!error || !/^[a-zA-Z0-9_.-]{1,80}$/.test(error)) {
    return null;
  }
  return error;
}

async function verifyMcpToolsList(
  settings: Settings,
  resource: string,
  token: TokenResponse,
): Promise<Array<{ name: string; description?: string }>> {
  const client = new Client(
    { name: "opengeni-integration-verify", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: {
        headers: {
          authorization: `${normalizeBearerScheme(token.tokenType)} ${token.accessToken}`,
        },
      },
      fetch: (url, init) => fetchOAuth(url.toString(), settings, init),
    });
    await client.connect(transport as unknown as Transport, {
      timeout: 10_000,
      maxTotalTimeout: 10_000,
    });
    const listed = await client.listTools(undefined, { timeout: 10_000, maxTotalTimeout: 10_000 });
    return listed.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function verifyMcpToolsListNonFatal(
  observability: Observability | undefined,
  settings: Settings,
  state: OAuthStatePayload,
  token: TokenResponse,
): Promise<{
  metadata:
    | { status: "ok"; checkedAt: string; toolCount: number }
    | { status: "failed"; checkedAt: string; reason: string };
  tools?: Array<{ name: string; description?: string }>;
}> {
  try {
    const tools = await runCallbackStage("tools_list", "tools_list_failed", () =>
      verifyMcpToolsList(settings, state.mcpUrl, token),
    );
    return {
      metadata: {
        status: "ok",
        checkedAt: new Date().toISOString(),
        toolCount: tools.length,
      },
      tools,
    };
  } catch (error) {
    const staged =
      error instanceof OAuthCallbackStageError
        ? error
        : new OAuthCallbackStageError("tools_list", "tools_list_failed", error);
    logOAuthVerificationWarning(observability, staged, state);
    return {
      metadata: {
        status: "failed",
        checkedAt: new Date().toISOString(),
        reason: staged.reason,
      },
    };
  }
}

function credentialBundle(
  token: TokenResponse,
  state: OAuthStatePayload,
  client: OAuthClientRegistration,
): Record<string, unknown> {
  return {
    access_token: token.accessToken,
    ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
    token_type: token.tokenType,
    ...(token.expiresAt ? { expires_at: token.expiresAt.toISOString() } : {}),
    resource: state.resource,
    mcp_url: state.mcpUrl,
    ...(token.scopeText
      ? { scope: token.scopeText }
      : state.authorizeScopes.length
        ? { scope: state.authorizeScopes.join(" ") }
        : {}),
    token_endpoint: state.tokenEndpoint,
    client_id: client.clientId,
    ...(client.clientSecret
      ? {
          client_secret: client.clientSecret,
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        }
      : {}),
  };
}

function callbackReturnPath(
  returnPath: string,
  status: "success" | "error",
  params: Record<string, string>,
): string {
  const url = new URL(returnPath, "https://opengeni.local");
  url.searchParams.set("integration_oauth", status);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function canonicalMcpResource(value: string | undefined): string {
  if (!value) {
    throw new HTTPException(400, { message: "mcpUrl is required" });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(422, { message: "MCP resource URL is invalid" });
  }
  url.hash = "";
  return url.toString();
}

function canonicalOAuthResource(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HTTPException(422, {
      message: "MCP protected resource metadata advertised an invalid resource",
    });
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      return url.toString();
    }
    return trimmed;
  } catch {
    throw new HTTPException(422, {
      message: "MCP protected resource metadata advertised an invalid resource",
    });
  }
}

function oauthEndpointUrl(rawUrl: string, settings: Settings, label: string): string {
  try {
    return validateHttpUrl(rawUrl, {
      label,
      allowLoopbackHttp: isLocalTestEnvironment(settings.environment),
    });
  } catch (error) {
    if (error instanceof DestinationPolicyError) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  }
}

function safeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new HTTPException(400, { message: "OAuth returnPath must be a relative path" });
  }
  const parsed = new URL(value, "https://opengeni.local");
  if (parsed.origin !== "https://opengeni.local") {
    throw new HTTPException(400, { message: "OAuth returnPath must be a relative path" });
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function fetchJsonObject(url: string, settings: Settings): Promise<Record<string, unknown>> {
  const response = await fetchOAuth(url, settings, { headers: { accept: "application/json" } });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await readResponseJsonBounded<unknown>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "OAuth metadata response",
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("metadata response was not a JSON object");
  }
  return payload as Record<string, unknown>;
}

async function fetchOAuth(
  rawUrl: string,
  settings: Settings,
  init: RequestInit = {},
  hop = 0,
): Promise<Response> {
  let response: Response;
  try {
    const endpoint = oauthEndpointUrl(rawUrl, settings, "OAuth endpoint");
    response = await pinnedFetch(endpoint, init, settings, {
      label: "OAuth discovery",
      requireHttpsOutsideLocalTest: true,
    });
  } catch (error) {
    if (error instanceof DestinationPolicyError) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  }
  if (response.status < 300 || response.status >= 400) {
    return response;
  }
  // Discovery is the only redirectable OAuth traffic. Replaying a token
  // exchange, dynamic registration, or authenticated MCP request would send
  // its body and/or credential headers to a provider-controlled Location.
  // Keep this allowlist deliberately narrow so future credential headers fail
  // closed instead of silently becoming redirectable.
  if (!oauthRequestMayFollowRedirect(init)) {
    await cancelResponseBody(response);
    throw new HTTPException(422, {
      message: "OAuth credential-bearing requests may not follow redirects",
    });
  }
  if (hop >= 3) {
    await cancelResponseBody(response);
    throw new HTTPException(422, { message: "OAuth fetch exceeded maximum redirect hops" });
  }
  const location = response.headers.get("location");
  if (!location) {
    await cancelResponseBody(response);
    throw new HTTPException(422, { message: "OAuth fetch redirect was missing Location" });
  }
  let nextUrl: string;
  try {
    nextUrl = new URL(location, rawUrl).toString();
  } catch {
    await cancelResponseBody(response);
    throw new HTTPException(422, { message: "OAuth fetch redirect Location was invalid" });
  }
  await cancelResponseBody(response);
  return await fetchOAuth(nextUrl, settings, init, hop + 1);
}

function oauthRequestMayFollowRedirect(init: RequestInit): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  if ((method !== "GET" && method !== "HEAD") || init.body != null) {
    return false;
  }
  const headers = new Headers(init.headers);
  return [...headers.keys()].every((name) => name === "accept");
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseWwwAuthenticate(header: string | null): WwwAuthenticateChallenge {
  if (!header) {
    return {};
  }
  const bearerIndex = header.toLowerCase().indexOf("bearer");
  if (bearerIndex < 0) {
    return {};
  }
  const paramsText = header.slice(bearerIndex + "bearer".length);
  const params: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(paramsText)) !== null) {
    const raw = match[2]!;
    params[match[1]!.toLowerCase()] = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\"/g, '"')
      : raw;
  }
  return {
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
    ...(params.scope ? { scope: params.scope.split(/\s+/).filter(Boolean) } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

function wellKnownCandidates(rawUrl: string, name: string): string[] {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return uniqueStrings([
    `${url.origin}/.well-known/${name}${path ? `/${path}` : ""}`,
    `${url.origin}${path ? `/${path}` : ""}/.well-known/${name}`,
    `${url.origin}/.well-known/${name}`,
  ]);
}

function chooseAuthorizeScopes(
  requested: string[] | undefined,
  challenged: string[] | undefined,
  supported: string[],
): string[] {
  if (requested?.length) {
    return uniqueStrings(requested);
  }
  if (challenged?.length) {
    return uniqueStrings(challenged);
  }
  return uniqueStrings(supported);
}

function grantedScopes(scopeText: string | undefined, fallback: string[]): string[] {
  if (scopeText) {
    return uniqueStrings(scopeText.split(/\s+/).filter(Boolean));
  }
  return fallback;
}

function tokenAuthMethod(
  raw: string | undefined,
  hasSecret: boolean,
): OAuthClientRegistration["tokenEndpointAuthMethod"] {
  if (raw === "client_secret_post" || raw === "client_secret_basic") {
    return raw;
  }
  return hasSecret ? "client_secret_post" : "none";
}

function registrationMethod(value: unknown): OAuthClientRegistration["method"] {
  if (value === "operator" || value === "manual" || value === "cimd" || value === "dcr") {
    return value;
  }
  throw new HTTPException(400, { message: "invalid OAuth state" });
}

function expiresAtFromTokenResponse(payload: Record<string, unknown>): Date | null {
  const expiresAt = stringValue(payload.expires_at);
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }
  return null;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) {
    throw new HTTPException(400, { message: `invalid OAuth state: missing ${field}` });
  }
  return result;
}
