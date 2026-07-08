import { describe, expect, test } from "bun:test";
import {
  EnrollTokenPayload,
  type EnrollTokenPayload as EnrollTokenPayloadType,
  signEnrollToken,
  signEnrollmentBearer,
  verifyEnrollToken,
  verifyEnrollmentBearer,
} from "../src/index";

// Self-hosted enrollment UX §A2.1 — the headless `oget_` enroll token. The token
// IS the grant (no human approve), so the sign/verify pair + its DOMAIN SEPARATION
// from the `oge_` bearer (shared signing secret) is the whole security boundary.

const SECRET = "test-enroll-token-secret";

// Valid v4 UUIDs (Zod v4 enforces the RFC 4122 version+variant bits).
const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_A = "22222222-2222-4222-8222-222222222222";

function payload(overrides: Partial<EnrollTokenPayloadType> = {}): EnrollTokenPayloadType {
  const now = Math.floor(Date.now() / 1000);
  return EnrollTokenPayload.parse({
    typ: "enroll",
    workspaceId: WORKSPACE_A,
    accountId: ACCOUNT_A,
    allowScreenControl: false,
    iat: now,
    exp: now + 3600,
    ...overrides,
  });
}

describe("EnrollTokenPayload sign/verify", () => {
  test("mint -> verify round-trip recovers the exact claims with the oget_ prefix", async () => {
    const claims = payload({ allowScreenControl: true });
    const token = await signEnrollToken(SECRET, claims);
    // The `oget_` prefix is what keeps the enroll token from being confused with
    // the `oge_` bearer (note: `oget_` is NOT a prefix of `oge_` and vice-versa is
    // false; the verifier checks the FULL `oget_` prefix).
    expect(token.startsWith("oget_")).toBe(true);
    const verified = await verifyEnrollToken(SECRET, token);
    expect(verified).toEqual(claims);
  });

  test("verify rejects a token signed with a different secret (bad signature)", async () => {
    const token = await signEnrollToken(SECRET, payload());
    expect(await verifyEnrollToken("a-different-secret", token)).toBeNull();
  });

  test("verify rejects an expired token (exp < now)", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signEnrollToken(
      SECRET,
      payload({ iat: nowSeconds - 10, exp: nowSeconds - 1 }),
    );
    expect(await verifyEnrollToken(SECRET, token, nowSeconds)).toBeNull();
    // ...and it still verifies fine BEFORE expiry.
    expect(await verifyEnrollToken(SECRET, token, nowSeconds - 5)).not.toBeNull();
  });

  test("verify rejects a tampered payload (signature no longer matches)", async () => {
    const token = await signEnrollToken(SECRET, payload({ workspaceId: WORKSPACE_A }));
    const [encoded, signature] = token.slice("oget_".length).split(".");
    // Swap the workspaceId in the payload but keep the original signature.
    const tamperedClaims = payload({ workspaceId: WORKSPACE_B });
    const tamperedEncoded = Buffer.from(JSON.stringify(tamperedClaims), "utf8").toString(
      "base64url",
    );
    expect(tamperedEncoded).not.toBe(encoded);
    const tamperedToken = `oget_${tamperedEncoded}.${signature}`;
    expect(await verifyEnrollToken(SECRET, tamperedToken)).toBeNull();
  });

  test("verify rejects a wrong typ (the typ literal is the second domain-separation half)", async () => {
    // Hand-craft a same-secret, otherwise-valid token whose typ is NOT "enroll".
    // It is correctly SIGNED (so HMAC passes) but the schema's z.literal("enroll")
    // rejects it — a token from another plane that reused this prefix is refused.
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      typ: "bearer",
      workspaceId: WORKSPACE_A,
      accountId: ACCOUNT_A,
      allowScreenControl: false,
      iat: now,
      exp: now + 3600,
    };
    const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    const token = `oget_${encoded}.${signature}`;
    expect(await verifyEnrollToken(SECRET, token)).toBeNull();
  });

  test("verify rejects an oge_ bearer + other malformed input (prefix discipline)", async () => {
    // An `oge_` enrollment bearer (same signing secret!) is NOT a valid enroll
    // token — the `oget_` prefix gate rejects it. This is the first half of the
    // domain separation; the typ literal is the second (above).
    const bearer = await signEnrollmentBearer(SECRET, {
      workspaceId: WORKSPACE_A,
      agentId: "33333333-3333-4333-8333-333333333333",
      enrollmentId: "33333333-3333-4333-8333-333333333333",
      subjectPrefix: `agent.${WORKSPACE_A}.x`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(bearer.startsWith("oge_")).toBe(true);
    expect(await verifyEnrollToken(SECRET, bearer)).toBeNull();
    expect(await verifyEnrollToken(SECRET, "oge_abc.def")).toBeNull();
    expect(await verifyEnrollToken(SECRET, "not-a-token")).toBeNull();
    expect(await verifyEnrollToken(SECRET, "oget_no-dot")).toBeNull();
    expect(await verifyEnrollToken(SECRET, "oget_.sig")).toBeNull();
  });

  test("the reverse half: an oget_ enroll token is NOT a valid oge_ bearer", async () => {
    // Symmetric domain separation — verifyEnrollmentBearer's `oge_` prefix check
    // rejects an `oget_` token, so the two planes never cross-verify even though
    // they share the signing secret.
    const token = await signEnrollToken(SECRET, payload());
    expect(await verifyEnrollmentBearer(SECRET, token)).toBeNull();
  });
});
