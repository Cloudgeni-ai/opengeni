import { describe, expect, test } from "bun:test";
import { getArtifactMaterializerSettings, getArtifactOutboxSettings, getSettings } from "../src";

describe("API application database pool capacity", () => {
  test("keeps the historical default when no override is supplied", () => {
    expect(getSettings({}).apiDatabasePoolMax).toBe(32);
    expect(getSettings({ OPENGENI_API_DATABASE_POOL_MAX: " " }).apiDatabasePoolMax).toBe(32);
  });

  test("accepts a positive integer override without changing database isolation", () => {
    const source = {
      OPENGENI_DATABASE_URL: "postgres://app:fixture@localhost:5432/opengeni",
      OPENGENI_DB_SCHEMA: "embedded",
      OPENGENI_RLS_STRATEGY: "force",
    };
    const base = getSettings(source);
    const configured = getSettings({ ...source, OPENGENI_API_DATABASE_POOL_MAX: "12" });
    expect(configured.apiDatabasePoolMax).toBe(12);
    expect({ ...configured, apiDatabasePoolMax: base.apiDatabasePoolMax }).toEqual(base);
  });

  test.each(["0", "-1", "1.5", "NaN", "Infinity", "abc", "9007199254740992"])(
    "rejects invalid pool capacity %s",
    (value) => {
      expect(() => getSettings({ OPENGENI_API_DATABASE_POOL_MAX: value })).toThrow();
    },
  );
});

describe("database prepared statements", () => {
  test("notification connections are opt-in without changing the main database URL", () => {
    expect(getSettings({}).databaseNotificationUrl).toBeUndefined();
    expect(
      getSettings({ OPENGENI_DATABASE_NOTIFICATION_URL: " " }).databaseNotificationUrl,
    ).toBeUndefined();
    const source = { OPENGENI_DATABASE_URL: "postgres://app:fixture@localhost:6432/opengeni" };
    const direct = "postgres://app:fixture@localhost:5432/opengeni";
    const settings = getSettings({ ...source, OPENGENI_DATABASE_NOTIFICATION_URL: direct });
    expect(settings.databaseUrl).toBe(source.OPENGENI_DATABASE_URL);
    expect(settings.databaseNotificationUrl).toBe(direct);
  });

  test("stays unset so the pool decides from the connection URL", () => {
    expect(getSettings({}).databasePreparedStatements).toBeUndefined();
    expect(
      getSettings({ OPENGENI_DATABASE_PREPARED_STATEMENTS: " " }).databasePreparedStatements,
    ).toBeUndefined();
  });

  test.each([
    ["false", false],
    ["0", false],
    ["true", true],
    ["on", true],
  ])("accepts an explicit %s", (value, expected) => {
    expect(
      getSettings({ OPENGENI_DATABASE_PREPARED_STATEMENTS: value }).databasePreparedStatements,
    ).toBe(expected);
  });

  test("rejects a value that is not a boolean", () => {
    expect(() => getSettings({ OPENGENI_DATABASE_PREPARED_STATEMENTS: "sometimes" })).toThrow();
  });
});

describe("database pool recycling", () => {
  const names = {
    idle: "OPENGENI_DATABASE_POOL_IDLE_TIMEOUT_SECONDS",
    lifetime: "OPENGENI_DATABASE_POOL_MAX_LIFETIME_SECONDS",
  } as const;

  test("stays unset so the pool keeps its own defaults", () => {
    for (const source of [{}, { [names.idle]: " ", [names.lifetime]: "" }]) {
      const settings = getSettings(source);
      expect(settings.databasePoolIdleTimeoutSeconds).toBeUndefined();
      expect(settings.databasePoolMaxLifetimeSeconds).toBeUndefined();
    }
  });

  test("accepts whole seconds, including 0 to turn a timer off", () => {
    const settings = getSettings({ [names.idle]: "45", [names.lifetime]: "0" });
    expect(settings.databasePoolIdleTimeoutSeconds).toBe(45);
    expect(settings.databasePoolMaxLifetimeSeconds).toBe(0);
    const swapped = getSettings({ [names.idle]: "0", [names.lifetime]: "900" });
    expect(swapped.databasePoolIdleTimeoutSeconds).toBe(0);
    expect(swapped.databasePoolMaxLifetimeSeconds).toBe(900);
    // The longest timer the runtime arms; one second more would fire after 1 ms.
    const longest = getSettings({ [names.idle]: "2147483", [names.lifetime]: "2147483" });
    expect(longest.databasePoolIdleTimeoutSeconds).toBe(2_147_483);
    expect(longest.databasePoolMaxLifetimeSeconds).toBe(2_147_483);
  });

  test.each(["-1", "1.5", "NaN", "Infinity", "abc", "9007199254740992", "2147484"])(
    "rejects %s",
    (value) => {
      expect(() => getSettings({ [names.idle]: value })).toThrow();
      expect(() => getSettings({ [names.lifetime]: value })).toThrow();
    },
  );

  test("reach the editable-artifact services with the same names", () => {
    const source = { [names.idle]: "20", [names.lifetime]: "300" };
    for (const settings of [
      getArtifactOutboxSettings(source),
      getArtifactMaterializerSettings(source),
    ]) {
      expect(settings.databasePoolIdleTimeoutSeconds).toBe(20);
      expect(settings.databasePoolMaxLifetimeSeconds).toBe(300);
    }
    expect(getArtifactOutboxSettings({}).databasePoolIdleTimeoutSeconds).toBeUndefined();
    expect(getArtifactMaterializerSettings({}).databasePoolMaxLifetimeSeconds).toBeUndefined();
  });
});
