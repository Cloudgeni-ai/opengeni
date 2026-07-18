import { describe, expect, test } from "bun:test";
import {
  hashCodexBrowserSession,
  signCodexRedemptionConfirmation,
  verifyCodexRedemptionConfirmation,
} from "../src/codex-redemption-security";

const secret = "ope24-test-hmac-secret";

describe("Codex reset-credit browser confirmation", () => {
  test("binds one five-minute confirmation to session, human, workspace, credential, credit and attempt", async () => {
    const browserSessionHash = await hashCodexBrowserSession("private-session-id");
    const claims = {
      version: 1 as const,
      attemptId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      credentialId: "00000000-0000-4000-8000-000000000003",
      creditId: "opaque-credit",
      subjectId: "user:owner",
      browserSessionHash,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };
    const token = await signCodexRedemptionConfirmation(secret, claims);
    expect(await verifyCodexRedemptionConfirmation(secret, token)).toEqual(claims);
    expect(token).not.toContain("private-session-id");
  });

  test("rejects tampering, another secret, and expiry", async () => {
    const token = await signCodexRedemptionConfirmation(secret, {
      version: 1,
      attemptId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      credentialId: crypto.randomUUID(),
      creditId: "opaque-credit",
      subjectId: "user:owner",
      browserSessionHash: await hashCodexBrowserSession("session"),
      expiresAt: Math.floor(Date.now() / 1000) + 1,
    });
    expect(await verifyCodexRedemptionConfirmation("wrong", token)).toBeNull();
    expect(await verifyCodexRedemptionConfirmation(secret, `${token}x`)).toBeNull();
    expect(await verifyCodexRedemptionConfirmation(secret, token, Date.now() + 2_000)).toBeNull();
  });
});
