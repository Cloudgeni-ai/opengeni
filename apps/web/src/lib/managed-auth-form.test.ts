import { describe, expect, test } from "bun:test";

import { AuthApiError } from "@/api";
import {
  ManagedAuthSessionUnavailableError,
  managedAuthFailure,
  validateManagedAuthInput,
} from "./managed-auth-form";

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
    });
    expect(
      managedAuthFailure(
        "signin",
        new AuthApiError(401, "INVALID_EMAIL_OR_PASSWORD", null, "Invalid email or password"),
      ).message,
    ).toBe("Email or password is incorrect.");
  });

  test("explains a signup that created an account without a browser session", () => {
    expect(
      managedAuthFailure("signup", new ManagedAuthSessionUnavailableError("signup")),
    ).toMatchObject({ switchTo: "signin" });
  });
});
