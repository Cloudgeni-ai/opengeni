import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0220_session_channels.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0220 session channels", () => {
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
    expect(migration).toContain('ADD COLUMN "channel_id" uuid');
    expect(migration).not.toContain('ADD COLUMN "channel_id" uuid REFERENCES');
    // Rolling safety: no sessions-table scan runs in the ADD COLUMN transaction.
    // The index is concurrent, then the FK is installed NOT VALID and validated
    // in its own later transaction.
    expect(migration).toContain("SET LOCAL lock_timeout");
    expect(migration).not.toContain('CREATE INDEX "sessions_');
    const followUp = await readFile(
      migrationPath.replace("0220_session_channels.sql", "0221_sessions_channel_index.sql"),
      "utf8",
    );
    expect(followUp.split(/\r?\n/, 2)).toEqual([
      "-- deployment-mode: rolling",
      "-- opengeni:concurrent-index lock-timeout=5s",
    ]);
    expect(followUp).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_workspace_channel_idx"',
    );
    const addForeignKey = await readFile(
      migrationPath.replace("0220_session_channels.sql", "0222_sessions_channel_fk.sql"),
      "utf8",
    );
    expect(addForeignKey.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(addForeignKey).toContain('ADD CONSTRAINT "sessions_channel_id_fk"');
    expect(addForeignKey).toContain('REFERENCES "channels"("id")');
    expect(addForeignKey).toContain("ON DELETE SET NULL");
    expect(addForeignKey).toContain("NOT VALID");
    expect(addForeignKey).toContain("local_column.attname = 'channel_id'");
    expect(addForeignKey).toContain("referenced_column.attname = 'id'");
    expect(addForeignKey).toContain("constraint_row.confdeltype = 'n'");
    expect(addForeignKey).not.toContain("VALIDATE CONSTRAINT");
    const validateForeignKey = await readFile(
      migrationPath.replace("0220_session_channels.sql", "0223_sessions_channel_fk_validate.sql"),
      "utf8",
    );
    expect(validateForeignKey.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(validateForeignKey).toContain(`'ALTER TABLE "sessions" VALIDATE CONSTRAINT %I'`);
    expect(validateForeignKey).toContain("local_column.attname = 'channel_id'");
    expect(validateForeignKey).toContain("referenced_column.attname = 'id'");
    expect(validateForeignKey).toContain("constraint_row.confdeltype = 'n'");
    expect(validateForeignKey).toContain("SET LOCAL statement_timeout = '10min'");

    const blank = await acquireBlankTestDatabase("migration-0220");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0220 PostgreSQL harness is unavailable",
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
      const [fk] = await sql<Array<{ definition: string; validated: boolean }>>`
        select pg_get_constraintdef(oid) as definition, convalidated as validated
        from pg_constraint
        where conrelid = 'sessions'::regclass
          and pg_get_constraintdef(oid) like '%channels%'`;
      expect(fk?.definition).toContain("ON DELETE SET NULL");
      expect(fk?.validated).toBe(true);
      const indexes = await sql<Array<{ indexname: string }>>`
        select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'channels'`;
      const names = indexes.map((row) => row.indexname);
      expect(names).toContain("channels_workspace_name_idx");
      expect(names).toContain("channels_workspace_id_uq");
      const [sessionsIndex] = await sql<Array<{ indexname: string }>>`
        select indexname from pg_indexes
        where schemaname = 'public'
          and tablename = 'sessions'
          and indexname = 'sessions_workspace_channel_idx'`;
      expect(sessionsIndex?.indexname).toBe("sessions_workspace_channel_idx");
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);

  test("preserves an already-applied original 0220 foreign key without duplicating it", async () => {
    const blank = await acquireBlankTestDatabase("migration-0220-original-fk");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0220 PostgreSQL harness is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      // Build the current schema while withholding the two repair migrations,
      // then recreate the exact auto-named validated FK produced by the
      // original inline REFERENCES clause in 0220.
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`
        insert into schema_migrations (name)
        values
          ('0222_sessions_channel_fk.sql'),
          ('0223_sessions_channel_fk_validate.sql')`;
      await migrate(blank.databaseUrl);
      await sql.unsafe(`
        alter table "sessions"
          add constraint "sessions_channel_id_fkey"
          foreign key ("channel_id")
          references "channels"("id")
          on delete set null
      `);
      await sql`
        delete from schema_migrations
        where name in (
          '0222_sessions_channel_fk.sql',
          '0223_sessions_channel_fk_validate.sql'
        )`;

      await migrate(blank.databaseUrl);

      const constraints = await sql<
        Array<{ name: string; definition: string; validated: boolean }>
      >`
        select
          conname as name,
          pg_get_constraintdef(oid) as definition,
          convalidated as validated
        from pg_constraint
        where conrelid = 'sessions'::regclass
          and pg_get_constraintdef(oid) like '%channels%'
        order by conname`;
      expect(constraints).toHaveLength(1);
      expect(constraints[0]).toEqual({
        name: "sessions_channel_id_fkey",
        definition: expect.stringContaining("ON DELETE SET NULL"),
        validated: true,
      });
      const receipts = await sql<Array<{ name: string }>>`
        select name
        from schema_migrations
        where name in (
          '0222_sessions_channel_fk.sql',
          '0223_sessions_channel_fk_validate.sql'
        )
        order by name`;
      expect(receipts.map((row) => row.name)).toEqual([
        "0222_sessions_channel_fk.sql",
        "0223_sessions_channel_fk_validate.sql",
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
