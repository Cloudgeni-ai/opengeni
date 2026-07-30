import { describe, expect, test } from "bun:test";
import { parseConcurrentIndexMigration } from "../src/migrate";

const header = "-- deployment-mode: rolling\n-- opengeni:concurrent-index lock-timeout=5s\n";

describe("concurrent-index migration parsing", () => {
  test("supports the immutable bare statement only for its governed historical filename", () => {
    const statement =
      'CREATE INDEX CONCURRENTLY "sessions_workspace_created_id_idx"\n' +
      '  ON "sessions" ("workspace_id", "created_at" DESC, "id" DESC);';

    expect(
      parseConcurrentIndexMigration(
        "0072_sessions_workspace_created_id_idx.sql",
        header + statement,
      ),
    ).toEqual({
      indexName: "sessions_workspace_created_id_idx",
      lockTimeout: "5s",
      skipWhenValid: true,
      statement,
    });
    expect(() => parseConcurrentIndexMigration("0105_new_index.sql", header + statement)).toThrow(
      "bare statements are supported only for governed historical migrations",
    );
  });

  test("requires future migrations to be idempotent in SQL", () => {
    const statement =
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "new_index" ON "records" ("id");';
    expect(parseConcurrentIndexMigration("0105_new_index.sql", header + statement)).toEqual({
      indexName: "new_index",
      lockTimeout: "5s",
      skipWhenValid: false,
      statement,
    });
  });

  test("rejects multiple statements and unsupported directives", () => {
    expect(() =>
      parseConcurrentIndexMigration(
        "0105_new_index.sql",
        `${header}CREATE INDEX CONCURRENTLY IF NOT EXISTS "one" ON "records" ("id");\nSELECT 1;`,
      ),
    ).toThrow("requires exactly one");
    expect(() =>
      parseConcurrentIndexMigration(
        "0105_new_index.sql",
        "-- deployment-mode: rolling\n-- opengeni:no-transaction\nSELECT 1;",
      ),
    ).toThrow("Unsupported OpenGeni migration directive");
  });
});
