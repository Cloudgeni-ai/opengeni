import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, verifyDelegatedAccessToken } from "../src/index";

const secret = "setup-version-boundary-test";
const now = 1_900_000_000;
const base = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "worker:first-party-mcp",
  principalKind: "human_session" as const,
  permissions: ["workspace:admin" as const],
  exp: now + 60,
};

// The exact pre-setup MAC rules: older consumers recognize ogd_/ogd2_ only.
function legacyVerifies(token: string): boolean {
  const prefix = token.startsWith("ogd2_") ? "ogd2_" : token.startsWith("ogd_") ? "ogd_" : null;
  if (!prefix) return false;
  const [payload, signature] = token.slice(prefix.length).split(".");
  if (!payload || !signature) return false;
  return (
    signature ===
    createHmac("sha256", secret)
      .update(prefix === "ogd2_" ? `${prefix}${payload}` : payload)
      .digest("base64url")
  );
}

describe("setup critical delegation envelope", () => {
  test("restricted tokens verify only under the ceiling-aware envelope", async () => {
    const token = await signDelegatedAccessToken(secret, {
      ...base,
      credentialRestriction: "developer_setup",
    });
    expect(token.startsWith("ogd3_")).toBe(true);
    expect((await verifyDelegatedAccessToken(secret, token, now))?.credentialRestriction).toBe(
      "developer_setup",
    );
    expect(legacyVerifies(token)).toBe(false);
    for (const prefix of ["ogd_", "ogd2_"]) {
      const downgraded = token.replace(/^ogd3_/, prefix);
      expect(legacyVerifies(downgraded)).toBe(false);
      expect(await verifyDelegatedAccessToken(secret, downgraded, now)).toBeNull();
    }
  });

  test("ordinary non-setup tokens retain the exact legacy format and MAC", async () => {
    const token = await signDelegatedAccessToken(secret, base);
    expect(token.startsWith("ogd_")).toBe(true);
    expect(legacyVerifies(token)).toBe(true);
    expect(await verifyDelegatedAccessToken(secret, token, now)).toEqual(base);
  });

  test("service-capable non-setup tokens retain their existing envelope", async () => {
    const payload = {
      ...base,
      principalKind: "service" as const,
      serviceInitiator: { kind: "service" as const, subjectId: "host:job" },
      serviceInitiatorContext: { job: "run" },
    };
    const token = await signDelegatedAccessToken(secret, payload);
    expect(token.startsWith("ogd2_")).toBe(true);
    expect(legacyVerifies(token)).toBe(true);
    expect(await verifyDelegatedAccessToken(secret, token, now)).toEqual(payload);
  });

  test("a correctly signed legacy envelope cannot conceal a restricted payload", async () => {
    const payload = Buffer.from(
      JSON.stringify({ ...base, credentialRestriction: "developer_setup" }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(await verifyDelegatedAccessToken(secret, `ogd_${payload}.${signature}`, now)).toBeNull();
  });
});
