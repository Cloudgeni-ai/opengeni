import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const ENVELOPE_VERSION = "iev1";
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENCRYPTION_KEY_CONTEXT = "opengeni/organization-governance/evidence-encryption/v1";
export const IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_SALT =
  "opengeni/organization-governance/receipt-identity-salt/v1" as const;
const RECEIPT_IDENTITY_KDF_SALT = Buffer.from(IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_SALT, "utf8");
export const IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_INFO =
  "opengeni/organization-governance/receipt-identity/v1" as const;
const RECEIPT_IDENTITY_HMAC_PURPOSE = "opengeni/organization-governance/receipt-identity-hmac/v1\0";

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
 * Produce the stable, non-reversible identity used by the approval command
 * receipt. This secret is independent from the rotating AES envelope key, so
 * an exact lost-response retry can replay after envelope-key rotation without
 * making a changed request look like the original one.
 *
 * HKDF separates the receipt root from every other secret purpose, while the
 * framed HMAC input separates this receipt identity from any raw HMAC use of
 * that root. The evidence itself is never returned, logged, or stored in the
 * receipt hash input object.
 */
export function identityEvidenceReceiptIdentityHash(
  receiptIdentitySecret: Uint8Array,
  evidence: string,
): string {
  assertReceiptIdentitySecret(receiptIdentitySecret);
  const receiptRoot = Buffer.from(
    hkdfSync(
      "sha256",
      receiptIdentitySecret,
      RECEIPT_IDENTITY_KDF_SALT,
      IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_INFO,
      KEY_BYTES,
    ),
  );
  return createHmac("sha256", receiptRoot)
    .update(RECEIPT_IDENTITY_HMAC_PURPOSE, "utf8")
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

function assertReceiptIdentitySecret(secret: Uint8Array): void {
  if (secret.length !== KEY_BYTES) {
    throw new Error("organization recovery receipt identity secret must be exactly 32 bytes");
  }
}

function deriveSubkey(rootKey: Uint8Array, context: string): Buffer {
  return createHmac("sha256", rootKey).update(context, "utf8").digest();
}
