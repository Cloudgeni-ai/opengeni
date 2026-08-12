import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0217_external_browser_auth_operations.sql",
  import.meta.url,
);

describe("migration 0217 external browser auth operations", () => {
  test("admits only the new durable operation kind", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("'external_auth'");

    const blank = await acquireBlankTestDatabase("migration-0217-external-browser-auth-operations");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [constraint] = await sql<Array<{ definition: string }>>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where connamespace = current_schema()::regnamespace
          and conname = 'interaction_resource_operations_kind_check'`;
      expect(constraint?.definition).toContain("external_auth");
      expect(constraint?.definition).toContain("protected_fill");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
