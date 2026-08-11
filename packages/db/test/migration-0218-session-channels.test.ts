import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0218_session_channels.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0218 session channels", () => {
  test("creates the FORCE-RLS channels table and the detachable session filing column", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain('CREATE TABLE "channels"');
    expect(migration).toContain('ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "channels" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain(
      'opengeni_private.workspace_rls_visible("account_id", "workspace_id")',
    );
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.channels");
    expect(migration).toContain(
      'ADD COLUMN "channel_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL',
    );
    // Rolling safety: the sessions DDL is guarded by a bounded lock wait.
    expect(migration).toContain("SET LOCAL lock_timeout");

    const blank = await acquireBlankTestDatabase("migration-0218");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0218 PostgreSQL harness is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await migrate(blank.databaseUrl);
      const [rls] = await sql<Array<{ enabled: boolean; forced: boolean }>>`
        select relrowsecurity as enabled, relforcerowsecurity as forced
        from pg_class
        where oid = 'channels'::regclass`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const [column] = await sql<Array<{ dataType: string; nullable: string }>>`
        select data_type as "dataType", is_nullable as nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'sessions'
          and column_name = 'channel_id'`;
      expect(column).toEqual({ dataType: "uuid", nullable: "YES" });
      const [fk] = await sql<Array<{ definition: string }>>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'sessions'::regclass
          and pg_get_constraintdef(oid) like '%channels%'`;
      expect(fk?.definition).toContain("ON DELETE SET NULL");
      const indexes = await sql<Array<{ indexname: string }>>`
        select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'channels'`;
      const names = indexes.map((row) => row.indexname);
      expect(names).toContain("channels_workspace_name_idx");
      expect(names).toContain("channels_workspace_id_uq");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
