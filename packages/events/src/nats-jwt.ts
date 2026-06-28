// packages/events/src/nats-jwt.ts — NATS JWT v2 signing for the auth-callout
// responder (bring-your-own-compute M-AUTH; dossier §10.1 NATS Accounts per
// workspace + §17 the isolation smoke).
//
// This is the cryptographic core of the auth-callout tenancy boundary. When an
// external agent connects to NATS presenting its `oge_` enrollment bearer as the
// connect auth-token, nats-server (configured with `auth_callout`) issues an
// authorization request on `$SYS.REQ.USER.AUTH`. Our responder (auth-callout.ts)
// validates the bearer and answers with a SIGNED authorization-response JWT that
// embeds a SIGNED user JWT scoping the connection to publish/subscribe ONLY
// `agent.<workspaceId>.>` (+ the reply `_INBOX.>`). That per-subject permission
// set IS the per-workspace isolation: workspace A's agent literally cannot
// pub/sub workspace B's subjects (§19 the NATS-Accounts-misconfig leak risk is
// closed at the JWT-permission layer, not just by subject naming).
//
// WHY HAND-ROLL THE JWT ENCODING (vs a dep): the NATS JWT v2 wire format is small,
// stable, and fully specified (ADR-26 + nats-io/jwt): a base64url header
// `{"typ":"JWT","alg":"ed25519-nkey"}`, base64url JSON claims whose `jti` is the
// base32(SHA-512/256(claims-with-blank-jti)), and an ed25519 nkey signature over
// `header.payload`. nkeys (re-exported by the `nats` package we already depend on)
// gives us the ed25519 sign primitive; Node `crypto` gives SHA-512/256. So we own
// the encoding in a few well-tested functions rather than pull an alpha
// `@nats-io/jwt` (0.0.x) whose nkeys-version compat is uncertain. No `xkey`
// encryption is used (the bearer is already an authenticated identity claim and
// the wire is TLS — encryption is an optional ADR-26 hardening, off here).
//
// SECURITY: the account SIGNING SEED never leaves this process and is NEVER logged.
// Callers pass it as a `string` seed; we `fromSeed` it once per sign. The bearer
// the responder validates is HMAC-verified elsewhere (verifyEnrollmentBearer); this
// module only mints the scoped NATS credential once identity is proven.

import { createHash } from "node:crypto";
import { nkeys } from "nats";

/** The NATS JWT v2 header — constant for every token we mint (ADR-26 / nats-io/jwt:
 *  `TokenTypeJwt="JWT"`, `AlgorithmNkey="ed25519-nkey"`). */
const JWT_HEADER = { typ: "JWT", alg: "ed25519-nkey" } as const;

/** NATS user-claim `nats.type` discriminator + `nats.version` for v2 claims. */
const USER_CLAIM_TYPE = "user";
const AUTH_RESPONSE_CLAIM_TYPE = "authorization_response";
const NATS_CLAIM_VERSION = 2;

/** A NATS permission set: subject allow/deny lists (ADR-26 `pub`/`sub` →
 *  `allow`/`deny`). An empty/undefined list means "no explicit grant" — combined
 *  with the agent scope below, the connection can ONLY reach what `allow` lists. */
export interface NatsPermission {
  allow?: string[];
  deny?: string[];
}

/** The pub/sub permissions embedded in a user JWT. */
export interface NatsPermissions {
  pub: NatsPermission;
  sub: NatsPermission;
}

/**
 * The minimal nkey keypair surface this module needs — exactly what
 * `nkeys.fromSeed(seed)` returns. Declared structurally so the module does not
 * leak the `nats` nkeys type through its public signature.
 */
interface NkeyPair {
  getPublicKey(): string;
  sign(input: Uint8Array): Uint8Array;
}

/** base64url (RawURLEncoding — no padding), matching nats-io/jwt's `serialize`. */
function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** RFC 4648 base32 (standard alphabet, NO padding) — the encoding nats-io/jwt
 *  uses for the `jti` hash. Node has no built-in base32, so a tiny encoder. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32NoPadding(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Compute the canonical NATS `jti`: base32(NoPadding, std-alphabet) of the
 * SHA-512/256 of the claims object SERIALIZED WITH AN EMPTY `jti` (nats-io/jwt's
 * `hash`). nats-server recomputes + verifies this on decode, so it must match
 * byte-for-byte. We serialize the SAME object we will sign, only with `jti:""`.
 */
function computeJti(claimsWithBlankJti: object): string {
  const json = JSON.stringify(claimsWithBlankJti);
  const digest = createHash("sha512-256").update(json, "utf8").digest();
  return base32NoPadding(digest);
}

/**
 * Encode + sign a NATS v2 JWT. The `claims` MUST already carry `iss`/`sub`/`iat`
 * (+ optional `aud`/`exp`) and a `nats` block; this function fills `jti` (the
 * canonical hash), serializes `header.payload`, signs that with `signingKey`, and
 * appends the base64url signature. Returns the compact `header.payload.signature`.
 */
function encodeJwt(claims: Record<string, unknown>, signingKey: NkeyPair): string {
  // jti is the hash of the claims with jti blanked — set it blank, hash, then set.
  const withBlankJti = { ...claims, jti: "" };
  const jti = computeJti(withBlankJti);
  const finalClaims = { ...claims, jti };

  const header = base64UrlEncode(Buffer.from(JSON.stringify(JWT_HEADER), "utf8"));
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(finalClaims), "utf8"));
  const signingInput = `${header}.${payload}`;
  const signature = signingKey.sign(Buffer.from(signingInput, "utf8"));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Input to mint a workspace-scoped NATS user JWT for an enrolled agent.
 *   - `userPublicKey` — the `user_nkey` from the authorization request; it MUST be
 *     the `sub` of the user JWT (nats-server rejects a mismatch).
 *   - `accountSeed` — the callout account SIGNING seed (`SA...`); both the user JWT
 *     `iss` (its public key) and the signature come from it. NEVER logged.
 *   - `name` — a human label for the user (the agent id), for server logs.
 *   - `permissions` — the pub/sub allow/deny lists (the workspace scope).
 *   - `expiresAtSeconds` — optional absolute `exp` (unix seconds). When set the
 *     server will expire the connection's credential; we tie it to the bearer's
 *     remaining life so a revoked/expired enrollment cannot outlive its bearer.
 */
export interface MintUserJwtInput {
  userPublicKey: string;
  accountSeed: string;
  name: string;
  permissions: NatsPermissions;
  /** The target account NAME (the `auth_callout.account`) the user binds to; the
   *  embedded user JWT's `aud` in server-config mode. */
  audienceAccount: string;
  expiresAtSeconds?: number;
}

/**
 * Mint a signed NATS user JWT scoped by `permissions`. In auth-callout SERVER
 * mode the user JWT is signed by the callout ISSUER ACCOUNT key, and its `iss` is
 * that account's public key. The returned JWT is embedded as `nats.jwt` in the
 * authorization response.
 */
export function mintUserJwt(input: MintUserJwtInput): string {
  const accountKey = nkeys.fromSeed(Buffer.from(input.accountSeed)) as unknown as NkeyPair;
  const accountPublicKey = accountKey.getPublicKey();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const natsBlock: Record<string, unknown> = {
    type: USER_CLAIM_TYPE,
    version: NATS_CLAIM_VERSION,
    pub: input.permissions.pub,
    sub: input.permissions.sub,
    // Unlimited subscriptions / data / payload (the workspace subject scope, NOT
    // a connection-resource quota, is the boundary here).
    subs: -1,
    data: -1,
    payload: -1,
  };

  const claims: Record<string, unknown> = {
    jti: "",
    iat: nowSeconds,
    iss: accountPublicKey,
    name: input.name,
    sub: input.userPublicKey,
    // SERVER-config-mode placement: nats-server reads the embedded user JWT's `aud`
    // as the target account NAME (the configured `auth_callout.account`). This is
    // how the authenticated user binds to that account; the workspace isolation is
    // then carried by the pub/sub permissions below.
    aud: input.audienceAccount,
    nats: natsBlock,
  };
  if (typeof input.expiresAtSeconds === "number") {
    claims.exp = input.expiresAtSeconds;
  }
  return encodeJwt(claims, accountKey);
}

/**
 * Input to mint the authorization RESPONSE JWT the responder publishes back on the
 * request's reply subject (ADR-26 §3).
 *   - `userPublicKey` — the request's `user_nkey`; the response `sub`.
 *   - `serverId` — the request's `nats.server_id.id` (the server's public key); the
 *     response `aud`.
 *   - `accountSeed` — the callout account signing seed; signs the response and is
 *     its `iss` (public key). NEVER logged.
 *   - `userJwt` — the embedded signed user JWT (omit on a denial).
 *   - `error` — a human-readable denial message (omit on success). When present the
 *     server denies the connection.
 */
export interface MintAuthResponseInput {
  userPublicKey: string;
  serverId: string;
  accountSeed: string;
  userJwt?: string;
  error?: string;
}

/**
 * Mint the signed authorization-response JWT. On success it carries the embedded
 * user JWT (`nats.jwt`); on denial it carries `nats.error` and NO user JWT, which
 * makes nats-server refuse the connection. Signed by the callout account key (its
 * public key is `iss`); `sub` is the user_nkey, `aud` is the server id.
 */
export function mintAuthResponse(input: MintAuthResponseInput): string {
  const accountKey = nkeys.fromSeed(Buffer.from(input.accountSeed)) as unknown as NkeyPair;
  const accountPublicKey = accountKey.getPublicKey();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const natsBlock: Record<string, unknown> = {
    type: AUTH_RESPONSE_CLAIM_TYPE,
    version: NATS_CLAIM_VERSION,
  };
  if (input.userJwt) {
    natsBlock.jwt = input.userJwt;
  }
  if (input.error) {
    natsBlock.error = input.error;
  }

  const claims: Record<string, unknown> = {
    jti: "",
    iat: nowSeconds,
    iss: accountPublicKey,
    // The response `aud` MUST be the SERVER public key in server-config mode
    // (nats-server validates "Audience must be a server public key"). The
    // authenticated user is placed into the configured `auth_callout.account` (the
    // SAME account the responder + the privileged control plane connect into), so
    // `agent.<ws>.<id>.rpc` request/reply routes; the workspace isolation is carried
    // entirely by the user JWT's pub/sub subject permissions (NOT by cross-account
    // placement, which server-config-mode nats does not support — nats-io#4335).
    aud: input.serverId,
    sub: input.userPublicKey,
    nats: natsBlock,
  };
  return encodeJwt(claims, accountKey);
}

/**
 * The fields the responder needs out of the authorization REQUEST JWT (ADR-26 §2).
 * The request is itself a NATS JWT (`header.payload.signature`) the server signs;
 * we only DECODE it (the server proves its own identity by the connection, and the
 * embedded `auth_token` is independently HMAC-verified), so we read the payload
 * without re-verifying the server signature.
 */
export interface DecodedAuthRequest {
  /** The public user nkey the response user JWT MUST be `sub`-scoped to. */
  userNkey: string;
  /** The server's public id — the response `aud`. */
  serverId: string;
  /** The connect `auth_token` the client presented (our `oge_` bearer), if any. */
  authToken: string | undefined;
  /** The connect username, if any (unused today; present for completeness). */
  user: string | undefined;
}

/**
 * Decode the authorization-request JWT payload (the middle base64url segment). The
 * request shape (ADR-26 §2): `nats.user_nkey`, `nats.server_id.id`, and the
 * presented connect options under `nats.connect_opts` (`auth_token` / `user`).
 * Returns null on a malformed token so the caller can deny cleanly.
 */
export function decodeAuthRequest(token: string): DecodedAuthRequest | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const nats = (payload as { nats?: unknown }).nats;
  if (typeof nats !== "object" || nats === null) {
    return null;
  }
  const natsObj = nats as {
    user_nkey?: unknown;
    server_id?: { id?: unknown } | unknown;
    connect_opts?: { auth_token?: unknown; user?: unknown } | unknown;
  };
  const userNkey = typeof natsObj.user_nkey === "string" ? natsObj.user_nkey : null;
  if (!userNkey) {
    return null;
  }
  const serverIdRaw =
    typeof natsObj.server_id === "object" && natsObj.server_id !== null
      ? (natsObj.server_id as { id?: unknown }).id
      : undefined;
  const serverId = typeof serverIdRaw === "string" ? serverIdRaw : "";
  const connectOpts =
    typeof natsObj.connect_opts === "object" && natsObj.connect_opts !== null
      ? (natsObj.connect_opts as { auth_token?: unknown; user?: unknown })
      : {};
  const authToken = typeof connectOpts.auth_token === "string" ? connectOpts.auth_token : undefined;
  const user = typeof connectOpts.user === "string" ? connectOpts.user : undefined;
  return { userNkey, serverId, authToken, user };
}

/**
 * Build the workspace-scoped permission set for an agent: it may publish + subscribe
 * ONLY `agent.<workspaceId>.>` (its own RPC/event/hello subtree) and the reply
 * `_INBOX.>` subtree (so request/reply round-trips work). Everything else is
 * implicitly denied (an allow-list with no other entries IS the deny-all-else).
 *
 * THE isolation assertion (§17): with `workspaceId=A`, the returned allow lists name
 * only `agent.A.>` — so a connection bearing this credential is rejected by
 * nats-server the instant it tries to pub/sub `agent.B.>`. This is the per-workspace
 * tenancy boundary, enforced cryptographically by the signed JWT, not by naming.
 */
export function workspaceAgentPermissions(workspaceId: string): NatsPermissions {
  const agentScope = `agent.${workspaceId}.>`;
  // The reply-inbox subtree must be reachable for request/reply (the control plane
  // requests on agent.<ws>.<id>.rpc with a reply inbox; the agent responds there).
  const inboxScope = "_INBOX.>";
  return {
    pub: { allow: [agentScope, inboxScope] },
    sub: { allow: [agentScope, inboxScope] },
  };
}
