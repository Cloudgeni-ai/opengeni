import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseConcurrentIndexMigration } from "../src/migrate";

describe("billing recent-usage indexes", () => {
  for (const [file, indexName, columns] of [
    [
      "0471_usage_events_account_recent_index.sql",
      "usage_events_account_recent_idx",
      '"account_id", "occurred_at" DESC, "recorded_at" DESC',
    ],
    [
      "0472_usage_events_workspace_recent_index.sql",
      "usage_events_workspace_recent_idx",
      '"account_id", "workspace_id", "occurred_at" DESC, "recorded_at" DESC',
    ],
  ] as const) {
    test(`${file} matches the unfiltered event-type ordering without blocking writes`, async () => {
      const source = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
      expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
      expect(parseConcurrentIndexMigration(file, source)).toEqual({
        indexName,
        lockTimeout: "5s",
        skipWhenValid: false,
        statement:
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}"\n` +
          `  ON "usage_events" (${columns});`,
      });
    });
  }
});
