import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  createManagedAuthDatabasePool,
  MANAGED_AUTH_DATABASE_POOL_ERRORS_METRIC,
  MANAGED_AUTH_DATABASE_POOL_OPTIONS,
} from "../src/auth/managed-auth";
import {
  MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES,
  MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX,
  MANAGED_AUTH_EMAIL_THROTTLES,
  ManagedAuthEmailThrottleError,
  managedAuthEmailSourceThrottleKey,
  managedAuthEmailThrottleFor,
  managedAuthEmailThrottleKey,
  managedAuthThrottleSource,
} from "../src/auth/managed-auth-rate-limits";
import {
  TRUSTED_CLIENT_ADDRESS_HEADER,
  UNKNOWN_REQUEST_SOURCE_ADDRESS,
} from "../src/http/request-source";

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

  test("never give email sign-in or sign-up less than Better Auth's previous default", () => {
    // Better Auth defaulted to 3 per 10 s. Behind a source-NATed edge every
    // user shares a few node addresses, so these bound the whole deployment.
    for (const path of ["/sign-in/email", "/sign-up/email"] as const) {
      const rule = MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES[path];
      expect(rule.max / rule.window).toBeGreaterThanOrEqual(3 / 10);
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

  test("need several client addresses to lock one email out", () => {
    for (const throttle of Object.values(MANAGED_AUTH_EMAIL_THROTTLES)) {
      expect(throttle.perSourceMax).toBeGreaterThan(0);
      expect(throttle.perEmailMax / throttle.perSourceMax).toBeGreaterThanOrEqual(5);
    }
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

  test("key one (email, client address) pair without storing either", () => {
    const key = managedAuthEmailSourceThrottleKey(
      "secret",
      "sign_in",
      " Victim@Example.TEST ",
      "203.0.113.7",
    );
    expect(key).toBe(
      managedAuthEmailSourceThrottleKey("secret", "sign_in", "victim@example.test", "203.0.113.7"),
    );
    expect(key.startsWith(`${MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX}sign_in:source:`)).toBe(true);
    expect(key.toLowerCase()).not.toContain("victim");
    expect(key).not.toContain("203.0.113.7");
    expect(key).not.toContain("|");
    expect(key).not.toBe(managedAuthEmailThrottleKey("secret", "sign_in", "victim@example.test"));
    expect(key).not.toBe(
      managedAuthEmailSourceThrottleKey("secret", "sign_in", "victim@example.test", "203.0.113.8"),
    );
    expect(key).not.toBe(
      managedAuthEmailSourceThrottleKey("secret", "sign_up", "victim@example.test", "203.0.113.7"),
    );
  });

  test("take the limiter source from the address the API stamped", () => {
    const stamped = (value: string) => new Headers({ [TRUSTED_CLIENT_ADDRESS_HEADER]: value });
    expect(managedAuthThrottleSource(stamped("203.0.113.7"))).toBe("203.0.113.7");
    // One IPv6 subscriber block is one source, as in Better Auth's limiter.
    expect(managedAuthThrottleSource(stamped("2001:DB8:1:2::99"))).toBe("2001:db8:1:2::/64");
    expect(managedAuthThrottleSource(stamped("2001:db8:1:2:ffff::1"))).toBe("2001:db8:1:2::/64");
    expect(managedAuthThrottleSource(stamped("not-an-address"))).toBe(
      UNKNOWN_REQUEST_SOURCE_ADDRESS,
    );
    expect(managedAuthThrottleSource(new Headers())).toBe(UNKNOWN_REQUEST_SOURCE_ADDRESS);
    expect(managedAuthThrottleSource(undefined)).toBe(UNKNOWN_REQUEST_SOURCE_ADDRESS);
  });

  test("refuse as an ordinary Better Auth 429 with a retry hint", () => {
    const error = new ManagedAuthEmailThrottleError(42);
    // Better Auth's router renders any error named APIError as its response.
    expect(error.name).toBe("APIError");
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
    const counters: Array<{ name: string; labels: unknown }> = [];
    const pool = createManagedAuthDatabasePool("postgres://unused@127.0.0.1:1/unused", {
      warn: (message, attributes) => warnings.push([message, attributes]),
      incrementCounter: ({ name, labels }) => counters.push({ name, labels }),
    });
    const failing = createManagedAuthDatabasePool("postgres://unused@127.0.0.1:1/unused", {
      warn: () => {
        throw new Error("observer unavailable");
      },
      incrementCounter: () => undefined,
    });
    try {
      pool.emit("error", new Error("terminating connection for user@example.test"));
      expect(counters).toEqual([
        {
          name: MANAGED_AUTH_DATABASE_POOL_ERRORS_METRIC.name,
          labels: { outcome: "idle_connection_discarded" },
        },
      ]);
      expect(MANAGED_AUTH_DATABASE_POOL_ERRORS_METRIC.name).toBe(
        "opengeni_managed_auth_database_pool_errors_total",
      );
      expect(warnings).toEqual([
        [
          "Managed auth database connection failed",
          { dependency: "managed_auth_database", outcome: "idle_connection_discarded" },
        ],
      ]);
      expect(() => failing.emit("error", new Error("terminating connection"))).not.toThrow();
    } finally {
      await pool.end();
      await failing.end();
    }
  });

  test("counts a checked-out connection failure once and an idle one only on the pool", async () => {
    const counters: unknown[] = [];
    const pool = createManagedAuthDatabasePool("postgres://unused@127.0.0.1:1/unused", {
      warn: () => undefined,
      incrementCounter: ({ labels }) => counters.push(labels),
    });
    try {
      const client = new EventEmitter();
      pool.emit("connect", client);
      pool.emit("acquire", client);
      expect(() => client.emit("error", new Error("terminating connection"))).not.toThrow();
      expect(counters).toEqual([{ outcome: "checked_out_connection_failed" }]);

      // Released, the client's own error is the pool's idle error; count it once.
      pool.emit("release", undefined, client);
      expect(() => client.emit("error", new Error("terminating connection"))).not.toThrow();
      expect(counters).toEqual([{ outcome: "checked_out_connection_failed" }]);
    } finally {
      await pool.end();
    }
  });
});
