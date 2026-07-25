import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  decryptIdentityEvidence,
  encryptIdentityEvidence,
  IDENTITY_EVIDENCE_AUDIENCE,
  IDENTITY_EVIDENCE_MAX_BYTES,
  IDENTITY_EVIDENCE_PURPOSE,
  identityEvidenceIdempotencyDigest,
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

  test("uses a distinct derived key for non-reversible idempotency digests", () => {
    const proof = "minimal-sensitive-proof";
    const digest = identityEvidenceIdempotencyDigest(key, proof);
    const rawKeyDigest = createHmac("sha256", key).update(proof, "utf8").digest("hex");
    expect(digest).toHaveLength(64);
    expect(digest).not.toBe(rawKeyDigest);
    expect(digest).toBe(identityEvidenceIdempotencyDigest(key, proof));
    expect(digest).not.toBe(identityEvidenceIdempotencyDigest(key, `${proof}-different`));
    expect(digest).not.toContain(proof);
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
