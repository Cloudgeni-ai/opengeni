import { describe, expect, test } from "bun:test";

import {
  SIGNUP_ACQUISITION_SOURCES,
  SignupAttribution,
  signupAcquisitionSource,
} from "../src/index";

describe("sign-up acquisition attribution", () => {
  test("missing attribution is a direct visit", () => {
    expect(signupAcquisitionSource(undefined)).toBe("direct");
    expect(signupAcquisitionSource(null)).toBe("direct");
    expect(signupAcquisitionSource({})).toBe("direct");
  });

  test("recognizes Product Hunt from utm_source or ref", () => {
    expect(signupAcquisitionSource({ ref: "producthunt" })).toBe("producthunt");
    expect(signupAcquisitionSource({ utmSource: "ProductHunt" })).toBe("producthunt");
    expect(signupAcquisitionSource({ utmSource: "product-hunt" })).toBe("producthunt");
    expect(signupAcquisitionSource({ utmSource: "PH" })).toBe("producthunt");
    expect(signupAcquisitionSource({ ref: "producthunt", utmSource: "opengeni.ai" })).toBe(
      "producthunt",
    );
  });

  test("recognizes the marketing website CTA link", () => {
    expect(
      signupAcquisitionSource({
        utmSource: "opengeni.ai",
        utmMedium: "website",
        utmCampaign: "hero-cta",
      }),
    ).toBe("website");
    expect(signupAcquisitionSource({ utmSource: "docs.opengeni.ai" })).toBe("website");
    expect(signupAcquisitionSource({ utmMedium: "website" })).toBe("website");
  });

  test("any other or malformed attribution is other, never a free-form label", () => {
    expect(signupAcquisitionSource({ utmSource: "newsletter" })).toBe("other");
    expect(signupAcquisitionSource({ utmCampaign: "launch" })).toBe("other");
    expect(signupAcquisitionSource({ utmSource: "person@example.com" })).toBe("other");
    expect(signupAcquisitionSource({ utmSource: "x".repeat(101) })).toBe("other");
    expect(signupAcquisitionSource({ unexpected: "producthunt" })).toBe("other");
    expect(signupAcquisitionSource("producthunt")).toBe("other");
    for (const input of [{ ref: "producthunt" }, { utmSource: "opengeni.ai" }, {}, "x"]) {
      expect(SIGNUP_ACQUISITION_SOURCES).toContain(signupAcquisitionSource(input));
    }
  });

  test("attribution values are closed-charset campaign tokens", () => {
    expect(SignupAttribution.safeParse({ utmCampaign: "launch day 2026" }).success).toBe(true);
    expect(SignupAttribution.safeParse({ utmContent: "hero/cta:top" }).success).toBe(true);
    expect(SignupAttribution.safeParse({ utmSource: "a?b=c" }).success).toBe(false);
    expect(SignupAttribution.safeParse({ utmSource: "" }).success).toBe(false);
  });
});
