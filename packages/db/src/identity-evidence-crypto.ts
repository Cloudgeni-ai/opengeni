import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = "iev1";
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENCRYPTION_KEY_CONTEXT = "opengeni/organization-governance/evidence-encryption/v1";
const IDEMPOTENCY_KEY_CONTEXT = "opengeni/organization-governance/evidence-idempotency/v1";

export const IDENTITY_EVIDENCE_AUDIENCE = "opengeni:organization-governance" as const;
export const IDENTITY_EVIDENCE_PURPOSE = "governance-recovery-approval" as const;
export const IDENTITY_EVIDENCE_MAX_TTL_MS = 15 * 60 * 1_000;
export const IDENTITY_EVIDENCE_MAX_BYTES = 4_096;

export type IdentityEvidenceContext = {
  accountId: string;
  operationId: string;
  subjectId: string;
  audience: typeof IDENTITY_EVIDENCE_AUDIENCE;
  purpose: typeof IDENTITY_EVIDENCE_PURPOSE;
  expiresAt: Date;
};

export type EncryptedIdentityEvidence = {
  ciphertext: string;
  keyVersion: string;
};

/**
 * Encrypt sensitive recovery evidence with AES-256-GCM and authenticated
 * context. The context deliberately binds tenant, operation, actor, audience,
 * purpose, and expiry so copying ciphertext to any other row fails closed.
 *
 * The key version is a non-secret fingerprint of the operator-held key. A key
 * rotation intentionally revokes every still-outstanding (maximum 15 minute)
 * evidence envelope instead of retaining an unbounded decryption key ring.
 */
export function encryptIdentityEvidence(
  key: Uint8Array,
  context: IdentityEvidenceContext,
  plaintext: string,
): EncryptedIdentityEvidence {
  assertKey(key);
  assertContext(context);
  const plaintextBytes = Buffer.byteLength(plaintext, "utf8");
  if (plaintextBytes === 0 || plaintextBytes > IDENTITY_EVIDENCE_MAX_BYTES) {
    throw new Error("identity evidence must not be empty");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveSubkey(key, ENCRYPTION_KEY_CONTEXT), iv);
  cipher.setAAD(contextBytes(context));
  const payload = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const keyVersion = identityEvidenceKeyVersion(key);
  return {
    ciphertext: `${ENVELOPE_VERSION}:${keyVersion}:${iv.toString("base64")}:${payload.toString("base64")}`,
    keyVersion,
  };
}

/**
 * Authenticate and decrypt one evidence envelope. Callers must separately
 * reject expired/revoked/consumed rows before invoking this function. Errors
 * never include plaintext, ciphertext, subjects, tenant ids, or key material.
 */
export function decryptIdentityEvidence(
  key: Uint8Array,
  context: IdentityEvidenceContext,
  stored: string,
  expectedKeyVersion: string,
): string {
  assertKey(key);
  assertContext(context);
  const activeKeyVersion = identityEvidenceKeyVersion(key);
  if (expectedKeyVersion !== activeKeyVersion) {
    throw new Error("identity evidence key rotation requires fresh approval");
  }
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION || parts[1] !== expectedKeyVersion) {
    throw new Error("unsupported identity evidence format");
  }
  const iv = Buffer.from(parts[2]!, "base64");
  const payload = Buffer.from(parts[3]!, "base64");
  if (iv.length !== IV_BYTES || payload.length <= GCM_TAG_BYTES) {
    throw new Error("unsupported identity evidence format");
  }
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveSubkey(key, ENCRYPTION_KEY_CONTEXT), iv);
  decipher.setAAD(contextBytes(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("identity evidence authentication failed");
  }
}

export function identityEvidenceKeyVersion(key: Uint8Array): string {
  assertKey(key);
  return createHash("sha256")
    .update(deriveSubkey(key, ENCRYPTION_KEY_CONTEXT))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Produce a non-reversible, key-bound digest for actor-scoped idempotency.
 * A distinct derived subkey prevents reuse of the AES-GCM key across
 * cryptographic purposes while keeping raw evidence out of command receipts.
 */
export function identityEvidenceIdempotencyDigest(key: Uint8Array, evidence: string): string {
  assertKey(key);
  return createHmac("sha256", deriveSubkey(key, IDEMPOTENCY_KEY_CONTEXT))
    .update(evidence, "utf8")
    .digest("hex");
}

function contextBytes(context: IdentityEvidenceContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      ENVELOPE_VERSION,
      context.accountId,
      context.operationId,
      context.subjectId,
      context.audience,
      context.purpose,
      context.expiresAt.toISOString(),
    ]),
    "utf8",
  );
}

function assertContext(context: IdentityEvidenceContext): void {
  const now = Date.now();
  if (
    !context.accountId ||
    !context.operationId ||
    !context.subjectId ||
    context.audience !== IDENTITY_EVIDENCE_AUDIENCE ||
    context.purpose !== IDENTITY_EVIDENCE_PURPOSE ||
    !Number.isFinite(context.expiresAt.getTime()) ||
    context.expiresAt.getTime() <= now ||
    context.expiresAt.getTime() > now + IDENTITY_EVIDENCE_MAX_TTL_MS
  ) {
    throw new Error("invalid identity evidence context");
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error("identity evidence encryption key must be exactly 32 bytes");
  }
}

function deriveSubkey(rootKey: Uint8Array, context: string): Buffer {
  return createHmac("sha256", rootKey).update(context, "utf8").digest();
}
