import { describe, expect, test } from "bun:test";

import {
  managedAuthRequiresEmailVerification,
  managedAuthUserCreateOverride,
} from "../src/auth/managed-auth";

describe("managed auth email verification posture", () => {
  test("lets local development exercise sign-up without an email provider", () => {
    expect(managedAuthRequiresEmailVerification({ environment: "local" })).toBe(false);
  });

  test("keeps email verification enabled outside local development", () => {
    expect(managedAuthRequiresEmailVerification({ environment: "test" })).toBe(true);
    expect(managedAuthRequiresEmailVerification({ environment: "production" })).toBe(true);
  });

  test("attests local sign-ups as verified before invitation binding and session creation", () => {
    expect(
      managedAuthUserCreateOverride(
        { environment: "local" },
        { id: "user-1", emailVerified: false },
      ),
    ).toEqual({
      data: { id: "user-1", emailVerified: true },
    });
    expect(
      managedAuthUserCreateOverride(
        { environment: "production" },
        { id: "user-1", emailVerified: false },
      ),
    ).toBeUndefined();
  });
});
