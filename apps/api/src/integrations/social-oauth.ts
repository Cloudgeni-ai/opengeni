import { parseSocialOauthClientsJson, type Settings } from "@opengeni/config";
import {
  OAuthStartResponse,
  type SocialConnection,
  type SocialOAuthProviderId,
  type SocialOAuthStartRequest,
} from "@opengeni/contracts";
import { requireEnvironmentEncryption } from "@opengeni/core";
import type { Observability } from "@opengeni/observability";
import {
  consumeIntegrationOAuthStateNonce,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  loadSocialConnectionCredential,
  updateSocialConnectionCredential,
  upsertSocialOAuthConnection,
  type Database,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { OAUTH_MAX_RESPONSE_BYTES, pinnedFetch, readResponseJsonBounded } from "@opengeni/network";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

// Reddit requires a descriptive, stable User-Agent on every request (token
// endpoint included) and throttles generic ones; X tolerates any.
export const SOCIAL_USER_AGENT = "opengeni:social-connector:v0.1.0 (self-hosted)";

type SocialProviderDefinition = {
  id: SocialOAuthProviderId;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  defaultScopes: string[];
  // X mandates PKCE S256; Reddit's authorization server does not support it,
  // so Reddit relies on the signed single-use state alone.
  pkce: boolean;
  extraAuthorizeParams: Record<string, string>;
};

export const SOCIAL_OAUTH_PROVIDERS: Record<SocialOAuthProviderId, SocialProviderDefinition> = {
  x: {
    id: "x",
    authorizationEndpoint: "https://x.com/i/oauth2/authorize",
    tokenEndpoint: "https://api.x.com/2/oauth2/token",
    defaultScopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    pkce: true,
    extraAuthorizeParams: {},
  },
  reddit: {
    id: "reddit",
    authorizationEndpoint: "https://www.reddit.com/api/v1/authorize",
    tokenEndpoint: "https://www.reddit.com/api/v1/access_token",
    defaultScopes: ["identity", "read", "submit", "privatemessages", "history"],
    pkce: false,
    // permanent => Reddit issues a refresh_token instead of a 1h-only grant.
    extraAuthorizeParams: { duration: "permanent" },
  },
};

export type SocialCredentialBundle = {
  provider: SocialOAuthProviderId;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
  scope?: string;
};

type SocialOAuthDeps = {
  db: Database;
  settings: Settings;
  observability?: Observability | undefined;
};

export type SocialOAuthStartContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  requestUrl: string;
  payload: SocialOAuthStartRequest;
};

type SocialOAuthStatePayload = {
  kind: "social_oauth";
  accountId: string;
  workspaceId: string;
  subjectId: string;
  provider: SocialOAuthProviderId;
  scopes: string[];
  encryptedPkceVerifier?: string;
  returnPath: string;
  nonce: string;
  iat: number;
};

export function socialOAuthClientFor(
  settings: Settings,
  provider: SocialOAuthProviderId,
): { clientId: string; clientSecret?: string | undefined } {
  const configured = parseSocialOauthClientsJson(settings.socialOauthClientsJson)[provider];
  if (!configured) {
    throw new HTTPException(503, {
      message: `social provider ${provider} requires an operator OAuth app in OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON`,
    });
  }
  return configured;
}

export function socialOAuthRedirectUri(settings: Settings, requestUrl: string): string {
  return `${integrationBaseUrl(settings.publicBaseUrl, requestUrl)}/v1/social/oauth/callback`;
}

export async function startSocialOAuth(
  deps: SocialOAuthDeps,
  context: SocialOAuthStartContext,
): Promise<OAuthStartResponse> {
  const { settings } = deps;
  const provider = SOCIAL_OAUTH_PROVIDERS[context.payload.provider];
  const client = socialOAuthClientFor(settings, provider.id);
  const redirectUri = socialOAuthRedirectUri(settings, context.requestUrl);
  const returnPath = safeReturnPath(context.payload.returnPath ?? "/integrations");
  const scopes = uniqueScopes(context.payload.scopes) ?? provider.defaultScopes;
  const verifier = provider.pkce ? randomBytes(32).toString("base64url") : null;
  const key = verifier ? requireEnvironmentEncryption(settings) : null;
  const state = createSignedState(requireIntegrationsStateSecret(settings), {
    kind: "social_oauth",
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    subjectId: context.subjectId,
    provider: provider.id,
    scopes,
    ...(verifier && key ? { encryptedPkceVerifier: encryptEnvironmentValue(key, verifier) } : {}),
    returnPath,
  });
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scopes.join(" "));
  for (const [param, value] of Object.entries(provider.extraAuthorizeParams)) {
    url.searchParams.set(param, value);
  }
  if (verifier) {
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
  }
  return OAuthStartResponse.parse({
    state,
    authorizationUrl: url.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completeSocialOAuthCallback(
  deps: SocialOAuthDeps,
  input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    requestUrl: string;
  },
): Promise<{ redirectTo: string }> {
  const { db, settings, observability } = deps;
  let state: SocialOAuthStatePayload | null = null;
  try {
    state = readSocialOAuthState(input.state, settings);
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
    logSocialOAuthFailure(observability, "state_verify", state, error);
    return {
      redirectTo: callbackReturnPath(state?.returnPath ?? "/integrations", "error", {
        reason: "state_invalid",
      }),
    };
  }
  if (input.error || !input.code) {
    return {
      redirectTo: callbackReturnPath(state.returnPath, "error", {
        reason: input.error ?? "missing_code",
      }),
    };
  }
  try {
    const provider = SOCIAL_OAUTH_PROVIDERS[state.provider];
    const client = socialOAuthClientFor(settings, provider.id);
    const key = requireEnvironmentEncryption(settings);
    const verifier = state.encryptedPkceVerifier
      ? decryptEnvironmentValue(key, state.encryptedPkceVerifier)
      : null;
    const token = await socialTokenRequest(settings, provider, client, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: socialOAuthRedirectUri(settings, input.requestUrl),
      ...(verifier ? { code_verifier: verifier } : {}),
    });
    const identity = await fetchSocialIdentity(settings, provider.id, token.accessToken);
    const bundle: SocialCredentialBundle = {
      provider: provider.id,
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      ...(token.scope ? { scope: token.scope } : {}),
    };
    const grantedScopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : state.scopes;
    const connection = await upsertSocialOAuthConnection(db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      provider: provider.id,
      accountHandle: identity.handle,
      accountName: identity.name ?? null,
      externalAccountId: identity.externalAccountId,
      scopes: grantedScopes,
      credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify(bundle)),
      tokenMetadata: publicTokenMetadata(bundle),
    });
    return {
      redirectTo: callbackReturnPath(state.returnPath, "success", {
        connectionId: connection.id,
        provider: provider.id,
        accountHandle: identity.handle,
      }),
    };
  } catch (error) {
    logSocialOAuthFailure(observability, "token_exchange", state, error);
    return {
      redirectTo: callbackReturnPath(state.returnPath, "error", {
        reason: "token_exchange_failed",
      }),
    };
  }
}

/**
 * Resolves a usable access token for a social connection, refreshing (and
 * persisting the rotated bundle) when the stored token is near expiry. Marks
 * the connection needs_reauth and throws when refresh is impossible so agents
 * surface an actionable error instead of opaque 401s.
 */
export async function freshSocialAccessToken(
  deps: SocialOAuthDeps,
  ref: { workspaceId: string; connectionId: string },
): Promise<{ connection: SocialConnection; bundle: SocialCredentialBundle }> {
  const { db, settings } = deps;
  const loaded = await loadSocialConnectionCredential(db, ref.workspaceId, ref.connectionId);
  if (!loaded) {
    throw new Error(`Social connection not found: ${ref.connectionId}`);
  }
  if (loaded.connection.status === "disabled") {
    throw new Error(`Social connection ${ref.connectionId} is disabled`);
  }
  if (!loaded.credentialEncrypted) {
    throw new Error(
      `Social connection ${ref.connectionId} has no stored OAuth credential; reconnect it via the social OAuth flow`,
    );
  }
  const key = requireEnvironmentEncryption(settings);
  const bundle = parseSocialCredentialBundle(
    decryptEnvironmentValue(key, loaded.credentialEncrypted),
  );
  if (!socialTokenNeedsRefresh(bundle, new Date())) {
    return { connection: loaded.connection, bundle };
  }
  if (!bundle.refreshToken) {
    await markNeedsReauth(deps, ref);
    throw new Error(
      `Social connection ${ref.connectionId} token expired and no refresh token is stored; reconnect it`,
    );
  }
  const provider = SOCIAL_OAUTH_PROVIDERS[bundle.provider];
  const client = socialOAuthClientFor(settings, provider.id);
  let token: NormalizedTokenResponse;
  try {
    token = await socialTokenRequest(settings, provider, client, {
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
    });
  } catch (error) {
    await markNeedsReauth(deps, ref);
    throw new Error(
      `Social connection ${ref.connectionId} token refresh failed; reconnect it (${errorMessage(error)})`,
      { cause: error },
    );
  }
  const refreshed: SocialCredentialBundle = {
    provider: bundle.provider,
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    // X rotates refresh tokens on every use; keep the previous one only when
    // the provider omits a replacement (Reddit re-uses the original).
    refreshToken: token.refreshToken ?? bundle.refreshToken,
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    ...(token.scope ? { scope: token.scope } : bundle.scope ? { scope: bundle.scope } : {}),
  };
  const connection =
    (await updateSocialConnectionCredential(db, {
      workspaceId: ref.workspaceId,
      connectionId: ref.connectionId,
      credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify(refreshed)),
      status: "connected",
      tokenMetadata: publicTokenMetadata(refreshed),
    })) ?? loaded.connection;
  return { connection, bundle: refreshed };
}

export async function markNeedsReauth(
  deps: SocialOAuthDeps,
  ref: { workspaceId: string; connectionId: string },
): Promise<void> {
  await updateSocialConnectionCredential(deps.db, {
    workspaceId: ref.workspaceId,
    connectionId: ref.connectionId,
    status: "needs_reauth",
  });
}

export function parseSocialCredentialBundle(raw: string): SocialCredentialBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("stored social credential is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stored social credential has an unexpected shape");
  }
  const bundle = parsed as Record<string, unknown>;
  const provider = bundle.provider;
  const accessToken = bundle.accessToken;
  if (
    (provider !== "x" && provider !== "reddit") ||
    typeof accessToken !== "string" ||
    accessToken.length === 0
  ) {
    throw new Error("stored social credential has an unexpected shape");
  }
  return {
    provider,
    accessToken,
    tokenType: typeof bundle.tokenType === "string" ? bundle.tokenType : "Bearer",
    ...(typeof bundle.refreshToken === "string" ? { refreshToken: bundle.refreshToken } : {}),
    ...(typeof bundle.expiresAt === "string" ? { expiresAt: bundle.expiresAt } : {}),
    ...(typeof bundle.scope === "string" ? { scope: bundle.scope } : {}),
  };
}

const REFRESH_SKEW_MS = 120 * 1000;

export function socialTokenNeedsRefresh(bundle: SocialCredentialBundle, now: Date): boolean {
  if (!bundle.expiresAt) {
    return false;
  }
  const expiresAt = new Date(bundle.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return false;
  }
  return expiresAt.getTime() - now.getTime() <= REFRESH_SKEW_MS;
}

type NormalizedTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
  scope?: string;
};

async function socialTokenRequest(
  settings: Settings,
  provider: SocialProviderDefinition,
  client: { clientId: string; clientSecret?: string | undefined },
  params: Record<string, string>,
): Promise<NormalizedTokenResponse> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": SOCIAL_USER_AGENT,
  };
  // Reddit always authenticates the token endpoint with HTTP basic (installed
  // apps use an empty secret). X does the same for confidential clients and
  // falls back to a public-client body param otherwise.
  if (provider.id === "reddit" || client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(
      `${client.clientId}:${client.clientSecret ?? ""}`,
    ).toString("base64")}`;
  }
  if (!headers.authorization || provider.id === "x") {
    body.set("client_id", client.clientId);
  }
  const response = await pinnedFetch(
    provider.tokenEndpoint,
    { method: "POST", headers, body },
    settings,
    { label: "social OAuth token exchange", requireHttpsOutsideLocalTest: true },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${provider.id} token endpoint returned HTTP ${response.status}`);
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "social OAuth token response",
  );
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  // Reddit reports errors with HTTP 200 + {"error": "..."} on some paths.
  if (!accessToken) {
    const reason = typeof payload.error === "string" ? payload.error : "missing access_token";
    throw new Error(`${provider.id} token response was invalid: ${reason}`);
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  return {
    accessToken,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    ...(typeof payload.refresh_token === "string" && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
    ...(typeof payload.scope === "string" && payload.scope ? { scope: payload.scope } : {}),
  };
}

async function fetchSocialIdentity(
  settings: Settings,
  provider: SocialOAuthProviderId,
  accessToken: string,
): Promise<{ handle: string; name?: string; externalAccountId: string }> {
  const endpoint =
    provider === "x" ? "https://api.x.com/2/users/me" : "https://oauth.reddit.com/api/v1/me";
  const response = await pinnedFetch(
    endpoint,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": SOCIAL_USER_AGENT,
      },
    },
    settings,
    { label: "social identity lookup", requireHttpsOutsideLocalTest: true },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${provider} identity lookup returned HTTP ${response.status}`);
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "social identity response",
  );
  if (provider === "x") {
    const data = payload.data as Record<string, unknown> | undefined;
    const username = typeof data?.username === "string" ? data.username : null;
    const id = typeof data?.id === "string" ? data.id : null;
    if (!username || !id) {
      throw new Error("x identity response was missing data.username or data.id");
    }
    return {
      handle: username,
      externalAccountId: id,
      ...(typeof data?.name === "string" ? { name: data.name } : {}),
    };
  }
  const name = typeof payload.name === "string" ? payload.name : null;
  const id = typeof payload.id === "string" ? payload.id : null;
  if (!name || !id) {
    throw new Error("reddit identity response was missing name or id");
  }
  return { handle: name, externalAccountId: id };
}

function publicTokenMetadata(bundle: SocialCredentialBundle): Record<string, unknown> {
  return {
    tokenType: bundle.tokenType,
    hasRefreshToken: Boolean(bundle.refreshToken),
    ...(bundle.expiresAt ? { expiresAt: bundle.expiresAt } : {}),
    ...(bundle.scope ? { scope: bundle.scope } : {}),
    obtainedAt: new Date().toISOString(),
  };
}

function readSocialOAuthState(
  raw: string | undefined,
  settings: Settings,
): SocialOAuthStatePayload {
  if (!raw) {
    throw new HTTPException(400, { message: "missing OAuth state" });
  }
  const payload = readSignedState(raw, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload || payload.kind !== "social_oauth") {
    throw new HTTPException(400, { message: "invalid or expired OAuth state" });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const iat = typeof payload.iat === "number" ? payload.iat : NaN;
  if (!Number.isFinite(iat) || nowSeconds - iat > oauthStateTtlMs / 1000 || nowSeconds < iat) {
    throw new HTTPException(400, { message: "invalid or expired OAuth state" });
  }
  const provider = payload.provider;
  if (provider !== "x" && provider !== "reddit") {
    throw new HTTPException(400, { message: "invalid OAuth state: provider" });
  }
  return {
    kind: "social_oauth",
    accountId: requiredStateString(payload.accountId, "accountId"),
    workspaceId: requiredStateString(payload.workspaceId, "workspaceId"),
    subjectId: requiredStateString(payload.subjectId, "subjectId"),
    provider,
    scopes: Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    ...(typeof payload.encryptedPkceVerifier === "string"
      ? { encryptedPkceVerifier: payload.encryptedPkceVerifier }
      : {}),
    returnPath: safeReturnPath(
      typeof payload.returnPath === "string" ? payload.returnPath : "/integrations",
    ),
    nonce: requiredStateString(payload.nonce, "nonce"),
    iat,
  };
}

function requiredStateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HTTPException(400, { message: `invalid OAuth state: missing ${field}` });
  }
  return value;
}

function uniqueScopes(scopes: string[] | undefined): string[] | null {
  const cleaned = [...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
  return cleaned.length > 0 ? cleaned : null;
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

function callbackReturnPath(
  returnPath: string,
  status: "success" | "error",
  params: Record<string, string>,
): string {
  const url = new URL(returnPath, "https://opengeni.local");
  url.searchParams.set("social_oauth", status);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function logSocialOAuthFailure(
  observability: Observability | undefined,
  stage: string,
  state: SocialOAuthStatePayload | null,
  error: unknown,
): void {
  observability?.error("social OAuth callback failed", {
    "opengeni.social_oauth.stage": stage,
    "opengeni.social_oauth.provider": state?.provider,
    error: errorMessage(error),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
