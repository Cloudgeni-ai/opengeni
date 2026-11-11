import { describe, expect, test } from "bun:test";
import {
  EnrollTokenPayload,
  type EnrollTokenPayload as EnrollTokenPayloadType,
  enrollTokenScope,
  MintEnrollTokenRequest,
  signEnrollToken,
  signEnrollmentBearer,
  verifyEnrollToken,
  verifyEnrollmentBearer,
} from "../src/index";
import { z } from "zod";

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
      credentialGeneration: 1,
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

  test("a single-use token id round-trips; legacy tokens without one still verify", async () => {
    const single = payload({ jti: "AbCdEfGhIjKlMnOpQrStUvWx" });
    expect(await verifyEnrollToken(SECRET, await signEnrollToken(SECRET, single))).toEqual(single);
    const legacy = payload();
    expect(legacy.jti).toBeUndefined();
    expect(await verifyEnrollToken(SECRET, await signEnrollToken(SECRET, legacy))).toEqual(legacy);
    // Ids are bounded and URL-safe so the redemption ledger key stays predictable.
    expect(() => payload({ jti: "short" })).toThrow();
    expect(() => payload({ jti: "has spaces and is long enough" })).toThrow();
  });
});

describe("personal (user-owned) enroll tokens", () => {
  const owner = "user:alice";
  function personal(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return EnrollTokenPayload.parse({
      typ: "enroll_user",
      ownerSubjectId: owner,
      workspaceId: WORKSPACE_A,
      accountId: ACCOUNT_A,
      allowScreenControl: false,
      iat: now,
      exp: now + 3600,
      jti: "AbCdEfGhIjKlMnOpQrStUvWx",
      ...overrides,
    });
  }

  test("the signed owner round-trips and names the user scope", async () => {
    const claims = personal();
    const verified = await verifyEnrollToken(SECRET, await signEnrollToken(SECRET, claims));
    expect(verified).toEqual(claims);
    expect(verified && enrollTokenScope(verified)).toBe("user");
    expect(enrollTokenScope(payload())).toBe("workspace");
  });

  test("a personal token requires its owner, and the owner cannot be forged", async () => {
    expect(() => personal({ ownerSubjectId: undefined })).toThrow();
    expect(() => personal({ ownerSubjectId: "" })).toThrow();
    // Any organization member's subject fits (members allow up to 1024).
    const longest = `user:${"x".repeat(1019)}`;
    expect(personal({ ownerSubjectId: longest }).typ).toBe("enroll_user");
    expect(
      await verifyEnrollToken(
        SECRET,
        await signEnrollToken(SECRET, personal({ ownerSubjectId: longest })),
      ),
    ).toMatchObject({ ownerSubjectId: longest });
    expect(() => personal({ ownerSubjectId: `${longest}x` })).toThrow();
    const token = await signEnrollToken(SECRET, personal());
    const [, signature] = token.slice("oget_".length).split(".");
    const forged = Buffer.from(
      JSON.stringify(personal({ ownerSubjectId: "user:mallory" })),
      "utf8",
    ).toString("base64url");
    expect(await verifyEnrollToken(SECRET, `oget_${forged}.${signature}`)).toBeNull();
  });

  test("a personal token is always single-use: a signed one without an id is refused", async () => {
    expect(() => personal({ jti: undefined })).toThrow();
    expect(() => personal({ jti: "short" })).toThrow();
    // Correctly signed with the shared secret, but missing its id: never verifies.
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      typ: "enroll_user",
      ownerSubjectId: owner,
      workspaceId: WORKSPACE_A,
      accountId: ACCOUNT_A,
      allowScreenControl: false,
      iat: now,
      exp: now + 3600,
    };
    const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    expect(await verifyEnrollToken(SECRET, `oget_${encoded}.${signature}`)).toBeNull();
  });

  test("a verifier that predates personal tokens refuses one instead of sharing the machine", async () => {
    // The previous schema: typ was the literal "enroll" and unknown keys were
    // stripped. Parsing the personal token with it must fail, never yield a
    // workspace-shared grant without the owner.
    const previous = z.object({
      typ: z.literal("enroll"),
      workspaceId: z.string().uuid(),
      accountId: z.string().uuid(),
      allowScreenControl: z.boolean(),
      iat: z.number().int().nonnegative(),
      exp: z.number().int().positive(),
      jti: z.string().optional(),
    });
    expect(previous.safeParse(personal()).success).toBe(false);
  });

  test("a workspace token cannot smuggle an owner claim", () => {
    const parsed = payload({ ownerSubjectId: owner } as never);
    expect("ownerSubjectId" in parsed).toBe(false);
    expect(enrollTokenScope(parsed)).toBe("workspace");
  });

  test("mint requests accept only the two connect scopes", () => {
    expect(MintEnrollTokenRequest.parse({}).scope).toBeUndefined();
    expect(MintEnrollTokenRequest.parse({ scope: "user" }).scope).toBe("user");
    expect(MintEnrollTokenRequest.parse({ scope: "workspace" }).scope).toBe("workspace");
    expect(MintEnrollTokenRequest.safeParse({ scope: "organization" }).success).toBe(false);
  });
});
