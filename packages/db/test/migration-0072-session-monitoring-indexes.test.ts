import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("migrations 0072/0073 (session monitoring keysets)", () => {
  for (const [file, index, timestamp] of [
    [
      "0072_sessions_workspace_created_id_idx.sql",
      "sessions_workspace_created_id_idx",
      "created_at",
    ],
    [
      "0073_sessions_workspace_updated_id_idx.sql",
      "sessions_workspace_updated_id_idx",
      "updated_at",
    ],
  ] as const) {
    test(`${file} is a rolling concurrent composite index`, async () => {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      expect(sql).toContain("-- opengeni:concurrent-index lock-timeout=5s");
      expect(sql).toContain(`CREATE INDEX CONCURRENTLY "${index}"`);
      expect(sql).toContain(`ON "sessions" ("workspace_id", "${timestamp}" DESC, "id" DESC);`);
    });
  }
});
