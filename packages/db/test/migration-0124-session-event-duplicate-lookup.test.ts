import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0124_session_event_duplicate_lookup.sql",
);

describe("migration 0124 (session event duplicate lookup)", () => {
  test("builds the self-referential foreign-key lookup index online", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(
      parseConcurrentIndexMigration("0124_session_event_duplicate_lookup.sql", sql),
    ).toMatchObject({
      indexName: "session_events_duplicate_of_event_idx",
      lockTimeout: "5s",
      skipWhenValid: false,
    });
    expect(sql).toContain('ON "session_events" ("duplicate_of_event_id");');
  });
});
