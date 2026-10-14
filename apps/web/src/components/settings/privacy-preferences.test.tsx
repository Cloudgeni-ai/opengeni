import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyPreferencesSection } from "./privacy-preferences";
import type { ClientConfig } from "@/types";

describe("Your account privacy preferences", () => {
  test("is a row under Privacy when the deployment asks for analytics consent", () => {
    const analytics: ClientConfig["analytics"] = {
      consentRequired: true,
      providers: { posthog: { projectKey: "phc_test", host: "https://us.i.posthog.com" } },
    };
    const markup = renderToStaticMarkup(<PrivacyPreferencesSection analytics={analytics} />);
    expect(markup).toContain("Privacy");
    expect(markup).toContain("Analytics preferences");
    expect(markup).toContain("Manage");
  });

  test("does not exist when analytics consent isn't configured", () => {
    expect(renderToStaticMarkup(<PrivacyPreferencesSection analytics={undefined} />)).toBe("");
    const analytics: ClientConfig["analytics"] = {
      consentRequired: false,
      providers: { posthog: { projectKey: "phc_test", host: "https://us.i.posthog.com" } },
    };
    expect(renderToStaticMarkup(<PrivacyPreferencesSection analytics={analytics} />)).toBe("");
  });
});
