// @opengeni/runtime/sandbox — scoped stream-token mint/verify (P3.1).
//
// The agent-loop-free home for the scoped data-plane stream token used by the
// desktop pixel plane (Channel B, master-spine §C.3 / crosscut PART 1.3). It is
// a THIN wrapper over the contracts HMAC envelope (signStreamToken /
// verifyStreamToken) — NOT a second crypto: it REUSES the exact base64Url +
// hmacSha256 construction that backs signDelegatedAccessToken, with the distinct
// `ogs_` prefix and the hard-narrow StreamTokenPayload claim set.
//
// It lives under @opengeni/runtime/sandbox so the API-direct control plane
// (apps/api) can mint + verify stream tokens from the same single agent-loop-free
// leaf it already pulls createSandboxClient / resume-by-id from.

import {
  DESKTOP_STREAM_PORT,
  StreamTokenPayload,
  signStreamToken,
  verifyStreamToken as verifyStreamTokenEnvelope,
  type StreamTokenPayload as StreamTokenPayloadType,
} from "@opengeni/contracts";

// The default stream-token TTL (seconds). The token is short-lived by design:
// URL rotation is event-driven under the epoch fence (re-resolve recorded on the
// lease), not on a keepalive clock — so the token never needs a long life.
export const STREAM_TOKEN_DEFAULT_TTL_SECONDS = 120;

export type MintStreamTokenInput = {
  workspaceId: string;
  sessionId: string;
  /** The sandbox_lease_holders viewer row id. */
  viewerId: string;
  /** The epoch the token is fenced to. For a Modal box this is the live LEASE
   *  epoch (re-minted on box rollover). For a SELFHOSTED relay stream (M8b) this is
   *  the session's swap `active_epoch`: the relay tracks the highest epoch any
   *  viewer presented per channel and REJECTS a token with a lower epoch, so a
   *  viewer whose token predates a swap-away cannot reach the machine the session
   *  swapped off of. One field, two fences — the relay/in-box edge reads it as the
   *  stale-viewer floor either way. */
  leaseEpoch: number;
  /** v1 is always "view"; "control" is the never-granted raw-input plane. */
  mode?: "view" | "control";
  /** The exposed stream port (noVNC); defaults to 6080. */
  port?: number;
  /** TTL in seconds; defaults to STREAM_TOKEN_DEFAULT_TTL_SECONDS. */
  ttlSeconds?: number;
  /** Override the issue clock (tests). Seconds since the epoch. */
  nowSeconds?: number;
};

/**
 * Mint a scoped stream token for one viewer holder. Builds the hard-narrow
 * StreamTokenPayload (the claim set the in-box edge / control plane validates)
 * and signs it with the resolved stream-token secret via the contracts HMAC
 * envelope (`ogs_` prefix). The token is RECORDED against the holder row by the
 * caller and is NEVER appended to the data-plane URL as a query param.
 */
export async function mintStreamToken(secret: string, input: MintStreamTokenInput): Promise<string> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = input.ttlSeconds ?? STREAM_TOKEN_DEFAULT_TTL_SECONDS;
  const payload: StreamTokenPayloadType = StreamTokenPayload.parse({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    viewerId: input.viewerId,
    leaseEpoch: input.leaseEpoch,
    mode: input.mode ?? "view",
    port: input.port ?? DESKTOP_STREAM_PORT,
    exp: nowSeconds + ttlSeconds,
  });
  return signStreamToken(secret, payload);
}

/**
 * Verify a scoped stream token. Returns the parsed claims on success, or null on
 * a bad prefix / malformed envelope / bad HMAC signature / schema-invalid claims
 * / expiry. Re-exports the contracts verify; the leaf is the agent-loop-free
 * import surface the API uses.
 *
 * The epoch fence (claim.leaseEpoch vs the LIVE lease epoch) and the
 * workspace+session scope are enforced at USE by the caller against the live
 * lease + route params — verify proves authenticity + freshness only.
 */
export async function verifyStreamToken(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<StreamTokenPayloadType | null> {
  return verifyStreamTokenEnvelope(secret, token, nowSeconds);
}

export { StreamTokenPayload, type StreamTokenPayload as StreamTokenPayloadType } from "@opengeni/contracts";
