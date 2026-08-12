import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0214_browser_download_saves.sql", import.meta.url);

describe("migration 0214 browser download saves", () => {
  test("extends the exact operation journal under maintenance governance", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain("SET LOCAL statement_timeout = '30s'");
    expect(source).toContain("'browser_download'");
    expect(source).toContain("'save'");

    const blank = await acquireBlankTestDatabase("migration-0214");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select con.conname as name, pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema()
          and rel.relname = 'interaction_resource_operations'
          and con.conname in (
            'interaction_resource_operations_resource_kind_check',
            'interaction_resource_operations_kind_check'
          )
        order by con.conname`;
      expect(constraints).toHaveLength(2);
      expect(
        constraints.find((entry) => entry.name.endsWith("_resource_kind_check"))?.definition,
      ).toContain("browser_download");
      expect(constraints.find((entry) => entry.name.endsWith("_kind_check"))?.definition).toContain(
        "save",
      );
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
