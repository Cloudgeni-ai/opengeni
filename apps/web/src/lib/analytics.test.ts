import { describe, expect, test } from "bun:test";

import { analyticsHasProviders, setAnalyticsConsent, storedAnalyticsConsent } from "./analytics";

describe("analytics runtime", () => {
  test("recognizes only configured provider adapters", () => {
    expect(analyticsHasProviders({ consentRequired: true, providers: {} })).toBe(false);
    expect(
      analyticsHasProviders({
        consentRequired: true,
        providers: { reo: { clientId: "reo_client-1" } },
      }),
    ).toBe(true);
  });

  test("persists and validates consent choices", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(storedAnalyticsConsent(storage)).toBeNull();
    setAnalyticsConsent("granted", storage);
    expect(storedAnalyticsConsent(storage)).toBe("granted");
    values.set("opengeni.analyticsConsent", "invalid");
    expect(storedAnalyticsConsent(storage)).toBeNull();
  });
});
