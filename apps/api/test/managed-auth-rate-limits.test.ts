import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth/api";

import {
  createManagedAuthDatabasePool,
  MANAGED_AUTH_DATABASE_POOL_OPTIONS,
} from "../src/auth/managed-auth";
import {
  MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES,
  MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX,
  MANAGED_AUTH_EMAIL_THROTTLES,
  ManagedAuthEmailThrottleError,
  managedAuthEmailThrottleFor,
  managedAuthEmailThrottleKey,
} from "../src/auth/managed-auth-rate-limits";

describe("managed auth client-address rate limits", () => {
  test("cover every credential and mail-sending endpoint", () => {
    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/sign-in/social",
      "/callback/*",
      "/request-password-reset",
      "/send-verification-email",
      "/verify-email",
      "/reset-password",
      "/reset-password/*",
    ]) {
      expect(MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES).toHaveProperty([path]);
    }
  });

  test("stay within Better Auth's 60 second database pruning horizon", () => {
    for (const rule of Object.values(MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES)) {
      expect(rule.window).toBeGreaterThan(0);
      expect(rule.window).toBeLessThanOrEqual(60);
      expect(rule.max).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("managed auth per-email throttles", () => {
  test("apply only to endpoints that verify a password or send mail", () => {
    expect(Object.keys(MANAGED_AUTH_EMAIL_THROTTLES).sort()).toEqual([
      "/request-password-reset",
      "/send-verification-email",
      "/sign-in/email",
      "/sign-up/email",
    ]);
    expect(managedAuthEmailThrottleFor("/sign-in/email")?.purpose).toBe("sign_in");
    expect(managedAuthEmailThrottleFor("/get-session")).toBeNull();
    expect(managedAuthEmailThrottleFor("constructor")).toBeNull();
  });

  test("key one normalized address without storing it", () => {
    const key = managedAuthEmailThrottleKey("secret", "sign_in", " Victim@Example.TEST ");
    expect(key).toBe(managedAuthEmailThrottleKey("secret", "sign_in", "victim@example.test"));
    expect(key.startsWith(`${MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX}sign_in:`)).toBe(true);
    expect(key.toLowerCase()).not.toContain("victim");
    expect(key).not.toBe(managedAuthEmailThrottleKey("secret", "sign_up", "victim@example.test"));
    expect(key).not.toBe(managedAuthEmailThrottleKey("other", "sign_in", "victim@example.test"));
    // Better Auth's own client-address keys are `address|path`; never collide.
    expect(key).not.toContain("|");
  });

  test("refuse as an ordinary Better Auth 429 with a retry hint", () => {
    const error = new ManagedAuthEmailThrottleError(42);
    expect(error).toBeInstanceOf(APIError);
    expect(error.statusCode).toBe(429);
    expect(error.body).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(new Headers(error.headers).get("x-retry-after")).toBe("42");
    expect(error.retryAfterSeconds).toBe(42);
  });
});

describe("managed auth database pool", () => {
  test("bounds connection waits and handles server-closed connections", async () => {
    const pool = createManagedAuthDatabasePool("postgres://unused@127.0.0.1:1/unused");
    try {
      expect(pool.options).toMatchObject(MANAGED_AUTH_DATABASE_POOL_OPTIONS);
      expect(MANAGED_AUTH_DATABASE_POOL_OPTIONS.connectionTimeoutMillis).toBeGreaterThan(0);
      expect(pool.listenerCount("error")).toBe(1);
      expect(pool.listenerCount("connect")).toBe(1);
      // No listener would make this an uncaught exception that exits the API.
      expect(() => pool.emit("error", new Error("terminating connection"))).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  test("records a content-free signal and survives a failing observer", async () => {
    const warnings: Array<[string, unknown]> = [];
    const counters: string[] = [];
    const pool = createManagedAuthDatabasePool("postgres://unused@127.0.0.1:1/unused", {
      warn: (message, attributes) => warnings.push([message, attributes]),
      incrementCounter: ({ name }) => counters.push(name),
    });
    const failing = createManagedAuthDatabasePool("postgres://unused@127.0.0.1:1/unused", {
      warn: () => {
        throw new Error("observer unavailable");
      },
      incrementCounter: () => undefined,
    });
    try {
      pool.emit("error", new Error("terminating connection for user@example.test"));
      expect(counters).toEqual(["opengeni_managed_auth_database_pool_errors_total"]);
      expect(warnings).toEqual([
        [
          "Managed auth database idle connection failed",
          { dependency: "managed_auth_database", outcome: "idle_connection_discarded" },
        ],
      ]);
      expect(() => failing.emit("error", new Error("terminating connection"))).not.toThrow();
    } finally {
      await pool.end();
      await failing.end();
    }
  });
});
