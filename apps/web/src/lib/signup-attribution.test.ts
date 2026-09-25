import { afterEach, describe, expect, test } from "bun:test";

import {
  resetSignupAttributionForTests,
  retainSignupAttribution,
  signupAttribution,
  signupAttributionAnalyticsProperties,
  signupReturnPath,
  takePendingAuthReturn,
} from "./signup-attribution";

function landing(href: string) {
  const replaced: string[] = [];
  const target = {
    location: { href },
    history: {
      state: { key: "router-state" },
      replaceState: (state: unknown, _title: string, url: string) => {
        expect(state).toEqual({ key: "router-state" });
        replaced.push(url);
      },
    },
  } as unknown as Window;
  return { target, replaced };
}

afterEach(() => resetSignupAttributionForTests());

describe("first-touch sign-up attribution", () => {
  test("keeps only closed-charset campaign tokens in memory and leaves the URL alone", () => {
    const { target, replaced } = landing(
      "https://app.opengeni.ai/?mode=signup&utm_source=opengeni.ai&utm_medium=website&utm_campaign=hero-cta&utm_content=a%40b.example&utm_term=ignored",
    );
    retainSignupAttribution(target);
    expect(replaced).toEqual([]);
    expect(signupAttribution()).toEqual({
      utmSource: "opengeni.ai",
      utmMedium: "website",
      utmCampaign: "hero-cta",
    });
    expect(signupAttributionAnalyticsProperties()).toEqual({
      utm_source: "opengeni.ai",
      utm_medium: "website",
      utm_campaign: "hero-cta",
    });
  });

  test("first touch wins over later landings in the same page", () => {
    retainSignupAttribution(landing("https://app.opengeni.ai/?ref=producthunt").target);
    retainSignupAttribution(landing("https://app.opengeni.ai/?utm_source=newsletter").target);
    expect(signupAttribution()).toEqual({ ref: "producthunt" });
  });

  test("no attribution means no request field and a plain return path", () => {
    retainSignupAttribution(landing("https://app.opengeni.ai/").target);
    expect(signupAttribution()).toBeNull();
    expect(signupAttributionAnalyticsProperties()).toBeNull();
    expect(signupReturnPath("/")).toBe("/");
    expect(signupReturnPath("/", "email_verified")).toBe("/?auth_event=email_verified");
  });

  test("return paths carry first-touch tokens through full-page auth redirects", () => {
    retainSignupAttribution(
      landing("https://app.opengeni.ai/?ref=producthunt&utm_campaign=launch").target,
    );
    expect(signupReturnPath("/", "github_signup")).toBe(
      "/?utm_campaign=launch&ref=producthunt&auth_event=github_signup",
    );
    // Better Auth accepts relative callback URLs only from a closed charset.
    expect(signupReturnPath("/")).toMatch(/^\/(?!\/)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/);
  });

  test("consumes a return marker once and ignores failed or unknown markers", () => {
    const success = landing(
      "https://app.opengeni.ai/?utm_source=producthunt&auth_event=email_verified#top",
    );
    retainSignupAttribution(success.target);
    expect(success.replaced).toEqual(["/?utm_source=producthunt#top"]);
    expect(takePendingAuthReturn()).toBe("email_verified");
    expect(takePendingAuthReturn()).toBeNull();

    const failed = landing(
      "https://app.opengeni.ai/?auth_event=email_verified&error=INVALID_TOKEN",
    );
    retainSignupAttribution(failed.target);
    expect(failed.replaced).toEqual(["/?error=INVALID_TOKEN"]);
    expect(takePendingAuthReturn()).toBeNull();

    const forged = landing("https://app.opengeni.ai/?auth_event=admin");
    retainSignupAttribution(forged.target);
    expect(forged.replaced).toEqual(["/"]);
    expect(takePendingAuthReturn()).toBeNull();
  });

  test("never throws at boot", () => {
    expect(() =>
      retainSignupAttribution({ location: { href: "not a url" } } as unknown as Window),
    ).not.toThrow();
  });
});

describe("contract parity", () => {
  test("mirrors the server attribution contract without importing it at boot", async () => {
    const contract = await import("@opengeni/contracts");
    const local = await import("./signup-attribution");
    expect(local.SIGNUP_ATTRIBUTION_PARAMETERS).toEqual(contract.SIGNUP_ATTRIBUTION_URL_PARAMETERS);
    expect(local.SIGNUP_ATTRIBUTION_VALUE_MAX).toBe(contract.SIGNUP_ATTRIBUTION_VALUE_MAX_LENGTH);
    expect(local.SIGNUP_ATTRIBUTION_VALUE.source).toBe(
      contract.SIGNUP_ATTRIBUTION_VALUE_PATTERN.source,
    );
    for (const value of ["producthunt", "launch day", "a@b", "x".repeat(101), "", "hero/cta:1"]) {
      expect(local.isSignupAttributionValue(value)).toBe(
        contract.SignupAttribution.safeParse({ utmSource: value }).success,
      );
    }
  });
});
