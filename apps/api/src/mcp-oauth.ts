import { createHash, randomBytes } from "node:crypto";
import {
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  MCP_OAUTH_CONSENT_TTL_SECONDS,
  MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  MCP_OAUTH_SCOPE,
  McpOAuthAuthorizationServerMetadata,
  McpOAuthClientRegistrationRequest,
  McpOAuthClientRegistrationResponse,
  McpOAuthProtectedResourceMetadata,
  McpOAuthTokenResponse,
  type AccessGrant,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import {
  consumeMcpOAuthAuthorizationRequest,
  createMcpOAuthAuthorizationRequest,
  deleteMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthClient,
  registerMcpOAuthClient,
  resolveLiveMcpOAuthGrant,
  resolveMcpOAuthAccessToken,
  rotateMcpOAuthRefreshToken,
} from "@opengeni/db";
import { requireAccessGrantAuthorization, type ApiRouteDeps } from "@opengeni/core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  prepareWorkspaceToolGateway,
  requireWorkspaceToolGatewayAuthorization,
} from "./workspace-tool-gateway";

const CLIENT_PREFIX = "ogmcp_client_";
const REQUEST_PREFIX = "ogmcp_req_";
const CODE_PREFIX = "ogmcp_code_";
const ACCESS_PREFIX = "ogmcp_at_";
const REFRESH_PREFIX = "ogmcp_rt_";
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const WORKSPACE_MCP_PATH = /^\/v1\/workspaces\/([0-9a-f-]{36})\/mcp(?:\/(docs|files))?$/u;

export type McpOAuthResource = {
  resource: string;
  workspaceId: string;
  kind: "all" | "docs" | "files";
};

export type McpOAuthRouteAccess = {
  grant: AccessGrant;
  allowedToolIdentities: ToolGatewayIdentity[];
};

export function registerMcpOAuthRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/.well-known/oauth-authorization-server", (c) => {
    requireMcpOAuthEnabled(deps);
    const issuer = mcpOAuthIssuer(deps);
    c.header("cache-control", "public, max-age=300");
    return c.json(
      McpOAuthAuthorizationServerMetadata.parse({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [MCP_OAUTH_SCOPE],
        authorization_response_iss_parameter_supported: true,
      }),
    );
  });

  app.get("/.well-known/oauth-protected-resource/*", (c) => {
    requireMcpOAuthEnabled(deps);
    const pathname = new URL(c.req.url).pathname.replace(
      "/.well-known/oauth-protected-resource",
      "",
    );
    const resource = parseMcpOAuthResource(deps, `${mcpOAuthIssuer(deps)}${pathname}`);
    c.header("cache-control", "public, max-age=300");
    return c.json(
      McpOAuthProtectedResourceMetadata.parse({
        resource: resource.resource,
        authorization_servers: [mcpOAuthIssuer(deps)],
        scopes_supported: [MCP_OAUTH_SCOPE],
        bearer_methods_supported: ["header"],
      }),
    );
  });

  app.post("/oauth/register", async (c) => {
    requireMcpOAuthEnabled(deps);
    const parsed = McpOAuthClientRegistrationRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return oauthError(c, "invalid_client_metadata", 400);
    let redirectUris: string[];
    try {
      redirectUris = [...new Set(parsed.data.redirect_uris.map(validateRedirectUri))];
    } catch {
      return oauthError(c, "invalid_redirect_uri", 400);
    }
    const client = await registerMcpOAuthClient(deps.db, {
      clientId: opaque(CLIENT_PREFIX),
      redirectUris,
      clientName: parsed.data.client_name ?? null,
      grantTypes: parsed.data.grant_types,
      responseTypes: ["code"],
    });
    c.header("cache-control", "no-store");
    return c.json(
      McpOAuthClientRegistrationResponse.parse({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000),
        redirect_uris: client.redirectUris,
        ...(client.clientName ? { client_name: client.clientName } : {}),
        ...(parsed.data.application_type ? { application_type: parsed.data.application_type } : {}),
        ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
        token_endpoint_auth_method: "none",
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
      }),
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    requireMcpOAuthEnabled(deps);
    const query = new URL(c.req.url).searchParams;
    const client = await requireAuthorizationClient(deps, query);
    const resource = requireAuthorizationResource(deps, query);
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      resource.workspaceId,
      "workspace:read",
    );
    const grant = requireWorkspaceToolGatewayAuthorization(authorization);
    const prepared = await prepareWorkspaceToolGateway(deps, authorization);
    const requestToken = opaque(REQUEST_PREFIX);
    try {
      await createMcpOAuthAuthorizationRequest(deps.db, {
        requestHash: tokenHash(requestToken),
        clientId: client.clientId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        resource: resource.resource,
        redirectUri: requireRedirectUri(client.redirectUris, query.get("redirect_uri")),
        codeChallenge: requireCodeChallenge(query),
        state: boundedState(query.get("state")),
        permissions: grant.permissions,
        toolIdentities: prepared.toolGatewayCatalog.entries.map((entry) => entry.identity),
        expiresAt: expiresIn(MCP_OAUTH_CONSENT_TTL_SECONDS),
      });
    } finally {
      await prepared.close();
    }
    c.header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    c.header("cache-control", "no-store");
    return c.html(consentHtml(client.clientName ?? client.clientId, resource, requestToken));
  });

  app.post("/oauth/authorize", async (c) => {
    requireMcpOAuthEnabled(deps);
    const form = new URLSearchParams(await c.req.text());
    const requestToken = form.get("request") ?? "";
    if (!requestToken.startsWith(REQUEST_PREFIX)) return oauthError(c, "invalid_request", 400);
    const request = await getMcpOAuthAuthorizationRequest(deps.db, tokenHash(requestToken));
    if (!request) return oauthError(c, "invalid_request", 400);
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      request.workspaceId,
      "workspace:read",
    );
    const grant = requireWorkspaceToolGatewayAuthorization(authorization);
    if (grant.subjectId !== request.subjectId || grant.accountId !== request.accountId) {
      throw new HTTPException(403, { message: "OAuth consent authority changed" });
    }
    if (form.get("decision") !== "approve") {
      await deleteMcpOAuthAuthorizationRequest(deps.db, request.requestHash);
      return c.redirect(
        authorizationRedirect(request.redirectUri, {
          error: "access_denied",
          iss: mcpOAuthIssuer(deps),
          ...(request.state ? { state: request.state } : {}),
        }),
      );
    }
    const code = opaque(CODE_PREFIX);
    const consumed = await consumeMcpOAuthAuthorizationRequest(deps.db, {
      requestHash: request.requestHash,
      subjectId: grant.subjectId,
      codeHash: tokenHash(code),
      codeExpiresAt: expiresIn(MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
    });
    if (!consumed) return oauthError(c, "invalid_request", 400);
    return c.redirect(
      authorizationRedirect(consumed.redirectUri, {
        code,
        iss: mcpOAuthIssuer(deps),
        ...(consumed.state ? { state: consumed.state } : {}),
      }),
    );
  });

  app.post("/oauth/token", async (c) => {
    requireMcpOAuthEnabled(deps);
    const form = new URLSearchParams(await c.req.text());
    const grantType = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource");
    const client = await getMcpOAuthClient(deps.db, clientId);
    if (!client) return oauthError(c, "invalid_client", 401);
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return oauthError(c, "unsupported_grant_type", 400);
    }
    if (!client.grantTypes.includes(grantType)) {
      return oauthError(c, "unauthorized_client", 400);
    }
    const requestedScope = form.get("scope");
    if (requestedScope !== null && requestedScope !== MCP_OAUTH_SCOPE) {
      return oauthError(c, "invalid_scope", 400);
    }
    if (!resource) return oauthError(c, "invalid_target", 400);
    let parsedResource: McpOAuthResource;
    try {
      parsedResource = parseMcpOAuthResource(deps, resource);
    } catch {
      return oauthError(c, "invalid_target", 400);
    }
    const accessToken = opaque(ACCESS_PREFIX);
    const refreshToken = client.grantTypes.includes("refresh_token")
      ? opaque(REFRESH_PREFIX)
      : null;
    const tokenInput = {
      clientId,
      resource: parsedResource.resource,
      accessTokenHash: tokenHash(accessToken),
      accessExpiresAt: expiresIn(MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS),
      refreshExpiresAt: expiresIn(MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS),
    };
    const access =
      grantType === "authorization_code"
        ? await exchangeAuthorizationCode(deps, client.redirectUris, form, {
            ...tokenInput,
            refreshTokenHash: refreshToken ? tokenHash(refreshToken) : null,
          })
        : refreshToken
          ? await rotateRefreshToken(deps, form, {
              ...tokenInput,
              nextRefreshTokenHash: tokenHash(refreshToken),
            })
          : null;
    if (!access) return oauthError(c, "invalid_grant", 400);
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    return c.json(
      McpOAuthTokenResponse.parse({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        scope: MCP_OAUTH_SCOPE,
      }),
    );
  });
}

export async function resolveMcpOAuthRouteAccess(
  deps: ApiRouteDeps,
  request: Request,
  workspaceId: string,
): Promise<McpOAuthRouteAccess | null> {
  const token = mcpOAuthBearerToken(request);
  if (!token) return null;
  requireMcpOAuthEnabled(deps);
  const access = await resolveMcpOAuthAccessToken(deps.db, tokenHash(token));
  const requestResource = parseMcpOAuthResource(
    deps,
    `${mcpOAuthIssuer(deps)}${new URL(request.url).pathname}`,
  );
  if (
    !access ||
    access.workspaceId !== workspaceId ||
    access.resource !== requestResource.resource
  ) {
    throw new HTTPException(401, { message: "invalid MCP OAuth access token" });
  }
  const grant = await resolveLiveMcpOAuthGrant(deps.db, access);
  if (!grant) throw new HTTPException(401, { message: "MCP OAuth authority is no longer active" });
  const allowedToolIdentities = access.toolIdentities.filter((identity) =>
    requestResource.kind === "all" ? true : identity.serverId === requestResource.kind,
  );
  return { grant, allowedToolIdentities };
}

export function mcpOAuthBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer +(\S+)$/iu)?.[1];
  if (!token) return null;
  return token.startsWith(ACCESS_PREFIX) ? token : null;
}

export function isMcpOAuthResourcePath(pathname: string): boolean {
  return WORKSPACE_MCP_PATH.test(pathname);
}

export function isMcpOAuthPublicProtocolPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname.startsWith("/.well-known/oauth-protected-resource/") ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/token"
  );
}

export function mcpOAuthAuthenticateHeader(deps: ApiRouteDeps, pathname: string): string {
  return `Bearer resource_metadata="${mcpOAuthIssuer(deps)}/.well-known/oauth-protected-resource${pathname}", scope="${MCP_OAUTH_SCOPE}"`;
}

function requireMcpOAuthEnabled(deps: ApiRouteDeps): void {
  if (!deps.settings.mcpOauthEnabled) throw new HTTPException(404, { message: "not found" });
}

function mcpOAuthIssuer(deps: ApiRouteDeps): string {
  if (!deps.settings.publicBaseUrl) throw new Error("MCP OAuth public base URL is not configured");
  return new URL(deps.settings.publicBaseUrl).origin;
}

function parseMcpOAuthResource(deps: ApiRouteDeps, value: string): McpOAuthResource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, { message: "invalid OAuth resource" });
  }
  const issuer = mcpOAuthIssuer(deps);
  const match = url.pathname.match(WORKSPACE_MCP_PATH);
  if (url.origin !== issuer || url.username || url.password || url.search || url.hash || !match) {
    throw new HTTPException(400, { message: "invalid OAuth resource" });
  }
  return {
    resource: `${issuer}${url.pathname}`,
    workspaceId: match[1]!,
    kind: match[2] === "docs" ? "docs" : match[2] === "files" ? "files" : "all",
  };
}

async function requireAuthorizationClient(deps: ApiRouteDeps, query: URLSearchParams) {
  if (query.get("response_type") !== "code" || query.get("scope") !== MCP_OAUTH_SCOPE) {
    throw new HTTPException(400, { message: "unsupported OAuth authorization request" });
  }
  const clientId = query.get("client_id") ?? "";
  const client = await getMcpOAuthClient(deps.db, clientId);
  if (!client || !client.grantTypes.includes("authorization_code")) {
    throw new HTTPException(400, { message: "invalid OAuth client" });
  }
  requireRedirectUri(client.redirectUris, query.get("redirect_uri"));
  requireCodeChallenge(query);
  return client;
}

function requireAuthorizationResource(
  deps: ApiRouteDeps,
  query: URLSearchParams,
): McpOAuthResource {
  const resources = query.getAll("resource");
  if (resources.length !== 1)
    throw new HTTPException(400, { message: "one OAuth resource is required" });
  return parseMcpOAuthResource(deps, resources[0]!);
}

function requireRedirectUri(registered: string[], value: string | null): string {
  if (!value || !registered.includes(value)) {
    throw new HTTPException(400, { message: "OAuth redirect_uri is not registered" });
  }
  return value;
}

function requireCodeChallenge(query: URLSearchParams): string {
  const challenge = query.get("code_challenge") ?? "";
  if (query.get("code_challenge_method") !== "S256" || !PKCE_CHALLENGE.test(challenge)) {
    throw new HTTPException(400, { message: "PKCE S256 is required" });
  }
  return challenge;
}

async function exchangeAuthorizationCode(
  deps: ApiRouteDeps,
  redirectUris: string[],
  form: URLSearchParams,
  input: {
    clientId: string;
    resource: string;
    accessTokenHash: string;
    refreshTokenHash: string | null;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
) {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  if (!code.startsWith(CODE_PREFIX) || !PKCE_VERIFIER.test(verifier)) return null;
  const redirectUri = form.get("redirect_uri");
  if (!redirectUri || !redirectUris.includes(redirectUri)) return null;
  return await exchangeMcpOAuthAuthorizationCode(deps.db, {
    codeHash: tokenHash(code),
    clientId: input.clientId,
    redirectUri,
    resource: input.resource,
    codeChallenge: pkceChallenge(verifier),
    accessTokenHash: input.accessTokenHash,
    refreshTokenHash: input.refreshTokenHash,
    accessExpiresAt: input.accessExpiresAt,
    refreshExpiresAt: input.refreshExpiresAt,
  });
}

async function rotateRefreshToken(
  deps: ApiRouteDeps,
  form: URLSearchParams,
  input: {
    clientId: string;
    resource: string;
    accessTokenHash: string;
    nextRefreshTokenHash: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
) {
  const refreshToken = form.get("refresh_token") ?? "";
  if (!refreshToken.startsWith(REFRESH_PREFIX)) return null;
  return await rotateMcpOAuthRefreshToken(deps.db, {
    refreshTokenHash: tokenHash(refreshToken),
    ...input,
  });
}

function validateRedirectUri(value: string): string {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !loopback)) {
    throw new HTTPException(400, { message: "invalid public OAuth redirect URI" });
  }
  return url.toString();
}

function boundedState(value: string | null): string | null {
  if (value === null) return null;
  if (!value || new TextEncoder().encode(value).byteLength > 1_024) {
    throw new HTTPException(400, { message: "invalid OAuth state" });
  }
  return value;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1_000);
}

function authorizationRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function consentHtml(clientName: string, resource: McpOAuthResource, requestToken: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize OpenGeni tools</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#18181b}main{border:1px solid #e4e4e7;border-radius:16px;padding:2rem}code{word-break:break-all;background:#f4f4f5;padding:.15rem .35rem;border-radius:4px}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{border:0;border-radius:8px;padding:.7rem 1rem;font:inherit;cursor:pointer}.approve{background:#18181b;color:white}.deny{background:#e4e4e7}</style></head><body><main><h1>Authorize workspace tools</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting MCP access to this workspace.</p><p>Resource: <code>${escapeHtml(resource.resource)}</code></p><p>The grant is limited to the tools and permissions available now. OpenGeni rechecks live workspace authority on every request.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(requestToken)}"><div class="actions"><button class="approve" name="decision" value="approve">Authorize</button><button class="deny" name="decision" value="deny">Deny</button></div></form></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function oauthError(c: Context, error: string, status: 400 | 401) {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  return c.json({ error }, status);
}
