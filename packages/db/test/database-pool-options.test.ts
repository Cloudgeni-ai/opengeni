import { afterEach, describe, expect, test } from "bun:test";

import {
  createDb,
  databasePoolOptions,
  DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS,
  DEFAULT_DATABASE_POOL_MAX_LIFETIME_SECONDS,
  jitteredDatabaseMaxLifetime,
  MAX_DATABASE_POOL_TIMER_SECONDS,
  type DbClient,
} from "../src/database";

// createDb's pool is lazy: nothing below opens a connection, so the options the
// driver parsed can be read without a server.
const url = "postgres://app:fixture@127.0.0.1:1/opengeni";
const clients: DbClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

type ParsedPoolOptions = {
  idle_timeout: number;
  max_lifetime: number | (() => number);
  prepare: boolean;
};

function driverOptions(options: Parameters<typeof createDb>[1] = {}): ParsedPoolOptions {
  const client = createDb(url, options);
  clients.push(client);
  return (client.db as unknown as { $client: { options: ParsedPoolOptions } }).$client.options;
}

function lifetimes(option: ParsedPoolOptions["max_lifetime"], draws = 500): number[] {
  expect(typeof option).toBe("function");
  return Array.from({ length: draws }, () => (option as () => number)());
}

describe("pool recycling defaults", () => {
  test("idle connections close after 30 seconds", () => {
    expect(DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS).toBe(30);
    expect(driverOptions().idle_timeout).toBe(30);
  });

  test("each connection slot lives between 450 and 600 seconds", () => {
    expect(DEFAULT_DATABASE_POOL_MAX_LIFETIME_SECONDS).toBe(600);
    const drawn = lifetimes(driverOptions().max_lifetime);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(450);
    expect(Math.max(...drawn)).toBeLessThanOrEqual(600);
    // Jittered, so a pool opened in one burst does not reconnect in one burst.
    expect(new Set(drawn.map((seconds) => Math.floor(seconds))).size).toBeGreaterThan(50);
  });
});

describe("configured pool recycling", () => {
  test("passes the configured idle timeout and lifetime bound to the driver", () => {
    const options = driverOptions({ idleTimeoutSeconds: 7, maxLifetimeSeconds: 120 });
    expect(options.idle_timeout).toBe(7);
    const drawn = lifetimes(options.max_lifetime);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(90);
    expect(Math.max(...drawn)).toBeLessThanOrEqual(120);
  });

  test("0 turns either timer off, as postgres.js reads 0", () => {
    const options = driverOptions({ idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    expect(options.idle_timeout).toBe(0);
    expect(new Set(lifetimes(options.max_lifetime, 10))).toEqual(new Set([0]));
  });

  test("accepts the longest timer the runtime can arm", () => {
    expect(MAX_DATABASE_POOL_TIMER_SECONDS).toBe(Math.floor((2 ** 31 - 1) / 1000));
    const options = driverOptions({
      idleTimeoutSeconds: MAX_DATABASE_POOL_TIMER_SECONDS,
      maxLifetimeSeconds: MAX_DATABASE_POOL_TIMER_SECONDS,
    });
    expect(options.idle_timeout).toBe(MAX_DATABASE_POOL_TIMER_SECONDS);
    expect(Math.max(...lifetimes(options.max_lifetime))).toBeLessThanOrEqual(
      MAX_DATABASE_POOL_TIMER_SECONDS,
    );
  });

  // A longer timer would not wait longer: the runtime fires it after 1 ms.
  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_DATABASE_POOL_TIMER_SECONDS + 1])(
    "refuses %p seconds",
    (seconds) => {
      expect(() => createDb(url, { idleTimeoutSeconds: seconds })).toThrow(TypeError);
      expect(() => createDb(url, { maxLifetimeSeconds: seconds })).toThrow(TypeError);
      expect(() => jitteredDatabaseMaxLifetime(seconds)).toThrow(TypeError);
    },
  );

  test("leaves prepared statements to their own option", () => {
    expect(driverOptions({ maxLifetimeSeconds: 60 }).prepare).toBe(true);
    expect(driverOptions({ preparedStatements: false, idleTimeoutSeconds: 5 }).prepare).toBe(false);
  });
});

describe("databasePoolOptions", () => {
  test("maps settings onto createDb options and omits unset ones", () => {
    expect(databasePoolOptions({})).toEqual({});
    expect(
      databasePoolOptions({
        databasePreparedStatements: false,
        databasePoolIdleTimeoutSeconds: 15,
        databasePoolMaxLifetimeSeconds: 0,
      }),
    ).toEqual({ preparedStatements: false, idleTimeoutSeconds: 15, maxLifetimeSeconds: 0 });
    const mapped = databasePoolOptions({ databasePoolMaxLifetimeSeconds: 900 });
    expect(mapped).toEqual({ maxLifetimeSeconds: 900 });
    expect("idleTimeoutSeconds" in mapped).toBe(false);
  });

  test("a settings-derived pool gets the configured values", () => {
    const options = driverOptions(
      databasePoolOptions({
        databasePoolIdleTimeoutSeconds: 12,
        databasePoolMaxLifetimeSeconds: 40,
      }),
    );
    expect(options.idle_timeout).toBe(12);
    expect(Math.max(...lifetimes(options.max_lifetime))).toBeLessThanOrEqual(40);
  });
});
