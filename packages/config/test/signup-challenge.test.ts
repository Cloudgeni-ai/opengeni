import { expect, test } from "bun:test";
import { getSettings } from "../src/index";
const base = {
  OPENGENI_ENVIRONMENT: "test",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_PUBLIC_BASE_URL: "https://app.example.test",
  OPENGENI_BETTER_AUTH_SECRET: "better-auth-secret",
  OPENGENI_DELEGATION_SECRET: "delegation-secret",
};
test("signup challenge is explicit opt-in with complete configuration", () => {
  expect(getSettings(base).signupChallengeEnabled).toBe(false);
  expect(() => getSettings({ ...base, OPENGENI_SIGNUP_CHALLENGE_ENABLED: "true" })).toThrow(
    "Signup challenge requires",
  );
  expect(
    getSettings({
      ...base,
      OPENGENI_SIGNUP_CHALLENGE_ENABLED: "true",
      OPENGENI_SIGNUP_CHALLENGE_SITE_KEY: "site",
      OPENGENI_SIGNUP_CHALLENGE_SECRET_KEY: "secret",
      OPENGENI_SIGNUP_CHALLENGE_HOSTNAMES: "app.example.test",
    }).signupChallengeEnabled,
  ).toBe(true);
});
test("production rejects test keys on either side", () => {
  for (const key of [
    "OPENGENI_SIGNUP_CHALLENGE_SITE_KEY",
    "OPENGENI_SIGNUP_CHALLENGE_SECRET_KEY",
  ]) {
    expect(() =>
      getSettings({
        ...base,
        OPENGENI_ENVIRONMENT: "production",
        OPENGENI_SIGNUP_CHALLENGE_ENABLED: "true",
        OPENGENI_SIGNUP_CHALLENGE_SITE_KEY: "site",
        OPENGENI_SIGNUP_CHALLENGE_SECRET_KEY: "secret",
        OPENGENI_SIGNUP_CHALLENGE_HOSTNAMES: "app.example.test",
        [key]: "1x00000000000000000000AA",
      }),
    ).toThrow("test keys are forbidden");
  }
});
