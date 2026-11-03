import {
  CheckMcpTrustedIssuerRequest,
  CheckMcpTrustedIssuerResponse,
  CheckOrganizationConnectorAutoConnectRequest,
  AutoConnectSupport,
  CreateMcpTrustedIssuerRequest,
  ID_JAG_CLOCK_SKEW_SECONDS,
  ID_JAG_GRANT_PROFILE,
  ID_JAG_JWT_TYPE,
  ID_JAG_MAX_ACCEPTED_LIFETIME_SECONDS,
  JWT_BEARER_GRANT_TYPE,
  ListMcpTrustedIssuerEventsResponse,
  ListMcpTrustedIssuersResponse,
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  MCP_OAUTH_SCOPE,
  McpOAuthTokenResponse,
  McpTrustedIssuer,
  TestOrganizationConnectorAutoConnectResponse,
  UpdateMcpTrustedIssuerRequest,
  type McpAutoConnectRefusalReason,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import { assertPersonalConnectionOwnerPrincipal } from "./connection-ownership";
import {
  createMcpTrustedIssuer,
  deleteMcpTrustedIssuer,
  findActiveMcpTrustedIssuers,
  getMcpOAuthClient,
  getOrganizationIdentityIssuerKey,
  getWorkspace,
  listMcpTrustedIssuerEvents,
  listMcpTrustedIssuers,
  matchMcpAssertionMember,
  McpTrustedIssuerExistsError,
  nestedPostgresSqlState,
  organizationIdentityIssuerUrl,
  organizationIdentityJwksUrl,
  recordMcpTrustedIssuerRefusal,
  redeemMcpAssertion,
  updateMcpTrustedIssuer,
  upsertMcpOAuthMetadataDocumentClient,
  type McpOAuthClient,
  type McpOAuthGrantType,
  type McpTrustedIssuerEventRecord,
  type McpTrustedIssuerRecord,
  type McpTrustedIssuerSummary,
} from "@opengeni/db";
import {
  accountScopedApiKeyWorkspaceAuthority,
  checkOrganizationConnectorAutoConnect,
  connectMemberToOrganizationConnector,
  requireAccessContext,
  requireAccessGrantAuthorization,
  testOrganizationConnectorAutoConnect,
  type ApiRouteDeps,
} from "@opengeni/core";
import { pinnedFetch, readResponseJsonBounded } from "@opengeni/network";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { z } from "zod";
import { parseRequestBody } from "./http/request-body";
import { authorizeOrganizationIntegrationAdministration } from "./routes/organization-integration-policy";

/* ----------------------------------------------------------------------------
   MCP auto-connect (docs/mcp-surfaces.md, "Auto-connect").

   Inbound: an MCP client (Claude among them) redeems an ID-JAG at
   /oauth/token with the RFC 7523 JWT bearer grant. The issuer that signed it
   must be one an organization trusts; the person it names is matched to an
   active member and connected to the organization MCP server with the
   issuer's access setting. Clients identify themselves with a Client ID
   Metadata Document URL (or a registered client ID).

   Outbound: Opengeni is the organization's issuer. Its discovery document
   and key set are public, so an outside app can check the ID-JAGs Opengeni
   signs for the organization's members.
   -------------------------------------------------------------------------- */

const SUPPORTED_ALGORITHMS = ["ES256", "RS256"] as const;
const DISCOVERY_TTL_MS = 60 * 60_000;
const KEYS_TTL_MS = 10 * 60_000;
/** An unknown key ID refetches the key set at most this often per issuer. */
const KEYS_REFETCH_MIN_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_CACHED_ISSUERS = 500;
const CLIENT_METADATA_DOCUMENT_TTL_MS = 24 * 60 * 60_000;

export type McpAutoConnectHelpers = {
  issuer: (deps: ApiRouteDeps) => string;
  organizationResource: (deps: ApiRouteDeps) => string;
  accessToken: () => string;
  tokenHash: (value: string) => string;
  validateRedirectUri: (value: string) => string;
  oauthError: (
    c: Context,
    error: string,
    status: 400 | 401 | 429,
    description?: string,
  ) => Response;
};

/* ------------------------------ Issuer keys ------------------------------ */

type CachedKeys = { keys: JSONWebKeySet; fetchedAt: number; jwksUri: string };
const discoveryCache = new Map<string, { jwksUri: string; fetchedAt: number }>();
const keysCache = new Map<string, CachedKeys>();

/** Tests only. */
export function resetMcpAutoConnectCaches(): void {
  discoveryCache.clear();
  keysCache.clear();
  metadataDocumentFetchedAt.clear();
}

class IssuerKeysUnavailableError extends Error {
  readonly name = "IssuerKeysUnavailableError";
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (!cache.has(key) && cache.size >= MAX_CACHED_ISSUERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

async function fetchJson(
  deps: ApiRouteDeps,
  url: string,
  label: string,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  // A test transport answers for any host; production traffic is pinned to
  // public addresses and never follows redirects.
  const response = deps.mcpAutoConnectFetch
    ? await deps.mcpAutoConnectFetch(url, init)
    : await pinnedFetch(url, init, deps.settings, {
        label,
        requireHttpsOutsideLocalTest: true,
      });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: null };
  }
  return {
    status: response.status,
    body: await readResponseJsonBounded<unknown>(response, MAX_DOCUMENT_BYTES, label),
  };
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The issuer's discovery documents, tried in the usual order: OpenID
 * Connect discovery, then RFC 8414 (path-appended, then path-inserted).
 */
function discoveryUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/u, "");
  const urls = [
    `${url.origin}${path}/.well-known/openid-configuration`,
    `${url.origin}${path}/.well-known/oauth-authorization-server`,
  ];
  if (path) urls.push(`${url.origin}/.well-known/oauth-authorization-server${path}`);
  return urls;
}

/** Where an issuer publishes its keys: its discovery document's `jwks_uri`. */
async function discoverJwksUri(deps: ApiRouteDeps, issuer: string): Promise<string> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.jwksUri;
  let mismatched = false;
  for (const url of discoveryUrls(issuer)) {
    let result: { status: number; body: unknown };
    try {
      result = await fetchJson(deps, url, "Issuer discovery");
    } catch {
      continue;
    }
    const document = objectBody(result.body);
    if (!document) continue;
    if (document.issuer !== issuer) {
      mismatched = true;
      continue;
    }
    const jwksUri = typeof document.jwks_uri === "string" ? document.jwks_uri : null;
    if (!jwksUri || !isHttpsOrLocal(deps, jwksUri))
      throw new IssuerKeysUnavailableError("The issuer's discovery document has no key set URL");
    remember(discoveryCache, issuer, { jwksUri, fetchedAt: Date.now() });
    return jwksUri;
  }
  throw new IssuerKeysUnavailableError(
    mismatched
      ? "The issuer's discovery document names a different issuer. Check the URL."
      : "Couldn't find the issuer's discovery document. Check the URL.",
  );
}

async function fetchKeys(deps: ApiRouteDeps, jwksUri: string): Promise<JSONWebKeySet> {
  let result: { status: number; body: unknown };
  try {
    result = await fetchJson(deps, jwksUri, "Issuer key set");
  } catch {
    throw new IssuerKeysUnavailableError("Couldn't reach the issuer's key set");
  }
  const document = objectBody(result.body);
  const keys = document && Array.isArray(document.keys) ? document.keys : null;
  if (!keys) throw new IssuerKeysUnavailableError("The issuer's key set couldn't be read");
  const usable = keys.filter(
    (key): key is JSONWebKeySet["keys"][number] =>
      !!objectBody(key) &&
      ((key as { kty?: unknown }).kty === "EC" || (key as { kty?: unknown }).kty === "RSA") &&
      (key as { use?: unknown }).use !== "enc",
  );
  if (usable.length === 0)
    throw new IssuerKeysUnavailableError("The issuer publishes no signing keys Opengeni can use");
  return { keys: usable };
}

/** The issuer's keys, from cache unless stale or missing `kid`. */
async function issuerKeys(
  deps: ApiRouteDeps,
  source: { issuer: string; jwksUri: string | null },
  kid: string | undefined,
): Promise<JSONWebKeySet> {
  const cacheKey = `${source.issuer}\u0000${source.jwksUri ?? ""}`;
  const cached = keysCache.get(cacheKey);
  const now = Date.now();
  const fresh = cached && now - cached.fetchedAt < KEYS_TTL_MS;
  const knowsKid = !kid || !!cached?.keys.keys.some((key) => key.kid === kid);
  if (cached && fresh && (knowsKid || now - cached.fetchedAt < KEYS_REFETCH_MIN_MS))
    return cached.keys;
  const jwksUri = source.jwksUri ?? (await discoverJwksUri(deps, source.issuer));
  const keys = await fetchKeys(deps, jwksUri);
  remember(keysCache, cacheKey, { keys, fetchedAt: now, jwksUri });
  return keys;
}

function isHttpsOrLocal(deps: ApiRouteDeps, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (deps.settings.environment === "local" || deps.settings.environment === "test")
    );
  } catch {
    return false;
  }
}

/* --------------------- Clients: registered or by document --------------------- */

const metadataDocumentFetchedAt = new Map<string, number>();

/** A Client ID Metadata Document URL: https, with a path, and nothing else. */
export function isClientMetadataDocumentUrl(value: string): boolean {
  if (value.length < 16 || value.length > 256) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname !== "/" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.pathname.split("/").some((segment) => segment === "." || segment === "..")
    );
  } catch {
    return false;
  }
}

const KNOWN_GRANT_TYPES = new Set<McpOAuthGrantType>([
  "authorization_code",
  "refresh_token",
  JWT_BEARER_GRANT_TYPE,
]);

/**
 * The OAuth client a request names: one registered here, or one identified by
 * its Client ID Metadata Document, fetched and stored (and fetched again a day
 * later, or when it lacks the redirect URI a request uses).
 */
export async function resolveMcpOAuthClient(
  deps: ApiRouteDeps,
  helpers: Pick<McpAutoConnectHelpers, "validateRedirectUri">,
  clientId: string,
  options: { redirectUri?: string | null } = {},
): Promise<McpOAuthClient | null> {
  const stored = await getMcpOAuthClient(deps.db, clientId);
  if (!isClientMetadataDocumentUrl(clientId)) return stored;
  const fetchedAt = metadataDocumentFetchedAt.get(clientId) ?? 0;
  const needsRedirect =
    !!options.redirectUri && !!stored && !stored.redirectUris.includes(options.redirectUri);
  if (stored && !needsRedirect && Date.now() - fetchedAt < CLIENT_METADATA_DOCUMENT_TTL_MS)
    return stored;
  if (stored && needsRedirect && Date.now() - fetchedAt < KEYS_REFETCH_MIN_MS) return stored;
  let document: Record<string, unknown> | null;
  try {
    document = objectBody((await fetchJson(deps, clientId, "Client metadata document")).body);
  } catch {
    return stored;
  }
  remember(metadataDocumentFetchedAt, clientId, Date.now());
  if (!document || document.client_id !== clientId) return stored;
  // Opengeni authenticates no client: one that says it authenticates (a
  // secret or a signed key) is refused rather than let in without it.
  const authMethod = document.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") return null;
  const redirectUris: string[] = [];
  for (const value of Array.isArray(document.redirect_uris) ? document.redirect_uris : []) {
    if (typeof value !== "string" || redirectUris.length >= 16) continue;
    try {
      redirectUris.push(helpers.validateRedirectUri(value));
    } catch {
      continue;
    }
  }
  const declared = Array.isArray(document.grant_types)
    ? document.grant_types.filter(
        (value): value is McpOAuthGrantType =>
          typeof value === "string" && KNOWN_GRANT_TYPES.has(value as McpOAuthGrantType),
      )
    : ["authorization_code" as const];
  const grantTypes = [...new Set(declared)].filter(
    // A client with nowhere to return can't use the authorization code grant.
    (grant) => redirectUris.length > 0 || grant !== "authorization_code",
  );
  const clientName =
    typeof document.client_name === "string" && document.client_name.trim()
      ? document.client_name.trim().slice(0, 200)
      : null;
  return await upsertMcpOAuthMetadataDocumentClient(deps.db, {
    clientId,
    // The table needs one; without authorization_code it is never used.
    redirectUris: redirectUris.length > 0 ? redirectUris : [clientId],
    clientName,
    grantTypes: grantTypes.length > 0 ? grantTypes : [JWT_BEARER_GRANT_TYPE],
  });
}

/**
 * A client the issuer vouches for by signing its ID (an app the issuer
 * registered itself, such as Claude's own client): stored for the connection,
 * usable only with the JWT bearer grant.
 */
async function vouchedClient(deps: ApiRouteDeps, clientId: string): Promise<McpOAuthClient | null> {
  if (clientId.length < 16 || clientId.length > 256 || clientId.startsWith("ogmcp_")) return null;
  return await upsertMcpOAuthMetadataDocumentClient(deps.db, {
    clientId,
    redirectUris: ["https://invalid.invalid/no-redirect"],
    clientName: null,
    grantTypes: [JWT_BEARER_GRANT_TYPE],
  });
}

/* ----------------------------- Redeeming an ID-JAG ----------------------------- */

class AssertionRefused extends Error {
  constructor(
    readonly reason: McpAutoConnectRefusalReason,
    readonly description: string,
    readonly oauthCode: "invalid_grant" | "invalid_client" | "invalid_target" = "invalid_grant",
  ) {
    super(description);
  }
}

function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function stringClaim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameResource(value: string, expected: string): boolean {
  return value.replace(/\/$/u, "") === expected;
}

/**
 * `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`: validates the
 * ID-JAG and answers with an access token, never a refresh token.
 */
export async function redeemIdJagGrant(
  c: Context,
  deps: ApiRouteDeps,
  helpers: McpAutoConnectHelpers,
  form: URLSearchParams,
): Promise<Response> {
  const assertion = form.get("assertion") ?? "";
  const fail = (error: AssertionRefused) =>
    helpers.oauthError(
      c,
      error.oauthCode,
      error.oauthCode === "invalid_client" ? 401 : 400,
      error.description,
    );
  let header: ReturnType<typeof decodeProtectedHeader>;
  let claims: JWTPayload;
  try {
    if (!assertion || assertion.length > 16_384) throw new Error("missing");
    header = decodeProtectedHeader(assertion);
    claims = decodeJwt(assertion);
  } catch {
    return fail(new AssertionRefused("malformed", "The assertion is not a JWT"));
  }
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  const trusts = issuer ? await findActiveMcpTrustedIssuers(deps.db, issuer) : [];
  const tenant = stringClaim(claims, "aud_tenant") ?? stringClaim(claims, "tenant");
  const candidates = tenant
    ? trusts.filter((trust) => trust.accountId === tenant.toLowerCase())
    : trusts;
  if (candidates.length === 0)
    return fail(
      new AssertionRefused(
        "issuer_disabled",
        tenant
          ? "No Opengeni organization with that tenant ID trusts this issuer"
          : "No Opengeni organization trusts this issuer",
      ),
    );
  const requestClientId = form.get("client_id");
  const claimedClientId = stringClaim(claims, "client_id");
  const clientId = requestClientId ?? claimedClientId;
  const email = stringClaim(claims, "email")?.toLowerCase().slice(0, 320) ?? null;
  const refuse = async (trust: McpTrustedIssuerRecord, error: AssertionRefused) => {
    await recordMcpTrustedIssuerRefusal(deps.db, {
      accountId: trust.accountId,
      trustedIssuerId: trust.id,
      reason: error.reason,
      email,
      clientId,
      clientName: null,
    }).catch(() => undefined);
    return fail(error);
  };
  // Signature first: nothing unverified is acted on or recorded beyond this.
  const keySource = {
    issuer,
    jwksUri: candidates.every((trust) => trust.jwksUri === candidates[0]!.jwksUri)
      ? candidates[0]!.jwksUri
      : null,
  };
  const only = candidates.length === 1 ? candidates[0]! : null;
  const refuseUnverified = async (error: AssertionRefused) =>
    only ? await refuse(only, error) : fail(error);
  if (header.typ?.toLowerCase() !== ID_JAG_JWT_TYPE)
    return await refuseUnverified(
      new AssertionRefused("wrong_type", `The assertion's typ must be ${ID_JAG_JWT_TYPE}`),
    );
  if (!SUPPORTED_ALGORITHMS.includes(header.alg as (typeof SUPPORTED_ALGORITHMS)[number]))
    return await refuseUnverified(
      new AssertionRefused("signature_invalid", "The assertion must be signed with ES256 or RS256"),
    );
  let payload: JWTPayload;
  try {
    const keys = await issuerKeys(deps, keySource, header.kid);
    ({ payload } = await jwtVerify(assertion, createLocalJWKSet(keys), {
      algorithms: [...SUPPORTED_ALGORITHMS],
      issuer,
      clockTolerance: ID_JAG_CLOCK_SKEW_SECONDS,
      requiredClaims: ["exp", "iat"],
    }));
  } catch (error) {
    if (error instanceof IssuerKeysUnavailableError)
      return await refuseUnverified(new AssertionRefused("keys_unavailable", error.message));
    if (error instanceof joseErrors.JWTExpired)
      return await refuseUnverified(new AssertionRefused("expired", "The assertion has expired"));
    if (error instanceof joseErrors.JWTClaimValidationFailed)
      return await refuseUnverified(
        new AssertionRefused(
          error.claim === "nbf" ? "expired" : "malformed",
          `The assertion's ${error.claim} claim is invalid`,
        ),
      );
    return await refuseUnverified(
      new AssertionRefused("signature_invalid", "The assertion's signature doesn't verify"),
    );
  }
  if (!only) {
    for (const trust of candidates.slice(0, 10))
      await recordMcpTrustedIssuerRefusal(deps.db, {
        accountId: trust.accountId,
        trustedIssuerId: trust.id,
        reason: "several_organizations",
        email,
        clientId,
        clientName: null,
      }).catch(() => undefined);
    return fail(
      new AssertionRefused(
        "several_organizations",
        "Several Opengeni organizations trust this issuer; set the tenant ID to your organization ID",
      ),
    );
  }
  const trust = only;
  const ourIssuer = helpers.issuer(deps);
  const resource = helpers.organizationResource(deps);
  try {
    const aud = audiences(payload.aud);
    if (aud.length !== 1 || aud[0]!.replace(/\/$/u, "") !== ourIssuer)
      throw new AssertionRefused("wrong_audience", `The assertion's audience must be ${ourIssuer}`);
    const requestedResource = form.get("resource");
    const claimedResources = audiences(payload.resource);
    if (
      (requestedResource !== null && !sameResource(requestedResource, resource)) ||
      claimedResources.some((value) => !sameResource(value, resource))
    )
      throw new AssertionRefused(
        "wrong_resource",
        `Auto-connect reaches ${resource} only`,
        "invalid_target",
      );
    if (!claimedClientId || !clientId || claimedClientId !== clientId)
      throw new AssertionRefused(
        "client_mismatch",
        "The assertion's client_id doesn't match the requesting client",
      );
    if (trust.allowedClientIds && !trust.allowedClientIds.includes(clientId))
      throw new AssertionRefused(
        "client_not_allowed",
        "This organization doesn't allow this app to connect automatically",
      );
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const jti = typeof payload.jti === "string" ? payload.jti.trim() : "";
    if (!subject || subject.length > 1024 || !jti || jti.length > 512)
      throw new AssertionRefused("malformed", "The assertion needs sub and jti claims");
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      payload.iat! > nowSeconds + ID_JAG_CLOCK_SKEW_SECONDS ||
      payload.exp! - payload.iat! > ID_JAG_MAX_ACCEPTED_LIFETIME_SECONDS
    )
      throw new AssertionRefused("malformed", "The assertion's lifetime is too long");
    const emailVerified = payload.email_verified;
    const usableEmail =
      emailVerified === false || emailVerified === "false"
        ? null
        : (stringClaim(payload, "email")?.toLowerCase() ?? null);
    const match = await matchMcpAssertionMember(deps.db, {
      accountId: trust.accountId,
      email: usableEmail,
    });
    if (match.status !== "matched")
      throw usableEmail === null && stringClaim(payload, "email")
        ? new AssertionRefused("email_unverified", "The issuer says this email is not verified")
        : new AssertionRefused(
            "no_matching_member",
            "No active member of this organization has that verified email",
          );
    const client =
      (await resolveMcpOAuthClient(deps, helpers, clientId)) ??
      (isClientMetadataDocumentUrl(clientId) ? null : await vouchedClient(deps, clientId));
    if (!client)
      throw new AssertionRefused(
        "unknown_client",
        "The client's metadata document couldn't be read",
        "invalid_client",
      );
    const accessToken = helpers.accessToken();
    const redeemed = await redeemMcpAssertion(deps.db, {
      trust,
      subjectId: match.subjectId,
      assertionSubject: subject,
      email: usableEmail,
      jti,
      assertionExpiresAt: new Date(payload.exp! * 1000 + ID_JAG_CLOCK_SKEW_SECONDS * 1000),
      clientId,
      clientName: client.clientName,
      resource,
      accessTokenHash: helpers.tokenHash(accessToken),
      accessExpiresAt: new Date(Date.now() + MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000),
      connectionExpiresAt: new Date(Date.now() + MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
    if (redeemed.status === "refused")
      throw new AssertionRefused(
        redeemed.reason,
        redeemed.reason === "replayed"
          ? "This assertion was already used"
          : redeemed.reason === "issuer_disabled"
            ? "This issuer was turned off"
            : "No active member of this organization matches",
      );
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    return c.json(
      McpOAuthTokenResponse.parse({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        scope: MCP_OAUTH_SCOPE,
      }),
    );
  } catch (error) {
    if (error instanceof AssertionRefused) return await refuse(trust, error);
    throw error;
  }
}

/* ------------------------- Outbound: Opengeni's issuer ------------------------- */

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The organization's issuer paths, all public: they describe a public key. */
export function isOrganizationIdentityIssuerPublicPath(pathname: string): boolean {
  const match =
    pathname.match(
      /^\/v1\/organizations\/([^/]+)\/identity\/(?:\.well-known\/(?:openid-configuration|oauth-authorization-server)|jwks\.json)$/u,
    ) ??
    pathname.match(
      /^\/\.well-known\/oauth-authorization-server\/v1\/organizations\/([^/]+)\/identity$/u,
    );
  return !!match && ORGANIZATION_ID.test(match[1]!.toLowerCase());
}

function registerIdentityIssuerRoutes(app: Hono, deps: ApiRouteDeps): void {
  const issuerKey = async (c: Context) => {
    const accountId = (c.req.param("organizationId") ?? "").toLowerCase();
    if (!ORGANIZATION_ID.test(accountId) || !deps.settings.publicBaseUrl)
      throw new HTTPException(404, { message: "not found" });
    const key = await getOrganizationIdentityIssuerKey(deps.db, accountId);
    if (!key) throw new HTTPException(404, { message: "not found" });
    return { accountId, key, publicBaseUrl: deps.settings.publicBaseUrl };
  };
  const metadata = async (c: Context) => {
    const { accountId, key, publicBaseUrl } = await issuerKey(c);
    c.header("cache-control", "public, max-age=300");
    return c.json({
      issuer: organizationIdentityIssuerUrl(publicBaseUrl, accountId),
      jwks_uri: organizationIdentityJwksUrl(publicBaseUrl, accountId),
      id_token_signing_alg_values_supported: [key.algorithm],
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      subject_types_supported: ["public"],
      response_types_supported: [],
    });
  };
  const base = "/v1/organizations/:organizationId/identity";
  app.get(`${base}/.well-known/openid-configuration`, metadata);
  app.get(`${base}/.well-known/oauth-authorization-server`, metadata);
  app.get(`/.well-known/oauth-authorization-server${base}`, metadata);
  app.get(`${base}/jwks.json`, async (c) => {
    const { key } = await issuerKey(c);
    c.header("cache-control", "public, max-age=300");
    return c.json({ keys: [{ ...key.publicJwk, kid: key.keyId, alg: key.algorithm, use: "sig" }] });
  });
}

/* --------------------------- Administration routes --------------------------- */

async function authorizeAdministration(
  c: Context,
  deps: ApiRouteDeps,
  mutation: boolean,
): Promise<{ accountId: string; subjectId: string }> {
  const parsed = z.string().uuid().safeParse(c.req.param("organizationId"));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid organization identity" });
  const accountId = parsed.data.toLowerCase();
  if (accountScopedApiKeyWorkspaceAuthority(await requireAccessContext(c, deps)))
    throw new HTTPException(403, {
      message: "Auto-connect is managed by organization owners and admins",
    });
  return await authorizeOrganizationIntegrationAdministration(c, deps, accountId, mutation);
}

async function administrationResponse<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof McpTrustedIssuerExistsError)
      throw new HTTPException(409, { message: "Your organization already trusts this issuer" });
    const state = nestedPostgresSqlState(error);
    if (state === "42501")
      throw new HTTPException(403, { message: "Organization administration required" });
    throw error;
  }
}

async function requireOrganizationWorkspaces(
  deps: ApiRouteDeps,
  accountId: string,
  access: OrganizationAccessPolicy | undefined,
): Promise<void> {
  if (access?.workspaceScope.kind !== "selected") return;
  for (const workspaceId of access.workspaceScope.workspaceIds) {
    const workspace = await getWorkspace(deps.db, workspaceId);
    if (workspace?.accountId !== accountId)
      throw new HTTPException(422, { message: "A selected workspace is not in this organization" });
  }
}

function trustedIssuerView(summary: McpTrustedIssuerSummary): McpTrustedIssuer {
  return McpTrustedIssuer.parse({
    id: summary.id,
    organizationId: summary.accountId,
    name: summary.name,
    provider: summary.provider,
    issuer: summary.issuer,
    jwksUri: summary.jwksUri,
    allowedClientIds: summary.allowedClientIds,
    access: summary.organizationAccess,
    status: summary.status,
    connectedPeople: summary.connectedPeople,
    lastConnectedAt: summary.lastConnectedAt?.toISOString() ?? null,
    lastRefusal: summary.lastRefusal
      ? { reason: summary.lastRefusal.reason, at: summary.lastRefusal.at.toISOString() }
      : null,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  });
}

function eventView(event: McpTrustedIssuerEventRecord) {
  return {
    id: event.id,
    outcome: event.outcome,
    reason: event.reason,
    person: event.subjectId
      ? { subjectId: event.subjectId, name: event.personName ?? event.email ?? "Someone" }
      : null,
    email: event.email,
    clientName: event.clientName,
    at: event.createdAt.toISOString(),
  };
}

/** Looks an issuer up the way the token endpoint will: its keys must load. */
export async function checkMcpTrustedIssuer(
  deps: ApiRouteDeps,
  input: { issuer: string; jwksUri: string | null },
): Promise<CheckMcpTrustedIssuerResponse> {
  try {
    const jwksUri = input.jwksUri ?? (await discoverJwksUri(deps, input.issuer));
    const keys = await fetchKeys(deps, jwksUri);
    remember(keysCache, `${input.issuer}\u0000${input.jwksUri ?? ""}`, {
      keys,
      fetchedAt: Date.now(),
      jwksUri,
    });
    const algorithms = [
      ...new Set(keys.keys.map((key) => key.alg ?? (key.kty === "EC" ? "ES256" : "RS256"))),
    ];
    return { status: "ok", issuer: input.issuer, jwksUri, keyCount: keys.keys.length, algorithms };
  } catch (error) {
    return {
      status: "failed",
      issuer: input.issuer,
      message:
        error instanceof IssuerKeysUnavailableError
          ? error.message
          : "Couldn't reach the issuer. Check the URL.",
    };
  }
}

function trustedIssuerId(c: Context): string {
  const parsed = z.string().uuid().safeParse(c.req.param("trustedIssuerId"));
  if (!parsed.success) throw new HTTPException(404, { message: "Trusted issuer not found" });
  return parsed.data.toLowerCase();
}

function registerTrustedIssuerRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  helpers: McpAutoConnectHelpers,
): void {
  const path = "/v1/organizations/:organizationId/mcp-trusted-issuers";
  const enabled = () => {
    if (!deps.settings.mcpOauthEnabled || !deps.settings.publicBaseUrl)
      throw new HTTPException(404, { message: "Auto-connect is not available here" });
  };

  app.get(path, async (c) => {
    enabled();
    c.header("cache-control", "private, no-store");
    const actor = await authorizeAdministration(c, deps, false);
    const summaries = await administrationResponse(() =>
      listMcpTrustedIssuers(deps.db, { accountId: actor.accountId }, async () => actor),
    );
    return c.json(
      ListMcpTrustedIssuersResponse.parse({
        trustedIssuers: summaries.map(trustedIssuerView),
        mcpUrl: helpers.organizationResource(deps),
        audience: helpers.issuer(deps),
      }),
    );
  });

  app.post(`${path}/check`, async (c) => {
    enabled();
    c.header("cache-control", "private, no-store");
    await authorizeAdministration(c, deps, true);
    const payload = parseRequestBody(
      CheckMcpTrustedIssuerRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "Enter the issuer's https URL" },
    );
    return c.json(
      CheckMcpTrustedIssuerResponse.parse(
        await checkMcpTrustedIssuer(deps, {
          issuer: payload.issuer,
          jwksUri: payload.jwksUri ?? null,
        }),
      ),
    );
  });

  app.post(path, async (c) => {
    enabled();
    c.header("cache-control", "private, no-store");
    const actor = await authorizeAdministration(c, deps, true);
    const payload = parseRequestBody(
      CreateMcpTrustedIssuerRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "Invalid trusted issuer" },
    );
    await requireOrganizationWorkspaces(deps, actor.accountId, payload.access);
    const created = await administrationResponse(() =>
      createMcpTrustedIssuer(
        deps.db,
        { accountId: actor.accountId },
        {
          name: payload.name,
          provider: payload.provider,
          issuer: payload.issuer,
          jwksUri: payload.jwksUri ?? null,
          allowedClientIds: payload.allowedClientIds?.length ? payload.allowedClientIds : null,
          organizationAccess: payload.access,
        },
        async () => actor,
      ),
    );
    return c.json(trustedIssuerView(created), 201);
  });

  app.patch(`${path}/:trustedIssuerId`, async (c) => {
    enabled();
    c.header("cache-control", "private, no-store");
    const actor = await authorizeAdministration(c, deps, true);
    const id = trustedIssuerId(c);
    const payload = parseRequestBody(
      UpdateMcpTrustedIssuerRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "Invalid trusted issuer change" },
    );
    await requireOrganizationWorkspaces(deps, actor.accountId, payload.access);
    const updated = await administrationResponse(() =>
      updateMcpTrustedIssuer(
        deps.db,
        { accountId: actor.accountId, trustedIssuerId: id },
        {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.jwksUri !== undefined ? { jwksUri: payload.jwksUri } : {}),
          ...(payload.allowedClientIds !== undefined
            ? {
                allowedClientIds: payload.allowedClientIds?.length
                  ? payload.allowedClientIds
                  : null,
              }
            : {}),
          ...(payload.access !== undefined ? { organizationAccess: payload.access } : {}),
          ...(payload.status !== undefined ? { status: payload.status } : {}),
        },
        async () => actor,
      ),
    );
    if (!updated) throw new HTTPException(404, { message: "Trusted issuer not found" });
    return c.json(trustedIssuerView(updated));
  });

  app.delete(`${path}/:trustedIssuerId`, async (c) => {
    enabled();
    const actor = await authorizeAdministration(c, deps, true);
    const id = trustedIssuerId(c);
    const deleted = await administrationResponse(() =>
      deleteMcpTrustedIssuer(
        deps.db,
        { accountId: actor.accountId, trustedIssuerId: id },
        async () => actor,
      ),
    );
    if (!deleted) throw new HTTPException(404, { message: "Trusted issuer not found" });
    return c.body(null, 204);
  });

  app.get(`${path}/:trustedIssuerId/events`, async (c) => {
    enabled();
    c.header("cache-control", "private, no-store");
    const actor = await authorizeAdministration(c, deps, false);
    const id = trustedIssuerId(c);
    const events = await administrationResponse(() =>
      listMcpTrustedIssuerEvents(
        deps.db,
        { accountId: actor.accountId, trustedIssuerId: id, limit: 50 },
        async () => actor,
      ),
    );
    if (!events) throw new HTTPException(404, { message: "Trusted issuer not found" });
    return c.json(ListMcpTrustedIssuerEventsResponse.parse({ events: events.map(eventView) }));
  });
}

function registerConnectorAutoConnectRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/connectors";
  const administration = async (c: Context, mutation: boolean) => {
    const actor = await authorizeAdministration(c, deps, mutation);
    return {
      actor,
      input: {
        db: deps.db,
        settings: deps.settings,
        accountId: actor.accountId,
        authorize: async () => actor,
        autoConnectFetch: deps.mcpAutoConnectFetch,
      },
    };
  };

  app.post(`${path}/auto-connect/check`, async (c) => {
    c.header("cache-control", "private, no-store");
    const { input } = await administration(c, true);
    const payload = parseRequestBody(
      CheckOrganizationConnectorAutoConnectRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "Choose a connector to check" },
    );
    const support = await administrationResponse(() =>
      checkOrganizationConnectorAutoConnect({
        ...input,
        ...(payload.capabilityId ? { capabilityId: payload.capabilityId } : {}),
        ...(payload.endpointUrl ? { endpointUrl: payload.endpointUrl } : {}),
      }),
    );
    return c.json(AutoConnectSupport.parse(support));
  });

  app.post(`${path}/:connectorId/auto-connect/test`, async (c) => {
    c.header("cache-control", "private, no-store");
    const { actor, input } = await administration(c, true);
    const parsed = z.string().uuid().safeParse(c.req.param("connectorId"));
    if (!parsed.success)
      throw new HTTPException(404, { message: "Organization connector not found" });
    const result = await administrationResponse(() =>
      testOrganizationConnectorAutoConnect({
        ...input,
        connectorId: parsed.data.toLowerCase(),
        subjectId: actor.subjectId,
      }),
    );
    return c.json(TestOrganizationConnectorAutoConnectResponse.parse(result));
  });

  // A member's own "Connect" on a workspace's auto-connect connector.
  app.post(
    "/v1/workspaces/:workspaceId/organization-connectors/:connectorId/connect",
    async (c) => {
      c.header("cache-control", "private, no-store");
      const workspaceId = c.req.param("workspaceId");
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      const { grant } = access;
      // The login is the person's own: only a signed-in human makes one, never
      // an API key, service or agent acting for them.
      assertPersonalConnectionOwnerPrincipal(access);
      if (!grant.subjectId.startsWith("user:"))
        throw new HTTPException(403, { message: "Connect in the Opengeni app as yourself" });
      const parsed = z.string().uuid().safeParse(c.req.param("connectorId"));
      if (!parsed.success) throw new HTTPException(404, { message: "Connector not found" });
      const attempt = await connectMemberToOrganizationConnector({
        db: deps.db,
        settings: deps.settings,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        connectorId: parsed.data.toLowerCase(),
        fetchImpl: deps.mcpAutoConnectFetch,
      });
      if (!attempt) throw new HTTPException(404, { message: "Connector not found" });
      return c.json(
        attempt.status === "connected"
          ? { status: "connected" as const }
          : { status: "refused" as const, message: attempt.message },
      );
    },
  );
}

/**
 * Registers everything but the token grant, which /oauth/token dispatches to
 * `redeemIdJagGrant`. Call before the MCP OAuth routes: the issuer's RFC 8414
 * path-inserted metadata sits under their wildcard.
 */
export function registerMcpAutoConnectRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  helpers: McpAutoConnectHelpers,
): void {
  registerIdentityIssuerRoutes(app, deps);
  registerTrustedIssuerRoutes(app, deps, helpers);
  registerConnectorAutoConnectRoutes(app, deps);
}
