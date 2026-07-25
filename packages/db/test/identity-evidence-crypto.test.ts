import { describe, expect, test } from "bun:test";
import { createHmac, hkdfSync } from "node:crypto";
import {
  decryptIdentityEvidence,
  encryptIdentityEvidence,
  IDENTITY_EVIDENCE_AUDIENCE,
  IDENTITY_EVIDENCE_MAX_BYTES,
  IDENTITY_EVIDENCE_PURPOSE,
  IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_INFO,
  IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_SALT,
  identityEvidenceReceiptIdentityHash,
  identityEvidenceKeyVersion,
  type IdentityEvidenceContext,
} from "../src/identity-evidence-crypto";

const key = new Uint8Array(32).fill(7);

function context(overrides: Partial<IdentityEvidenceContext> = {}): IdentityEvidenceContext {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    operationId: "00000000-0000-4000-8000-000000000002",
    subjectId: "user:recovery-custodian",
    audience: IDENTITY_EVIDENCE_AUDIENCE,
    purpose: IDENTITY_EVIDENCE_PURPOSE,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("identity recovery evidence envelope", () => {
  test("round-trips with a non-secret key version and never embeds plaintext", () => {
    const proof = "minimal-sensitive-proof";
    const binding = context();
    const encrypted = encryptIdentityEvidence(key, binding, proof);
    expect(encrypted.keyVersion).toBe(identityEvidenceKeyVersion(key));
    expect(encrypted.ciphertext).toStartWith(`iev1:${encrypted.keyVersion}:`);
    expect(encrypted.ciphertext).not.toContain(proof);
    expect(decryptIdentityEvidence(key, binding, encrypted.ciphertext, encrypted.keyVersion)).toBe(
      proof,
    );
  });

  test("uses purpose-separated HMAC input under a stable receipt identity root", () => {
    const proof = "minimal-sensitive-proof";
    const receiptIdentitySecret = new Uint8Array(32).fill(9);
    const identity = identityEvidenceReceiptIdentityHash(receiptIdentitySecret, proof);
    const receiptRoot = Buffer.from(
      hkdfSync(
        "sha256",
        receiptIdentitySecret,
        Buffer.from(IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_SALT, "utf8"),
        IDENTITY_EVIDENCE_RECEIPT_IDENTITY_KDF_INFO,
        32,
      ),
    );
    const rawHmac = createHmac("sha256", receiptRoot).update(proof, "utf8").digest("hex");
    expect(identity).toHaveLength(64);
    expect(identity).not.toBe(rawHmac);
    expect(identity).toBe(identityEvidenceReceiptIdentityHash(receiptIdentitySecret, proof));
    expect(identity).not.toBe(
      identityEvidenceReceiptIdentityHash(receiptIdentitySecret, `${proof}-different`),
    );
    expect(identity).not.toContain(proof);
  });

  test("fails closed when tenant, operation, subject, purpose-bound expiry, or bytes change", () => {
    const binding = context();
    const encrypted = encryptIdentityEvidence(key, binding, "proof");
    for (const changed of [
      context({ accountId: "00000000-0000-4000-8000-000000000009" }),
      context({ operationId: "00000000-0000-4000-8000-000000000009" }),
      context({ subjectId: "user:other" }),
      context({ expiresAt: new Date(binding.expiresAt.getTime() + 1) }),
    ]) {
      expect(() =>
        decryptIdentityEvidence(key, changed, encrypted.ciphertext, encrypted.keyVersion),
      ).toThrow("identity evidence authentication failed");
    }
    const tampered = `${encrypted.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptIdentityEvidence(key, binding, tampered, encrypted.keyVersion)).toThrow(
      "identity evidence authentication failed",
    );
  });

  test("treats key rotation as revocation and keeps failures data-free", () => {
    const binding = context();
    const encrypted = encryptIdentityEvidence(key, binding, "never-log-this-proof");
    const rotated = new Uint8Array(32).fill(8);
    let failure: Error | undefined;
    try {
      decryptIdentityEvidence(rotated, binding, encrypted.ciphertext, encrypted.keyVersion);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe("identity evidence key rotation requires fresh approval");
    expect(failure?.message).not.toContain("never-log-this-proof");
    expect(failure?.message).not.toContain(binding.subjectId);
    expect(failure?.message).not.toContain(encrypted.ciphertext);
  });

  test("caps evidence bytes and authenticated expiry", () => {
    expect(() =>
      encryptIdentityEvidence(key, context(), "x".repeat(IDENTITY_EVIDENCE_MAX_BYTES + 1)),
    ).toThrow();
    expect(() =>
      encryptIdentityEvidence(
        key,
        context({ expiresAt: new Date(Date.now() + 16 * 60_000) }),
        "proof",
      ),
    ).toThrow("invalid identity evidence context");
  });
});
