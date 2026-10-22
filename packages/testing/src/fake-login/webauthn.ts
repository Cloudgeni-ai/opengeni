import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

import { decodeCbor, decodeCborPrefix, type CborValue } from "./cbor";

/**
 * A real WebAuthn relying-party verifier (Level 2 subset) for the fake-login
 * suite: client data type/challenge/origin, rpId hash, UP/UV flags, COSE public
 * key extraction (ES256, RS256, EdDSA), "none" and self "packed" attestation,
 * assertion signatures and the signature-counter rule. It deliberately shares no
 * code with the product passkey manager it tests.
 */

/** The JWK subset used for WebAuthn public keys. */
export type JsonWebKey = {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
};

export class WebAuthnError extends Error {
  constructor(
    readonly code:
      | "bad_client_data"
      | "bad_challenge"
      | "bad_origin"
      | "bad_rp_id"
      | "user_not_present"
      | "user_not_verified"
      | "bad_attestation"
      | "bad_signature"
      | "counter_regression"
      | "unknown_credential",
    message: string,
  ) {
    super(message);
    this.name = "WebAuthnError";
  }
}

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function b64urlDecode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function sha256(bytes: Uint8Array | string): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export type StoredCredential = {
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  alg: number;
  signCount: number;
  userHandle: string;
  username: string;
  createdAt: string;
  lastUsedAt?: string;
};

type ParsedAuthData = {
  rpIdHash: Uint8Array;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  attested?: {
    aaguid: Uint8Array;
    credentialId: Uint8Array;
    cosePublicKey: Map<CborValue, CborValue>;
  };
};

function parseAuthData(authData: Uint8Array): ParsedAuthData {
  if (authData.length < 37)
    throw new WebAuthnError("bad_attestation", "authenticator data too short");
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const flags = authData[32]!;
  const parsed: ParsedAuthData = {
    rpIdHash: authData.slice(0, 32),
    flags,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: view.getUint32(33),
  };
  if ((flags & 0x40) !== 0) {
    const aaguid = authData.slice(37, 53);
    const length = view.getUint16(53);
    const credentialId = authData.slice(55, 55 + length);
    const { value } = decodeCborPrefix(authData, 55 + length);
    if (!(value instanceof Map))
      throw new WebAuthnError("bad_attestation", "COSE key is not a map");
    parsed.attested = { aaguid, credentialId, cosePublicKey: value };
  }
  return parsed;
}

function coseToJwk(cose: Map<CborValue, CborValue>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1);
  const alg = Number(cose.get(3));
  const bytes = (label: number) => {
    const value = cose.get(label);
    if (!(value instanceof Uint8Array))
      throw new WebAuthnError("bad_attestation", `COSE ${label} missing`);
    return b64urlEncode(value);
  };
  if (kty === 2) {
    if (cose.get(-1) !== 1)
      throw new WebAuthnError("bad_attestation", "only P-256 EC2 keys are supported");
    return { jwk: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, alg };
  }
  if (kty === 3) return { jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, alg };
  if (kty === 1) return { jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2) }, alg };
  throw new WebAuthnError("bad_attestation", `unsupported COSE key type ${String(kty)}`);
}

function verifySignature(
  alg: number,
  jwk: JsonWebKey,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (alg === -7) return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, signature);
  if (alg === -257) return cryptoVerify("sha256", data, key, signature);
  if (alg === -8) return cryptoVerify(null, data, key, signature);
  throw new WebAuthnError("bad_signature", `unsupported COSE algorithm ${alg}`);
}

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean };

function checkClientData(
  clientDataJSON: Uint8Array,
  expected: {
    type: "webauthn.create" | "webauthn.get";
    challenge: string;
    origins: readonly string[];
  },
): ClientData {
  let clientData: ClientData;
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)) as ClientData;
  } catch {
    throw new WebAuthnError("bad_client_data", "clientDataJSON is not JSON");
  }
  if (clientData.type !== expected.type) {
    throw new WebAuthnError("bad_client_data", `expected ${expected.type}, got ${clientData.type}`);
  }
  if (clientData.challenge !== expected.challenge)
    throw new WebAuthnError("bad_challenge", "challenge mismatch");
  if (!expected.origins.includes(clientData.origin)) {
    throw new WebAuthnError("bad_origin", `unexpected origin ${clientData.origin}`);
  }
  return clientData;
}

function checkFlags(authData: ParsedAuthData, rpId: string, requireUserVerification: boolean) {
  if (!sha256(rpId).equals(Buffer.from(authData.rpIdHash))) {
    throw new WebAuthnError("bad_rp_id", "rpIdHash does not match");
  }
  if (!authData.userPresent) throw new WebAuthnError("user_not_present", "UP flag not set");
  if (requireUserVerification && !authData.userVerified) {
    throw new WebAuthnError("user_not_verified", "UV flag not set");
  }
}

export type RegistrationResponseJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};

export function verifyRegistration(input: {
  credential: RegistrationResponseJSON;
  expectedChallenge: string;
  origins: readonly string[];
  rpId: string;
  requireUserVerification: boolean;
}): {
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  alg: number;
  signCount: number;
  fmt: string;
  userVerified: boolean;
} {
  const clientDataJSON = b64urlDecode(input.credential.response.clientDataJSON);
  checkClientData(clientDataJSON, {
    type: "webauthn.create",
    challenge: input.expectedChallenge,
    origins: input.origins,
  });
  const attestation = decodeCbor(b64urlDecode(input.credential.response.attestationObject));
  if (!(attestation instanceof Map))
    throw new WebAuthnError("bad_attestation", "attestation is not a map");
  const fmt = attestation.get("fmt");
  const authDataBytes = attestation.get("authData");
  const attStmt = attestation.get("attStmt");
  if (
    typeof fmt !== "string" ||
    !(authDataBytes instanceof Uint8Array) ||
    !(attStmt instanceof Map)
  ) {
    throw new WebAuthnError("bad_attestation", "malformed attestation object");
  }
  const authData = parseAuthData(authDataBytes);
  checkFlags(authData, input.rpId, input.requireUserVerification);
  if (!authData.attested) throw new WebAuthnError("bad_attestation", "no attested credential data");
  const { jwk, alg } = coseToJwk(authData.attested.cosePublicKey);
  const credentialId = b64urlEncode(authData.attested.credentialId);
  if (credentialId !== input.credential.rawId.replace(/=+$/u, "")) {
    throw new WebAuthnError("bad_attestation", "rawId does not match the attested credential id");
  }
  if (fmt === "packed") {
    if (attStmt.has("x5c"))
      throw new WebAuthnError("bad_attestation", "full packed attestation is not supported");
    const sig = attStmt.get("sig");
    if (!(sig instanceof Uint8Array) || Number(attStmt.get("alg")) !== alg) {
      throw new WebAuthnError("bad_attestation", "malformed packed self attestation");
    }
    const data = Buffer.concat([authDataBytes, sha256(clientDataJSON)]);
    if (!verifySignature(alg, jwk, data, sig))
      throw new WebAuthnError("bad_signature", "self attestation signature invalid");
  } else if (fmt !== "none") {
    throw new WebAuthnError("bad_attestation", `unsupported attestation format ${fmt}`);
  }
  return {
    credentialId,
    publicKeyJwk: jwk,
    alg,
    signCount: authData.signCount,
    fmt,
    userVerified: authData.userVerified,
  };
}

export type AuthenticationResponseJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
};

export function verifyAuthentication(input: {
  credential: AuthenticationResponseJSON;
  stored: StoredCredential;
  expectedChallenge: string;
  origins: readonly string[];
  rpId: string;
  requireUserVerification: boolean;
}): { newSignCount: number; userVerified: boolean } {
  const clientDataJSON = b64urlDecode(input.credential.response.clientDataJSON);
  checkClientData(clientDataJSON, {
    type: "webauthn.get",
    challenge: input.expectedChallenge,
    origins: input.origins,
  });
  const authDataBytes = b64urlDecode(input.credential.response.authenticatorData);
  const authData = parseAuthData(authDataBytes);
  checkFlags(authData, input.rpId, input.requireUserVerification);
  const data = Buffer.concat([authDataBytes, sha256(clientDataJSON)]);
  const signature = b64urlDecode(input.credential.response.signature);
  if (!verifySignature(input.stored.alg, input.stored.publicKeyJwk, data, signature)) {
    throw new WebAuthnError("bad_signature", "assertion signature invalid");
  }
  // WebAuthn §6.1.1: when either counter is non-zero the new one must be strictly greater.
  if (
    (authData.signCount !== 0 || input.stored.signCount !== 0) &&
    authData.signCount <= input.stored.signCount
  ) {
    throw new WebAuthnError(
      "counter_regression",
      `sign count ${authData.signCount} is not greater than stored ${input.stored.signCount}`,
    );
  }
  return { newSignCount: authData.signCount, userVerified: authData.userVerified };
}
