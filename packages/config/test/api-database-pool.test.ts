import { describe, expect, test } from "bun:test";
import { getSettings } from "../src";

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
