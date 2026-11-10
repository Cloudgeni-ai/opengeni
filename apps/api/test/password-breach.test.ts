import { describe, expect, test } from "bun:test";

import {
  managedAuthBreachedPasswordCheckEnabled,
  managedAuthPasswordBreached,
} from "../src/auth/password-breach";

describe("breached-password check", () => {
  test("is on outside local development and tests unless configured", () => {
    const enabled = (environment: string, managedAuthBreachedPasswordCheck?: boolean) =>
      managedAuthBreachedPasswordCheckEnabled({ environment, managedAuthBreachedPasswordCheck });
    expect(enabled("production")).toBe(true);
    expect(enabled("staging")).toBe(true);
    expect(enabled("local")).toBe(false);
    expect(enabled("test")).toBe(false);
    expect(enabled("production", false)).toBe(false);
    expect(enabled("local", true)).toBe(true);
  });

  test("reports what the lookup finds", async () => {
    const seen: string[] = [];
    const lookup = async (password: string) => {
      seen.push(password);
      return password === "password123";
    };
    expect(await managedAuthPasswordBreached("password123", { enabled: true, lookup })).toBe(true);
    expect(await managedAuthPasswordBreached("a fresh passphrase", { enabled: true, lookup })).toBe(
      false,
    );
    expect(seen).toEqual(["password123", "a fresh passphrase"]);
  });

  test("never looks up when off", async () => {
    let called = false;
    const lookup = async () => {
      called = true;
      return true;
    };
    expect(await managedAuthPasswordBreached("password123", { enabled: false, lookup })).toBe(
      false,
    );
    expect(called).toBe(false);
  });

  test("lets the password through when the lookup fails or stalls", async () => {
    const reasons: string[] = [];
    const onUnavailable = (reason: string) => reasons.push(reason);
    expect(
      await managedAuthPasswordBreached("password123", {
        enabled: true,
        lookup: async () => {
          throw new Error("network down");
        },
        onUnavailable,
      }),
    ).toBe(false);
    expect(
      await managedAuthPasswordBreached("password123", {
        enabled: true,
        lookup: () => new Promise<boolean>(() => {}),
        timeoutMs: 10,
        onUnavailable,
      }),
    ).toBe(false);
    expect(reasons).toEqual(["error", "timeout"]);
  });
});
