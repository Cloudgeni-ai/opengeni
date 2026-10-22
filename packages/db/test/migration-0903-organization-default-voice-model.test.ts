import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0903_organization_default_voice_model.sql",
  import.meta.url,
);

describe("migration 0903 organization default voice model", () => {
  test("adds one nullable column without rewriting rows or touching RLS", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS realtime_default_model text;");
    expect(migration).not.toMatch(/\bDEFAULT\b/u);
    expect(migration).not.toMatch(/NOT NULL/u);
    expect(migration).not.toMatch(/ROW LEVEL SECURITY|GRANT|REVOKE/u);
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/imu);
  });
});
