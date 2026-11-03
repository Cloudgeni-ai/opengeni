import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  ID_JAG_JWT_TYPE,
  ID_JAG_LIFETIME_SECONDS,
  JWT_BEARER_GRANT_TYPE,
  type McpServerConnectionRef,
} from "@opengeni/contracts";
import {
  OAUTH_MAX_RESPONSE_BYTES,
  pinnedFetch,
  readResponseJsonBounded,
  undiciFetch,
  validateHttpUrl,
  type DnsLookup,
  type FetchLike,
} from "@opengeni/network";
import { sql } from "drizzle-orm";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { rawRows, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import {
  autoConnectLoginStillConnects,
  getOrganizationIdentityIssuerKey,
  type OrganizationIdentityIssuerKey,
} from "./mcp-auto-connect";

/* ----------------------------------------------------------------------------
   MCP auto-connect, outbound: Opengeni as an identity issuer.

   Each organization has its own issuer URL and signing key. For an
   organization connector set to auto-connect, Opengeni signs a short-lived
   ID-JAG for the member who uses it (draft-ietf-oauth-identity-assertion-
   authz-grant) and redeems it at the app's authorization server with the
   RFC 7523 JWT bearer grant. The app trusts the organization's issuer, so it
   issues the member's token with no sign-in screen. There is no refresh
   token: a new ID-JAG is signed whenever the token runs out.
   -------------------------------------------------------------------------- */

const EXCHANGE_TIMEOUT_MS = 10_000;
/** Assumed token lifetime when the app does not say. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 15 * 60;

/** The organization's issuer URL: what an app is told to trust. */
export function organizationIdentityIssuerUrl(publicBaseUrl: string, accountId: string): string {
  return `${new URL(publicBaseUrl).origin}/v1/organizations/${accountId.toLowerCase()}/identity`;
}

/** The issuer's public key set URL. */
export function organizationIdentityJwksUrl(publicBaseUrl: string, accountId: string): string {
  return `${organizationIdentityIssuerUrl(publicBaseUrl, accountId)}/jwks.json`;
}

/** A new RS256 signing key, its private half encrypted under the environments key. */
export function generateOrganizationIdentityKey(
  settings: Settings,
): Pick<
  OrganizationIdentityIssuerKey,
  "keyId" | "algorithm" | "publicJwk" | "privateKeyEncrypted"
> {
  const encryptionKey = requireEncryptionKey(settings);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  // RFC 7638 thumbprint: stable, and unique to the key.
  const keyId = createHash("sha256")
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest("base64url");
  return {
    keyId,
    algorithm: "RS256",
    publicJwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid: keyId, alg: "RS256", use: "sig" },
    privateKeyEncrypted: encryptEnvironmentValue(
      encryptionKey,
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ),
  };
}

export class AutoConnectUnavailableError extends Error {
  readonly name = "AutoConnectUnavailableError";
}

export type IdJagRequest = {
  accountId: string;
  subjectId: string;
  /** The app's authorization server issuer. */
  audience: string;
  /** Opengeni's client ID at that authorization server. */
  clientId: string;
  resource: string | null;
  scopes: readonly string[];
};

/**
 * Signs an ID-JAG for one member. The person is named by their Opengeni
 * subject and their verified email, which is how most apps match accounts.
 */
export async function mintOrganizationIdJag(
  db: Database,
  settings: Settings,
  request: IdJagRequest,
  now = new Date(),
): Promise<string> {
  if (!settings.publicBaseUrl)
    throw new AutoConnectUnavailableError("Opengeni's public URL is not configured");
  const key = await getOrganizationIdentityIssuerKey(db, request.accountId);
  if (!key) throw new AutoConnectUnavailableError("Auto-connect is not set up yet");
  const userId = request.subjectId.startsWith("user:")
    ? request.subjectId.slice("user:".length)
    : null;
  if (!userId) throw new AutoConnectUnavailableError("Only people can be connected automatically");
  const [person] = await rawRows<{ email: string; email_verified: boolean; name: string | null }>(
    db,
    sql`select email, email_verified, name from auth_users where id = ${userId} limit 1`,
  );
  if (!person) throw new AutoConnectUnavailableError("This person's account was not found");
  if (!person.email_verified)
    throw new AutoConnectUnavailableError("Verify your email address to connect automatically");
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: Record<string, unknown> = {
    iss: organizationIdentityIssuerUrl(settings.publicBaseUrl, request.accountId),
    sub: request.subjectId,
    aud: request.audience,
    client_id: request.clientId,
    jti: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ID_JAG_LIFETIME_SECONDS,
    email: person.email,
    email_verified: true,
    ...(person.name?.trim() ? { name: person.name.trim() } : {}),
    ...(request.resource ? { resource: request.resource } : {}),
    ...(request.scopes.length ? { scope: request.scopes.join(" ") } : {}),
  };
  return signJwt(
    { alg: key.algorithm, typ: ID_JAG_JWT_TYPE, kid: key.keyId },
    payload,
    decryptEnvironmentValue(requireEncryptionKey(settings), key.privateKeyEncrypted),
  );
}

export type IdJagTokenResponse = {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  scope: string | null;
};

/** The app refused the ID-JAG. `message` is plain words for the admin. */
export class IdJagExchangeError extends Error {
  readonly name = "IdJagExchangeError";
  constructor(
    readonly httpStatus: number,
    readonly oauthErrorCode: string | null,
    message: string,
  ) {
    super(message);
  }
}

export type IdJagTransportOptions = {
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
  /** Tests only: answers for any host, without the public-address pinning. */
  testFetch?: typeof fetch;
};

/** Redeems an ID-JAG at the app's token endpoint (RFC 7523 JWT bearer grant). */
export async function exchangeIdJag(
  settings: Settings,
  input: {
    tokenEndpoint: string;
    assertion: string;
    clientId: string;
    resource: string | null;
    scopes: readonly string[];
  },
  transport: IdJagTransportOptions = {},
): Promise<IdJagTokenResponse> {
  const endpoint = validateHttpUrl(input.tokenEndpoint, {
    label: "Token endpoint",
    allowLoopbackHttp: settings.environment === "local" || settings.environment === "test",
  });
  const body = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion: input.assertion,
    client_id: input.clientId,
  });
  if (input.resource) body.set("resource", input.resource);
  if (input.scopes.length) body.set("scope", input.scopes.join(" "));
  let response: Response;
  const init: RequestInit = {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    // The token endpoint answers itself; a redirect is a refusal.
    redirect: "manual",
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  };
  try {
    response = transport.testFetch
      ? await transport.testFetch(endpoint, init)
      : await pinnedFetch(endpoint, init, settings, {
          fetchImpl: transport.fetchImpl ?? undiciFetch,
          ...(transport.dnsLookup ? { dnsLookup: transport.dnsLookup } : {}),
          label: "Token endpoint",
          requireHttpsOutsideLocalTest: true,
        });
  } catch (error) {
    throw new IdJagExchangeError(
      0,
      null,
      error instanceof Error && error.name === "TimeoutError"
        ? "The app didn't answer in time"
        : "The app couldn't be reached",
    );
  }
  let payload: Record<string, unknown> = {};
  try {
    payload =
      (await readResponseJsonBounded<Record<string, unknown>>(
        response,
        OAUTH_MAX_RESPONSE_BYTES,
        "Token response",
      )) ?? {};
  } catch {
    payload = {};
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!response.ok || !accessToken) {
    const code = typeof payload.error === "string" ? payload.error.slice(0, 64) : null;
    throw new IdJagExchangeError(
      response.ok ? 400 : response.status,
      code,
      idJagRefusalMessage(response.status, code),
    );
  }
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return {
    accessToken,
    tokenType:
      typeof payload.token_type === "string" && payload.token_type ? payload.token_type : "Bearer",
    expiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1000),
    scope: typeof payload.scope === "string" ? payload.scope : null,
  };
}

/** What the stored credential of an auto-connected login holds besides its token. */
export type IdJagCredentialBinding = {
  grant: "id_jag";
  /** The organization connector it was made through; renewal checks it is still there. */
  connector_id: string;
  token_endpoint: string;
  client_id: string;
  audience: string;
  resource?: string;
  mcp_url?: string;
  scopes?: string[];
};

/** An auto-connected login's credential bundle. No refresh token, by design. */
export function idJagCredentialBundle(
  binding: Omit<IdJagCredentialBinding, "grant">,
  token: IdJagTokenResponse,
): Record<string, unknown> {
  return {
    grant: "id_jag",
    connector_id: binding.connector_id,
    access_token: token.accessToken,
    token_type: token.tokenType,
    expires_at: token.expiresAt.toISOString(),
    token_endpoint: binding.token_endpoint,
    client_id: binding.client_id,
    audience: binding.audience,
    ...(binding.resource ? { resource: binding.resource } : {}),
    ...(binding.mcp_url ? { mcp_url: binding.mcp_url } : {}),
    ...(binding.scopes?.length ? { scopes: [...binding.scopes] } : {}),
    ...(token.scope ? { scope: token.scope } : {}),
  };
}

export function isIdJagCredential(credential: Record<string, unknown>): boolean {
  return credential.grant === "id_jag";
}

/**
 * "Refreshes" an auto-connected login: signs a new ID-JAG for its owner and
 * redeems it. Called by the connection token resolver in place of a refresh
 * token grant.
 */
export async function refreshIdJagConnectionCredential(
  db: Database,
  settings: Settings,
  cred: {
    accountId: string;
    workspaceId: string;
    subjectId: string | null;
    credential: Record<string, unknown>;
  },
  ref: Pick<McpServerConnectionRef, "resource" | "scopes">,
  transport: IdJagTransportOptions = {},
): Promise<{ credential: Record<string, unknown>; expiresAt: Date; grantedScopes?: string[] }> {
  const credential = cred.credential;
  const tokenEndpoint = stringValue(credential.token_endpoint);
  const clientId = stringValue(credential.client_id);
  const audience = stringValue(credential.audience);
  const connectorId = stringValue(credential.connector_id);
  if (!cred.subjectId || !tokenEndpoint || !clientId || !audience || !connectorId)
    throw new IdJagExchangeError(400, "invalid_request", "This login is missing its setup");
  // Removed, turned off or changed connectors, and people who left, are
  // never renewed: permanent, like a revoked refresh token.
  if (
    !(await autoConnectLoginStillConnects(db, {
      accountId: cred.accountId,
      workspaceId: cred.workspaceId,
      subjectId: cred.subjectId,
      connectorId,
      audience,
      clientId,
    }))
  )
    throw new IdJagExchangeError(
      401,
      "invalid_grant",
      "Your organization no longer connects you to this app automatically",
    );
  const resource = ref.resource ?? stringValue(credential.resource) ?? null;
  const scopes = Array.isArray(credential.scopes)
    ? credential.scopes.filter((scope): scope is string => typeof scope === "string")
    : [...(ref.scopes ?? [])];
  let assertion: string;
  try {
    assertion = await mintOrganizationIdJag(db, settings, {
      accountId: cred.accountId,
      subjectId: cred.subjectId,
      audience,
      clientId,
      resource,
      scopes,
    });
  } catch (error) {
    // The organization no longer signs for this person: permanent.
    throw new IdJagExchangeError(
      401,
      "invalid_grant",
      error instanceof Error ? error.message : "Auto-connect is unavailable",
    );
  }
  const token = await exchangeIdJag(
    settings,
    { tokenEndpoint, assertion, clientId, resource, scopes },
    transport,
  );
  return {
    credential: idJagCredentialBundle(
      {
        connector_id: connectorId,
        token_endpoint: tokenEndpoint,
        client_id: clientId,
        audience,
        ...(resource ? { resource } : {}),
        ...(stringValue(credential.mcp_url) ? { mcp_url: stringValue(credential.mcp_url)! } : {}),
        scopes,
      },
      token,
    ),
    expiresAt: token.expiresAt,
    ...(token.scope ? { grantedScopes: token.scope.split(/[\s,]+/u).filter(Boolean) } : {}),
  };
}

/** Plain words for why an app refused, never its own response text. */
export function idJagRefusalMessage(httpStatus: number, code: string | null): string {
  switch (code) {
    case "invalid_grant":
      return "The app doesn't trust this organization's Opengeni issuer yet, or doesn't recognize this person";
    case "invalid_client":
    case "unauthorized_client":
      return "The app doesn't accept Opengeni's client ID";
    case "unsupported_grant_type":
      return "The app doesn't support auto-connect";
    case "invalid_scope":
      return "The app refused the permissions Opengeni asked for";
    case "invalid_target":
      return "The app refused this server address";
    default:
      return httpStatus >= 500
        ? "The app had a problem. Try again later"
        : `The app refused the connection (HTTP ${httpStatus})`;
  }
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string,
): string {
  const encoded = `${base64url(header)}.${base64url(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(encoded), createPrivateKey(privateKeyPem));
  return `${encoded}.${signature.toString("base64url")}`;
}

function base64url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function requireEncryptionKey(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new AutoConnectUnavailableError("Credential encryption is not configured");
  return key;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
