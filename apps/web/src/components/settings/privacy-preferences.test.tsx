import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let analytics: unknown = null;
mock.module("@/context", () => ({
  useAppContext: () => ({ clientConfig: { analytics } }),
}));

const { PrivacyPreferencesSection } = await import("./privacy-preferences");

afterAll(() => mock.restore());

describe("Your account privacy preferences", () => {
  test("is a row under Privacy when the deployment asks for analytics consent", () => {
    analytics = { consentRequired: true, providers: { posthog: { key: "phc_test" } } };
    const markup = renderToStaticMarkup(<PrivacyPreferencesSection />);
    expect(markup).toContain("Privacy");
    expect(markup).toContain("Analytics preferences");
    expect(markup).toContain("Manage");
  });

  test("does not exist when analytics consent isn't configured", () => {
    analytics = null;
    expect(renderToStaticMarkup(<PrivacyPreferencesSection />)).toBe("");
    analytics = { consentRequired: false, providers: { posthog: { key: "phc_test" } } };
    expect(renderToStaticMarkup(<PrivacyPreferencesSection />)).toBe("");
  });
});
