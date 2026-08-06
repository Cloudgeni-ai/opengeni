import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { signEnrollmentBearer, verifyEnrollmentBearer } from "../src/index";

const SECRET = "test-enrollment-bearer-generation-secret";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function baseClaims() {
  return {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    enrollmentId: AGENT,
    subjectPrefix: `agent.${WORKSPACE}.${AGENT}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("enrollment bearer credential generation", () => {
  test("newly signed bearers explicitly carry and verify their generation", async () => {
    const token = await signEnrollmentBearer(SECRET, {
      ...baseClaims(),
      credentialGeneration: 7,
    });
    const encodedPayload = token.slice("oge_".length).split(".")[0]!;
    const rawPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    expect(rawPayload.credentialGeneration).toBe(7);
    expect((await verifyEnrollmentBearer(SECRET, token))?.credentialGeneration).toBe(7);
  });

  test("a legacy generationless bearer parses only as generation 1", async () => {
    const encodedPayload = Buffer.from(JSON.stringify(baseClaims()), "utf8").toString("base64url");
    const signature = createHmac("sha256", SECRET).update(encodedPayload).digest("base64url");
    const legacyToken = `oge_${encodedPayload}.${signature}`;

    const verified = await verifyEnrollmentBearer(SECRET, legacyToken);
    expect(verified).toEqual({ ...baseClaims(), credentialGeneration: 1 });
  });

  test("non-positive generations and malformed signed JSON fail closed", async () => {
    for (const credentialGeneration of [0, -1]) {
      const payload = { ...baseClaims(), credentialGeneration };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
      expect(await verifyEnrollmentBearer(SECRET, `oge_${encoded}.${signature}`)).toBeNull();
    }

    const encoded = Buffer.from("not json", "utf8").toString("base64url");
    const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    expect(await verifyEnrollmentBearer(SECRET, `oge_${encoded}.${signature}`)).toBeNull();
  });
});
