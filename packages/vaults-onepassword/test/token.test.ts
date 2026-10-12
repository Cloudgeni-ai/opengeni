import { describe, expect, test } from "bun:test";

import { VaultProviderError } from "../src/contract";
import { describeOnePasswordToken, onePasswordTokenFingerprint } from "../src/token";
import { fakeServiceAccountToken } from "./fake-sdk";

describe("offline service-account token check", () => {
  test("accepts a well-formed token and reports the sign-in host", () => {
    expect(describeOnePasswordToken(fakeServiceAccountToken())).toEqual({
      accountName: "my.1password.com",
      fake: false,
    });
  });

  test.each([
    ["missing prefix", "abc"],
    ["not base64 json", "ops_%%%%"],
    ["json without key material", `ops_${Buffer.from(JSON.stringify({ signInAddress: "x" })).toString("base64")}`],
  ])("rejects %s without echoing the token", (_label, token) => {
    try {
      describeOnePasswordToken(token);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultProviderError);
      expect((error as VaultProviderError).code).toBe("provider_auth_invalid");
      expect((error as Error).message).not.toContain(token);
    }
  });

  test("fake dev tokens only when explicitly allowed", () => {
    expect(() => describeOnePasswordToken("ops_fake_healthy")).toThrow();
    expect(describeOnePasswordToken("ops_fake_healthy", { allowFakeTokens: true }).fake).toBe(true);
  });

  test("fingerprints are stable and do not contain the token", async () => {
    const token = fakeServiceAccountToken();
    const a = await onePasswordTokenFingerprint(token);
    expect(a).toBe(await onePasswordTokenFingerprint(` ${token} `));
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });
});
