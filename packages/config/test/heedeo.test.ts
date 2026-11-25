import { expect, test } from "bun:test";

import { getSettings } from "../src/index";

const base = {
  OPENGENI_ENVIRONMENT: "test",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_PUBLIC_BASE_URL: "https://app.example.test",
  OPENGENI_BETTER_AUTH_SECRET: "better-auth-secret",
  OPENGENI_DELEGATION_SECRET: "delegation-secret",
};

test("Heedeo settings default to no keys and the documented endpoints", () => {
  const settings = getSettings(base);
  expect(settings.heedeoPublishableKey).toBeUndefined();
  expect(settings.heedeoSecretKey).toBeUndefined();
  expect(settings.heedeoApiUrl).toBe("https://app.heedeo.com");
  expect(settings.heedeoScriptUrl).toBe("https://heedeo.dev/i.js");
  expect(settings.heedeoTimeoutMs).toBe(1_500);
});

test("Heedeo settings read the keys and fall back leniently on bad values", () => {
  const settings = getSettings({
    ...base,
    OPENGENI_HEEDEO_PUBLISHABLE_KEY: "pk_test",
    OPENGENI_HEEDEO_SECRET_KEY: "sk_test",
    OPENGENI_HEEDEO_API_URL: "not a url",
    OPENGENI_HEEDEO_SCRIPT_URL: "https://cdn.example.test/i.js",
    OPENGENI_HEEDEO_TIMEOUT_MS: "60000",
  });
  expect(settings.heedeoPublishableKey).toBe("pk_test");
  expect(settings.heedeoSecretKey).toBe("sk_test");
  expect(settings.heedeoApiUrl).toBe("https://app.heedeo.com");
  expect(settings.heedeoScriptUrl).toBe("https://cdn.example.test/i.js");
  expect(settings.heedeoTimeoutMs).toBe(5_000);
  expect(getSettings({ ...base, OPENGENI_HEEDEO_TIMEOUT_MS: "1" }).heedeoTimeoutMs).toBe(100);
  expect(getSettings({ ...base, OPENGENI_HEEDEO_TIMEOUT_MS: "soon" }).heedeoTimeoutMs).toBe(1_500);
});
