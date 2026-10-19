/**
 * Verify the compute control service's agent-link tokens (compute/docs/agent-link.md
 * section 4): the host token a host presents when it dials the gateway, and
 * the ticket each sandbox's session opens with. Both are EdDSA (Ed25519) JWTs
 * signed by the control service; its public keys and Opengeni's own team come
 * from its `GET /v1/link/keys`, cached five minutes and read again for an
 * unknown key id.
 */

export type ComputeLinkKeySet = {
  team: string;
  keys: Array<{ kty: string; crv: string; kid: string; x: string }>;
};

export type ComputeHostClaims = { host: string; expiresAtMs: number };

export type ComputeTicketClaims = {
  sandbox: string;
  host: string;
  epoch: number;
  team: string;
  workspaceId: string;
  agentId: string;
};

export class ComputeLinkTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeLinkTokenError";
  }
}

const KEYS_TTL_MS = 5 * 60_000;
/** An unknown key id reads the keys again at most this often, so forged ids
 * cannot make the gateway hammer the control service. */
const UNKNOWN_KID_REFETCH_MS = 10_000;
const SKEW_MS = 60_000;

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new ComputeLinkTokenError("token is not base64url");
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function jsonPart(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlBytes(value)));
  } catch (error) {
    if (error instanceof ComputeLinkTokenError) throw error;
    throw new ComputeLinkTokenError("token part is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ComputeLinkTokenError("token part is not an object");
  }
  return parsed as Record<string, unknown>;
}

function audienceMatches(aud: unknown, audience: string): boolean {
  if (typeof aud === "string") return aud === audience;
  return Array.isArray(aud) && aud.includes(audience);
}

function nonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export class ComputeLinkVerifier {
  private keySet: ComputeLinkKeySet | null = null;
  private publicKeys = new Map<string, Promise<CryptoKey>>();
  private fetchedAtMs = 0;
  private inflight: Promise<ComputeLinkKeySet> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      /** Reads `GET /v1/link/keys` from the control service. */
      fetchKeys: () => Promise<ComputeLinkKeySet>;
      /** The gateway's own URL: every token's `aud`. */
      audience: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Verify the host token on a link's upgrade; returns its host name. */
  async verifyHostToken(token: string): Promise<ComputeHostClaims> {
    const claims = await this.verify(token);
    if (claims.typ !== "compute-host") throw new ComputeLinkTokenError("not a host token");
    if (!audienceMatches(claims.aud, this.options.audience)) {
      throw new ComputeLinkTokenError("host token is for another gateway");
    }
    if (!nonEmptyString(claims.sub)) throw new ComputeLinkTokenError("host token has no host");
    const now = this.now();
    if (typeof claims.exp !== "number" || claims.exp * 1000 + SKEW_MS <= now) {
      throw new ComputeLinkTokenError("host token expired");
    }
    if (typeof claims.iat === "number" && claims.iat * 1000 - SKEW_MS > now) {
      throw new ComputeLinkTokenError("host token is not valid yet");
    }
    if (typeof claims.nbf === "number" && claims.nbf * 1000 - SKEW_MS > now) {
      throw new ComputeLinkTokenError("host token is not valid yet");
    }
    return { host: claims.sub, expiresAtMs: claims.exp * 1000 };
  }

  /** Verify a session's ticket for the link's host and the opened sandbox. */
  async verifyTicket(
    token: string,
    expected: { host: string; sandbox: string },
  ): Promise<ComputeTicketClaims> {
    const claims = await this.verify(token);
    if (claims.typ !== "compute-sandbox") throw new ComputeLinkTokenError("not a sandbox ticket");
    if (!audienceMatches(claims.aud, this.options.audience)) {
      throw new ComputeLinkTokenError("ticket is for another gateway");
    }
    if (claims.sub !== expected.sandbox) {
      throw new ComputeLinkTokenError("ticket is for another sandbox");
    }
    if (claims.host !== expected.host) {
      throw new ComputeLinkTokenError("ticket is for another host");
    }
    const team = (await this.keys()).team;
    if (claims.team !== team) throw new ComputeLinkTokenError("ticket is for another team");
    const epoch = claims.epoch;
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
      throw new ComputeLinkTokenError("ticket has no valid epoch");
    }
    if (!nonEmptyString(claims.workspace, 64) || !nonEmptyString(claims.agent, 64)) {
      throw new ComputeLinkTokenError("ticket names no agent");
    }
    return {
      sandbox: expected.sandbox,
      host: expected.host,
      epoch,
      team,
      workspaceId: claims.workspace,
      agentId: claims.agent,
    };
  }

  private async verify(token: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new ComputeLinkTokenError("token is not a JWT");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = jsonPart(headerPart);
    if (header.alg !== "EdDSA") throw new ComputeLinkTokenError("token is not EdDSA");
    if (header.typ !== undefined && header.typ !== "JWT") {
      throw new ComputeLinkTokenError("token is not a JWT");
    }
    if (!nonEmptyString(header.kid)) throw new ComputeLinkTokenError("token has no key id");
    const key = await this.publicKey(header.kid);
    const signature = base64UrlBytes(signaturePart);
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signed);
    if (!valid) throw new ComputeLinkTokenError("token signature is invalid");
    return jsonPart(payloadPart);
  }

  private async publicKey(kid: string): Promise<CryptoKey> {
    let keySet = await this.keys();
    if (!keySet.keys.some((key) => key.kid === kid)) {
      if (this.now() - this.fetchedAtMs >= UNKNOWN_KID_REFETCH_MS) {
        keySet = await this.keys(true);
      }
    }
    const jwk = keySet.keys.find((key) => key.kid === kid);
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      throw new ComputeLinkTokenError("token key is unknown");
    }
    let imported = this.publicKeys.get(kid);
    if (!imported) {
      imported = crypto.subtle.importKey(
        "jwk",
        { kty: "OKP", crv: "Ed25519", x: jwk.x },
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      // A bad key is not cached, so a corrected key set can replace it.
      imported.catch(() => this.publicKeys.delete(kid));
      this.publicKeys.set(kid, imported);
    }
    try {
      return await imported;
    } catch {
      throw new ComputeLinkTokenError("token key is invalid");
    }
  }

  /** The cached key set, read again when older than five minutes (or when
   * `refresh`); a failed read keeps serving the last good set. */
  private async keys(refresh = false): Promise<ComputeLinkKeySet> {
    const fresh = this.keySet && this.now() - this.fetchedAtMs < KEYS_TTL_MS;
    if (fresh && !refresh) return this.keySet!;
    if (!this.inflight) {
      this.inflight = this.options
        .fetchKeys()
        .then((keySet) => {
          if (!nonEmptyString(keySet?.team) || !Array.isArray(keySet.keys)) {
            throw new Error("the control service answered an invalid link key set");
          }
          this.keySet = keySet;
          this.fetchedAtMs = this.now();
          // Keys may have rotated: drop imported keys the set no longer names.
          for (const kid of this.publicKeys.keys()) {
            if (!keySet.keys.some((key) => key.kid === kid)) this.publicKeys.delete(kid);
          }
          return keySet;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    try {
      return await this.inflight;
    } catch (error) {
      if (this.keySet) return this.keySet;
      throw new ComputeLinkKeysUnavailableError(error);
    }
  }
}

/** The control service's link keys could not be read and none are cached: the gateway
 * cannot judge a token now (try again later), which is not a bad token. */
export class ComputeLinkKeysUnavailableError extends Error {
  constructor(cause: unknown) {
    super("the compute link keys are unavailable", { cause });
    this.name = "ComputeLinkKeysUnavailableError";
  }
}
