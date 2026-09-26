import { describe, expect, test } from "bun:test";

import { AuthApiError } from "@/api";
import {
  ManagedAuthSessionUnavailableError,
  managedAuthFailure,
  validateManagedAuthInput,
} from "./managed-auth-form";
import {
  clearVerificationLinkErrorFromLocation,
  managedAuthModeFromSearch,
  verificationLinkErrorFromSearch,
} from "./managed-auth-url";

describe("managed auth form", () => {
  test("returns specific signup field guidance", () => {
    expect(
      validateManagedAuthInput("signup", {
        name: "",
        email: "not-an-email",
        password: "short",
      }),
    ).toEqual({
      name: "Enter your name.",
      email: "Enter a valid email address.",
      password: "Choose a password with at least 8 characters.",
    });
  });

  test("does not enforce signup length rules while signing in", () => {
    expect(
      validateManagedAuthInput("signin", {
        name: "",
        email: "person@example.com",
        password: "short",
      }),
    ).toEqual({});
  });

  test("maps Better Auth failures without exposing transport JSON", () => {
    expect(
      managedAuthFailure(
        "signup",
        new AuthApiError(
          422,
          "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
          null,
          "User already exists. Use another email.",
        ),
      ),
    ).toEqual({
      fields: { email: "An account already exists for this email." },
      message: "Sign in with this email instead, or use a different email address.",
      switchTo: "signin",
      canResendVerification: false,
    });
    expect(
      managedAuthFailure(
        "signin",
        new AuthApiError(401, "INVALID_EMAIL_OR_PASSWORD", null, "Invalid email or password"),
      ).message,
    ).toBe("Email or password is incorrect.");
    expect(
      managedAuthFailure(
        "signin",
        new AuthApiError(403, "EMAIL_NOT_VERIFIED", null, "Email not verified"),
      ),
    ).toMatchObject({
      message: "Verify your email before signing in.",
      canResendVerification: true,
    });
  });

  test("explains a signup that created an account without a browser session", () => {
    expect(
      managedAuthFailure("signup", new ManagedAuthSessionUnavailableError("signup")),
    ).toMatchObject({ switchTo: "signin" });
  });

  test("opens Sign up only for the exact mode=signup deep link", () => {
    expect(
      managedAuthModeFromSearch(
        "?mode=signup&utm_source=opengeni.ai&utm_medium=website&utm_campaign=hero",
      ),
    ).toBe("signup");
    expect(managedAuthModeFromSearch("?mode=SIGNUP")).toBe("signup");
    expect(managedAuthModeFromSearch("")).toBeUndefined();
    expect(managedAuthModeFromSearch("?mode=signin")).toBeUndefined();
    expect(managedAuthModeFromSearch("?mode=admin")).toBeUndefined();
    expect(managedAuthModeFromSearch("?mode=signup&mode=signin")).toBeUndefined();
  });

  test("recognizes only Better Auth's verification-link failure codes", () => {
    expect(verificationLinkErrorFromSearch("?error=TOKEN_EXPIRED")).toBe("expired");
    expect(verificationLinkErrorFromSearch("?error=INVALID_TOKEN")).toBe("invalid");
    expect(verificationLinkErrorFromSearch("?error=access_denied")).toBeNull();
    expect(verificationLinkErrorFromSearch("?error=TOKEN_EXPIRED&error=INVALID_TOKEN")).toBeNull();
    expect(verificationLinkErrorFromSearch("")).toBeNull();
  });

  test("drops only a verification-link error from the address bar once it is handled", () => {
    const replaced: Array<{ state: unknown; url: string }> = [];
    const target = (href: string) => ({
      location: { href } as Location,
      history: {
        state: { key: "router-state" },
        replaceState: (state: unknown, _unused: string, url?: string | URL | null) =>
          replaced.push({ state, url: String(url) }),
      } as unknown as History,
    });
    clearVerificationLinkErrorFromLocation(
      target("https://app.example.test/?error=TOKEN_EXPIRED&utm_source=opengeni.ai#top"),
    );
    expect(replaced).toEqual([
      { state: { key: "router-state" }, url: "/?utm_source=opengeni.ai#top" },
    ]);
    clearVerificationLinkErrorFromLocation(target("https://app.example.test/?error=access_denied"));
    clearVerificationLinkErrorFromLocation(target("https://app.example.test/"));
    expect(replaced).toHaveLength(1);
  });

  test("keeps invalid credentials generic so accounts cannot be enumerated", () => {
    const failure = managedAuthFailure(
      "signin",
      new AuthApiError(401, "INVALID_EMAIL_OR_PASSWORD", null, "Invalid email or password"),
    );
    expect(failure.message).toBe("Email or password is incorrect.");
    expect(failure.fields).toEqual({});
    expect(failure.switchTo).toBeNull();
  });
});
