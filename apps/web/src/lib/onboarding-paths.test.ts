import { describe, expect, test } from "bun:test";

import { onboardingDestination, onboardingIntentFromAttribution } from "./onboarding-paths";

describe("first-run paths", () => {
  test("Product Hunt visitors start on Build; everyone else picks", () => {
    expect(onboardingIntentFromAttribution({ ref: "producthunt" })).toBe("build");
    expect(onboardingIntentFromAttribution({ ref: "ProductHunt" })).toBe("build");
    expect(onboardingIntentFromAttribution({ utmSource: "product-hunt" })).toBe("build");
    expect(onboardingIntentFromAttribution({ ref: "hackernews" })).toBeNull();
    expect(onboardingIntentFromAttribution(null)).toBeNull();
  });

  test("setup continues on the first-agent page in the Personal workspace", () => {
    expect(onboardingDestination("ws-personal", "product")).toEqual({
      to: "/workspaces/ws-personal/first-agent?step=product",
    });
    expect(onboardingDestination("ws-personal", "work").to).toBe(
      "/workspaces/ws-personal/first-agent?step=ready",
    );
    // Skip goes to the ready moment too.
    expect(onboardingDestination("ws-personal", null).to).toBe(
      "/workspaces/ws-personal/first-agent?step=ready",
    );
  });
});
