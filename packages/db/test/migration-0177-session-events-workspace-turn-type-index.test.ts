import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migrationName = "0177_session_events_workspace_turn_type_index.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("0177 session-event turn/type recovery index", () => {
  test("uses the governed rolling concurrent-index plan", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source).toBe(
      "-- deployment-mode: rolling\n" +
        "-- opengeni:concurrent-index lock-timeout=5s\n" +
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_events_workspace_turn_type_idx"\n' +
        '  ON "session_events" ("workspace_id", "turn_id", "type")\n' +
        '  WHERE "turn_id" IS NOT NULL;\n',
    );
    expect(parseConcurrentIndexMigration(migrationName, source)).toEqual({
      indexName: "session_events_workspace_turn_type_idx",
      lockTimeout: "5s",
      skipWhenValid: false,
      statement:
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_events_workspace_turn_type_idx"\n' +
        '  ON "session_events" ("workspace_id", "turn_id", "type")\n' +
        '  WHERE "turn_id" IS NOT NULL;',
    });
  });
});
