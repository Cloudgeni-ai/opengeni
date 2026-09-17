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
  type AccessContext,
  type AccessGrant,
  type ToolGatewayCatalog,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import {
  consumeMcpOAuthAuthorizationRequest,
  createMcpOAuthAuthorizationRequest,
  deleteMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  getManagedAccount,
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthClient,
  getWorkspace,
  listSharedWorkspacesForAccount,
  listWorkspacesForSubject,
  McpOAuthClientRegistrationRateLimitError,
  rebindMcpOAuthAuthorizationRequest,
  registerMcpOAuthClient,
  resolveLiveMcpOAuthGrant,
  resolveMcpOAuthAccessToken,
  rotateMcpOAuthRefreshToken,
} from "@opengeni/db";
import {
  hasPermission,
  requireAccessContext,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { trustedRequestSourceAddress } from "./http/request-source";
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
    let client;
    try {
      client = await registerMcpOAuthClient(deps.db, {
        clientId: opaque(CLIENT_PREFIX),
        redirectUris,
        clientName: parsed.data.client_name ?? null,
        grantTypes: parsed.data.grant_types,
        responseTypes: ["code"],
        registrationScopeHash: tokenHash(
          mcpOAuthRegistrationClientKey(c, deps.settings.mcpOauthTrustedProxyHops),
        ),
      });
    } catch (error) {
      if (error instanceof McpOAuthClientRegistrationRateLimitError) {
        c.header("retry-after", "600");
        return oauthError(c, "temporarily_unavailable", 429);
      }
      throw error;
    }
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
    const context = await requireAccessContext(c, deps);
    const workspaces = await listConsentWorkspaces(deps, context);
    if (workspaces.length === 0) {
      throw new HTTPException(403, { message: "no workspace is available for MCP OAuth" });
    }
    const selectedWorkspace =
      workspaces.find((workspace) => workspace.id === resource.workspaceId) ?? workspaces[0]!;
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      selectedWorkspace.id,
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
        toolIdentities: mcpOAuthConsentToolIdentities(prepared.toolGatewayCatalog),
        expiresAt: expiresIn(MCP_OAUTH_CONSENT_TTL_SECONDS),
      });
    } finally {
      await prepared.close();
    }
    const accounts = await consentAccountsForWorkspaces(deps, workspaces);
    c.header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    c.header("cache-control", "no-store");
    return c.html(
      renderMcpOAuthConsentPage({
        clientName: client.clientName ?? "MCP client",
        requestToken,
        accounts,
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          accountId: workspace.accountId,
          name: workspace.name,
          kind: workspace.kind,
        })),
        selectedWorkspaceId: grant.workspaceId,
      }),
    );
  });

  app.post("/oauth/authorize", async (c) => {
    requireMcpOAuthEnabled(deps);
    const form = new URLSearchParams(await c.req.text());
    const requestToken = form.get("request") ?? "";
    if (!requestToken.startsWith(REQUEST_PREFIX)) {
      return oauthAuthorizeBrowserError(
        c,
        "This authorization request is missing or already used.",
      );
    }
    const request = await getMcpOAuthAuthorizationRequest(deps.db, tokenHash(requestToken));
    if (!request) {
      return oauthAuthorizeBrowserError(
        c,
        "This authorization request expired or was already approved.",
      );
    }
    if (form.get("decision") !== "approve") {
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        request.workspaceId,
        "workspace:read",
      );
      if (requireWorkspaceToolGatewayAuthorization(authorization).subjectId !== request.subjectId) {
        throw new HTTPException(403, { message: "OAuth consent authority changed" });
      }
      await deleteMcpOAuthAuthorizationRequest(deps.db, request.requestHash);
      return completeAuthorizationRedirect(
        c,
        authorizationRedirect(request.redirectUri, {
          error: "access_denied",
          iss: mcpOAuthIssuer(deps),
          ...(request.state ? { state: request.state } : {}),
        }),
      );
    }
    const selectedWorkspaceId = form.get("workspace_id") || request.workspaceId;
    if (!isWorkspaceId(selectedWorkspaceId)) {
      return oauthAuthorizeBrowserError(c, "Choose a workspace before authorizing this client.");
    }
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      selectedWorkspaceId,
      "workspace:read",
    );
    const grant = requireWorkspaceToolGatewayAuthorization(authorization);
    if (grant.subjectId !== request.subjectId) {
      throw new HTTPException(403, {
        message: "OAuth consent authority changed",
      });
    }
    if (grant.workspaceId !== request.workspaceId || grant.accountId !== request.accountId) {
      const prepared = await prepareWorkspaceToolGateway(deps, authorization);
      try {
        const rebound = await rebindMcpOAuthAuthorizationRequest(deps.db, {
          requestHash: request.requestHash,
          subjectId: grant.subjectId,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          permissions: grant.permissions,
          toolIdentities: mcpOAuthConsentToolIdentities(prepared.toolGatewayCatalog),
        });
        if (!rebound) {
          return oauthAuthorizeBrowserError(
            c,
            "This authorization request expired or was already approved.",
          );
        }
      } finally {
        await prepared.close();
      }
    }
    const code = opaque(CODE_PREFIX);
    const consumed = await consumeMcpOAuthAuthorizationRequest(deps.db, {
      requestHash: request.requestHash,
      subjectId: grant.subjectId,
      codeHash: tokenHash(code),
      codeExpiresAt: expiresIn(MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
    });
    if (!consumed) {
      return oauthAuthorizeBrowserError(
        c,
        "This authorization request expired or was already approved.",
      );
    }
    return completeAuthorizationRedirect(
      c,
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
  // The client URL is the resource indicator. Consent may bind a different
  // workspace than the path UUID; the token grant is the authorized workspace.
  if (
    !access ||
    requestResource.workspaceId !== workspaceId ||
    access.resource !== requestResource.resource
  ) {
    throw new HTTPException(401, { message: "invalid MCP OAuth access token" });
  }
  const grant = await resolveLiveMcpOAuthGrant(deps.db, access);
  if (!grant)
    throw new HTTPException(401, {
      message: "MCP OAuth authority is no longer active",
    });
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

export function mcpOAuthConsentToolIdentities(catalog: ToolGatewayCatalog): ToolGatewayIdentity[] {
  return catalog.entries.map((entry) => entry.identity);
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
    throw new HTTPException(400, {
      message: "unsupported OAuth authorization request",
    });
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
    throw new HTTPException(400, {
      message: "OAuth redirect_uri is not registered",
    });
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
  for (const candidate of mcpOAuthRedirectUriCandidates(redirectUris, redirectUri)) {
    const access = await exchangeMcpOAuthAuthorizationCode(deps.db, {
      codeHash: tokenHash(code),
      clientId: input.clientId,
      redirectUri: candidate,
      resource: input.resource,
      codeChallenge: pkceChallenge(verifier),
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
    });
    if (access) return access;
  }
  return null;
}

export function mcpOAuthRedirectUriCandidates(registered: string[], requested: string): string[] {
  if (!registered.includes(requested)) return [];
  return [requested, ...registered.filter((uri) => uri !== requested)];
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

const BLOCKED_REDIRECT_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "file:",
  "about:",
  "blob:",
  "vbscript:",
]);

function isNativeAppRedirect(url: URL): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) &&
    !BLOCKED_REDIRECT_PROTOCOLS.has(url.protocol) &&
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    Boolean(url.hostname) &&
    url.pathname.startsWith("/") &&
    url.pathname !== "/"
  );
}

function validateRedirectUri(value: string): string {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !loopback && !isNativeAppRedirect(url))
  ) {
    throw new HTTPException(400, {
      message: "invalid public OAuth redirect URI",
    });
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

function mcpOAuthRegistrationClientKey(c: Context, trustedProxyHops: number): string {
  return `mcp-oauth-registration:${trustedRequestSourceAddress(c, trustedProxyHops)}`;
}

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1_000);
}

function authorizationRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function completeAuthorizationRedirect(c: Context, redirectTo: string) {
  c.header("cache-control", "no-store");
  const url = new URL(redirectTo);
  if (url.protocol === "http:" || url.protocol === "https:") {
    return c.redirect(redirectTo);
  }
  c.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  c.header("refresh", `0;url=${redirectTo}`);
  return c.html(renderMcpOAuthContinuePage(redirectTo));
}

function oauthAuthorizeBrowserError(c: Context, message: string) {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  c.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  return c.html(renderMcpOAuthExpiredPage(message), 400);
}

export type McpOAuthConsentAccount = {
  id: string;
  name: string;
};

export type McpOAuthConsentWorkspace = {
  id: string;
  accountId: string;
  name: string;
  kind: "personal" | "shared";
};

export function renderMcpOAuthConsentPage(input: {
  clientName: string;
  requestToken: string;
  accounts: McpOAuthConsentAccount[];
  workspaces: McpOAuthConsentWorkspace[];
  selectedWorkspaceId: string;
}): string {
  const selectedWorkspace =
    input.workspaces.find((workspace) => workspace.id === input.selectedWorkspaceId) ??
    input.workspaces[0];
  if (!selectedWorkspace) {
    throw new Error("MCP OAuth consent requires at least one workspace");
  }
  const selectedAccountId = selectedWorkspace.accountId;
  const accountOptions = input.accounts
    .map(
      (account) =>
        `<option value="${escapeHtml(account.id)}"${account.id === selectedAccountId ? " selected" : ""}>${escapeHtml(account.name)}</option>`,
    )
    .join("");
  const workspaceOptions = input.workspaces
    .filter((workspace) => workspace.accountId === selectedAccountId)
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.id)}"${workspace.id === selectedWorkspace.id ? " selected" : ""}>${escapeHtml(consentWorkspaceLabel(workspace))}</option>`,
    )
    .join("");
  const workspacePayload = input.workspaces.map((workspace) => ({
    id: workspace.id,
    accountId: workspace.accountId,
    label: consentWorkspaceLabel(workspace),
  }));
  const body = `<p class="lede"><strong>${escapeHtml(input.clientName)}</strong> wants MCP access to the organization and workspace you choose.</p>
<form method="post" action="/oauth/authorize" onsubmit="this.querySelectorAll('button').forEach(function(button){button.disabled=true})">
<input type="hidden" name="request" value="${escapeHtml(input.requestToken)}">
<label class="field"><span>Organization</span><select id="organization" name="organization" autocomplete="off">${accountOptions}</select></label>
<label class="field"><span>Workspace</span><select id="workspace_id" name="workspace_id" autocomplete="off">${workspaceOptions}</select></label>
<p class="note">The grant is limited to tools available in the workspace you authorize. OpenGeni rechecks live authority on every request.</p>
<div class="actions"><button class="approve" name="decision" value="approve">Authorize</button><button class="deny" name="decision" value="deny">Deny</button></div>
</form>
<script type="application/json" id="mcp-oauth-workspaces">${jsonForScript(workspacePayload)}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("mcp-oauth-workspaces").textContent);
  var account = document.getElementById("organization");
  var workspace = document.getElementById("workspace_id");
  function sync() {
    var selected = workspace.value;
    var items = data.filter(function (item) { return item.accountId === account.value; });
    workspace.replaceChildren();
    items.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      workspace.appendChild(option);
    });
    if (items.some(function (item) { return item.id === selected; })) workspace.value = selected;
  }
  account.addEventListener("change", sync);
})();
</script>`;
  return oauthDocument({
    title: "Authorize MCP access",
    heading: "Authorize this client",
    body,
  });
}

export function renderMcpOAuthContinuePage(redirectTo: string): string {
  return oauthDocument({
    title: "Returning to the app",
    heading: "Returning to the app",
    head: `<meta http-equiv="refresh" content="0;url=${escapeHtml(redirectTo)}">`,
    body: `<p class="lede">Authorization succeeded. You can close this window.</p><script>(function (url) { try { location.replace(url); } catch (error) {} try { location.href = url; } catch (error) {} var frame = document.createElement("iframe"); frame.src = url; frame.style.display = "none"; document.body.appendChild(frame); })(${JSON.stringify(redirectTo)});</script>`,
  });
}

export function renderMcpOAuthExpiredPage(message: string): string {
  return oauthDocument({
    title: "Authorization expired",
    heading: "Authorization expired",
    body: `<p class="lede">${escapeHtml(message)}</p><p class="note">Close this window and start authorization again from the client.</p>`,
  });
}

async function listConsentWorkspaces(deps: ApiRouteDeps, context: AccessContext) {
  const readableWorkspaceIds = [
    ...new Set(
      context.workspaceGrants
        .filter((grant) => hasPermission(grant.permissions, "workspace:read"))
        .map((grant) => grant.workspaceId),
    ),
  ];
  const readableAccountIds = context.accountGrants
    .filter((grant) => hasPermission(grant.permissions, "workspace:read"))
    .map((grant) => grant.accountId);
  const [fromGrants, memberships, shared] = await Promise.all([
    Promise.all(readableWorkspaceIds.map((workspaceId) => getWorkspace(deps.db, workspaceId))),
    listWorkspacesForSubject(deps.db, context.subjectId),
    Promise.all(
      readableAccountIds.map((accountId) => listSharedWorkspacesForAccount(deps.db, accountId)),
    ),
  ]);
  const byId = new Map<string, NonNullable<(typeof fromGrants)[number]>>();
  for (const workspace of [...fromGrants, ...memberships, ...shared.flat()]) {
    if (workspace) byId.set(workspace.id, workspace);
  }
  return [...byId.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

async function consentAccountsForWorkspaces(
  deps: ApiRouteDeps,
  workspaces: Array<{ accountId: string }>,
): Promise<McpOAuthConsentAccount[]> {
  const accountIds = [...new Set(workspaces.map((workspace) => workspace.accountId))];
  return (
    await Promise.all(
      accountIds.map(async (accountId) => {
        const account = await getManagedAccount(deps.db, accountId);
        return { id: accountId, name: account?.name.trim() || "Organization" };
      }),
    )
  ).toSorted((left, right) => left.name.localeCompare(right.name));
}

function consentWorkspaceLabel(workspace: McpOAuthConsentWorkspace): string {
  const name = workspace.name.trim() || "Workspace";
  return workspace.kind === "personal" ? `${name} (Personal)` : name;
}

function isWorkspaceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function oauthDocument(input: {
  title: string;
  heading: string;
  body: string;
  head?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title>${input.head ?? ""}<style>${OAUTH_PAGE_CSS}</style></head><body><main><p class="mark">OpenGeni</p><h1>${escapeHtml(input.heading)}</h1>${input.body}</main></body></html>`;
}

const OAUTH_PAGE_CSS =
  'html,body{margin:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}main{width:min(100%,28rem);background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:24px}h1{margin:8px 0 0;font-size:22px;line-height:1.3;font-weight:650}p{margin:12px 0 0}strong{font-weight:600}.mark{margin:0;font-size:12px;font-weight:600;color:#71717a}.lede,.note{color:#52525b}.field{display:flex;flex-direction:column;gap:6px;margin-top:16px;font-size:13px;color:#71717a}select{width:100%;border:1px solid #e4e4e7;border-radius:10px;background:#f4f4f5;color:#18181b;padding:10px 12px;font:inherit}.actions{display:flex;gap:12px;margin-top:20px}button{flex:1;min-height:40px;border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}.approve{background:#18181b;color:#fff}.deny{background:#fff;color:#18181b;border:1px solid #e4e4e7}button:disabled{opacity:0.6;cursor:wait}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#3f3f46}h1{color:#fafafa}.mark{color:#a1a1aa}.lede,.note{color:#a1a1aa}select{background:#27272a;border-color:#3f3f46;color:#fafafa}.approve{background:#fafafa;color:#18181b}.deny{background:#27272a;color:#fafafa;border-color:#3f3f46}}';

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function oauthError(c: Context, error: string, status: 400 | 401 | 429) {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  return c.json({ error }, status);
}
