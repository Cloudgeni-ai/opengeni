import { describe, expect, test } from "bun:test";
import { getSettings } from "../src";

// OP-7: the in-memory fake 1Password tokens are a local development switch.
const managedProduction = {
  OPENGENI_ENVIRONMENT: "production",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
  OPENGENI_BETTER_AUTH_SECRET: "managed-better-auth-secret",
  OPENGENI_DELEGATION_SECRET: "managed-delegation-secret",
  OPENGENI_RESEND_API_KEY: "re_test",
  OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("OPENGENI_ONEPASSWORD_FAKE_TOKENS posture", () => {
  test("defaults off", () => {
    expect(getSettings({}).onePasswordFakeTokens).toBe(false);
    expect(getSettings(managedProduction).onePasswordFakeTokens).toBe(false);
  });

  test("the managed runtime refuses to start with fake tokens enabled", () => {
    expect(() =>
      getSettings({ ...managedProduction, OPENGENI_ONEPASSWORD_FAKE_TOKENS: "true" }),
    ).toThrow(/OPENGENI_ONEPASSWORD_FAKE_TOKENS/);
    expect(() =>
      getSettings({
        ...managedProduction,
        OPENGENI_ENVIRONMENT: "staging",
        OPENGENI_ONEPASSWORD_FAKE_TOKENS: "1",
      }),
    ).toThrow(/refused by the managed runtime/);
  });

  test("local development and tests may enable them", () => {
    expect(getSettings({ OPENGENI_ONEPASSWORD_FAKE_TOKENS: "true" }).onePasswordFakeTokens).toBe(
      true,
    );
    expect(
      getSettings({
        ...managedProduction,
        OPENGENI_ENVIRONMENT: "local",
        OPENGENI_ONEPASSWORD_FAKE_TOKENS: "true",
      }).onePasswordFakeTokens,
    ).toBe(true);
  });
});
