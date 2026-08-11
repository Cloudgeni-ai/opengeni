import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0215_browser_controller_host.sql", import.meta.url);

describe("migration 0215 browser controller host", () => {
  test("separates remote browser placement from browserd lease authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('ADD COLUMN "controller_host_sandbox_group_id" uuid');
    expect(source).toContain("browser.controller_host_sandbox_group_id = lease.sandbox_group_id");

    const blank = await acquireBlankTestDatabase("migration-0215-browser-controller-host");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [column] = await sql<Array<{ nullable: string }>>`
        select is_nullable as nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'browser_sessions'
          and column_name = 'controller_host_sandbox_group_id'`;
      expect(column).toEqual({ nullable: "YES" });

      const [constraint] = await sql<Array<{ definition: string }>>`
        select pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema()
          and rel.relname = 'browser_sessions'
          and con.conname = 'browser_sessions_controller_host_check'`;
      expect(constraint?.definition).toContain("external_provider");
      expect(constraint?.definition).toContain("controller_host_sandbox_group_id IS NOT NULL");

      const [reaper] = await sql<Array<{ definition: string }>>`
        select pg_get_functiondef('opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure) as definition`;
      expect(reaper?.definition).toContain(
        "browser.controller_host_sandbox_group_id = lease.sandbox_group_id",
      );
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
