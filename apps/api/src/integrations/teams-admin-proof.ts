import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";

/**
 * Self-serve Teams setup proves that the person connecting a Microsoft tenant
 * administers it. They sign in with Microsoft through the bot's own
 * multi-tenant Entra app (authorization code + PKCE, tenant-specific
 * authority), and the verified ID token must name the exact Teams tenant and
 * Teams user from the signed setup proof and carry a tenant administrator role
 * in `wids` (the app's `groupMembershipClaims` must include `DirectoryRole`).
 *
 * The OAuth state is HMAC-signed and binds the setup proof nonce, tenant,
 * actor, Opengeni subject and workspace. The PKCE verifier and OIDC nonce are
 * derived from the state's random value with the server secret, so they are
 * never sent through the browser and nothing is stored between the two steps.
 */

export const TEAMS_ADMIN_ROLE_IDS = {
  globalAdministrator: "62e90394-69f5-4237-9190-012177145e10",
  teamsAdministrator: "69091246-20e8-4a56-aa4d-066075b2a7a8",
} as const;
const ADMIN_ROLES = new Set<string>(Object.values(TEAMS_ADMIN_ROLE_IDS));
/** Microsoft personal accounts; consumer Teams never has a tenant administrator. */
const CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const AUTHORITY = "https://login.microsoftonline.com";
const KEYS_URL = `${AUTHORITY}/common/discovery/v2.0/keys`;
const SCOPE = "openid profile";
const STATE_TTL_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

const uuid = z.string().uuid();
const State = z
  .object({
    version: z.literal(1),
    purpose: z.literal("teams-admin-setup"),
    proofNonce: uuid,
    tenantId: uuid,
    actorId: uuid,
    subjectId: z.string().min(1).max(512),
    workspaceId: uuid,
    nonce: uuid,
    expiresAt: z.number().int(),
  })
  .strict();
export type TeamsAdminState = z.infer<typeof State>;

export class TeamsAdminProofError extends Error {
  constructor(
    readonly code:
      | "state_invalid"
      | "state_expired"
      | "state_mismatch"
      | "consumer_tenant"
      | "token_exchange_failed"
      | "id_token_invalid"
      | "tenant_mismatch"
      | "user_mismatch"
      | "not_tenant_admin",
  ) {
    super(`teams_admin_proof_${code}`);
  }
}

function sign(secret: string, label: string, value: string): Buffer {
  return createHmac("sha256", secret).update(`${label}:${value}`).digest();
}
function derived(secret: string, label: string, nonce: string): string {
  return sign(secret, label, nonce).toString("base64url");
}
export function teamsAdminPkceVerifier(secret: string, state: TeamsAdminState): string {
  return derived(secret, "teams-admin-setup-pkce-v1", state.nonce);
}
export function teamsAdminOidcNonce(secret: string, state: TeamsAdminState): string {
  return derived(secret, "teams-admin-setup-oidc-nonce-v1", state.nonce);
}

export function teamsSelfServeTenantAllowed(tenantId: string): boolean {
  return tenantId.toLowerCase() !== CONSUMER_TENANT_ID;
}

export function mintTeamsAdminState(
  secret: string,
  input: Omit<TeamsAdminState, "version" | "purpose" | "nonce" | "expiresAt">,
  now = Date.now(),
): { token: string; state: TeamsAdminState } {
  const state = State.parse({
    ...input,
    version: 1,
    purpose: "teams-admin-setup",
    nonce: randomUUID(),
    expiresAt: now + STATE_TTL_MS,
  });
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return {
    token: `${payload}.${sign(secret, "teams-admin-setup-state-v1", payload).toString("base64url")}`,
    state,
  };
}

export function verifyTeamsAdminState(
  secret: string,
  token: string,
  now = Date.now(),
): TeamsAdminState {
  if (token.length > 4096) throw new TeamsAdminProofError("state_invalid");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined)
    throw new TeamsAdminProofError("state_invalid");
  const expected = sign(secret, "teams-admin-setup-state-v1", payload);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new TeamsAdminProofError("state_invalid");
  let state: TeamsAdminState;
  try {
    state = State.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    throw new TeamsAdminProofError("state_invalid");
  }
  if (state.expiresAt <= now || state.expiresAt > now + STATE_TTL_MS)
    throw new TeamsAdminProofError("state_expired");
  return state;
}

export type TeamsAdminSignInConfig = {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  redirectUri: string;
};

/** Microsoft sign-in in exactly the Teams tenant, for the bot's own Entra app. */
export function teamsAdminAuthorizationUrl(
  config: TeamsAdminSignInConfig,
  stateToken: string,
  state: TeamsAdminState,
): string {
  const url = new URL(`${AUTHORITY}/${state.tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", stateToken);
  url.searchParams.set("nonce", teamsAdminOidcNonce(config.stateSecret, state));
  url.searchParams.set(
    "code_challenge",
    createHash("sha256")
      .update(teamsAdminPkceVerifier(config.stateSecret, state))
      .digest("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("response_too_large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  return JSON.parse(text);
}

export type TeamsAdminIdentity = {
  tenantId: string;
  actorId: string;
  roles: string[];
};

/**
 * Exchanges the code and verifies the ID token: signature from Microsoft's
 * published keys, issuer for exactly this tenant, audience, expiry, nonce,
 * `tid`/`oid` equal to the Teams tenant and user, and an administrator role.
 */
export async function verifyTeamsAdminSignIn(
  config: TeamsAdminSignInConfig,
  state: TeamsAdminState,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TeamsAdminIdentity> {
  if (!teamsSelfServeTenantAllowed(state.tenantId))
    throw new TeamsAdminProofError("consumer_tenant");
  const tenantId = state.tenantId.toLowerCase();
  let idToken: string;
  try {
    const response = await fetchImpl(`${AUTHORITY}/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: teamsAdminPkceVerifier(config.stateSecret, state),
        scope: SCOPE,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await boundedJson(response)) as { id_token?: unknown };
    if (!response.ok || typeof body.id_token !== "string" || !body.id_token)
      throw new Error("token_response_invalid");
    idToken = body.id_token;
  } catch {
    throw new TeamsAdminProofError("token_exchange_failed");
  }
  let claims: Record<string, unknown>;
  try {
    const response = await fetchImpl(KEYS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("keys_unavailable");
    const keys = (await boundedJson(response)) as JSONWebKeySet;
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
      issuer: `${AUTHORITY}/${tenantId}/v2.0`,
      audience: config.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "nonce", "tid", "oid"],
      clockTolerance: 120,
    });
    claims = payload as Record<string, unknown>;
  } catch {
    throw new TeamsAdminProofError("id_token_invalid");
  }
  if (claims.nonce !== teamsAdminOidcNonce(config.stateSecret, state))
    throw new TeamsAdminProofError("id_token_invalid");
  if (typeof claims.tid !== "string" || claims.tid.toLowerCase() !== tenantId)
    throw new TeamsAdminProofError("tenant_mismatch");
  if (typeof claims.oid !== "string" || claims.oid.toLowerCase() !== state.actorId.toLowerCase())
    throw new TeamsAdminProofError("user_mismatch");
  const roles = Array.isArray(claims.wids)
    ? claims.wids.filter((value): value is string => typeof value === "string")
    : [];
  if (!roles.some((role) => ADMIN_ROLES.has(role.toLowerCase())))
    throw new TeamsAdminProofError("not_tenant_admin");
  return { tenantId, actorId: state.actorId.toLowerCase(), roles };
}
