import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationName = "0065_hierarchical_role_aware_memory.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0065-memory-provenance");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0065-memory-provenance] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0065 memory creator provenance (real PostgreSQL)", () => {
  test("retries cleanly and replaces the global creator FK with one workspace fence", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      await admin.unsafe(
        `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
      );
      for (const file of files.filter((candidate) => candidate.localeCompare(migrationName) < 0)) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [legacyBefore] = await admin<{ count: number }[]>`
        select count(*)::int as count
        from pg_constraint as constraint_row
        join pg_attribute as local_column
          on local_column.attrelid = constraint_row.conrelid
         and local_column.attnum = constraint_row.conkey[1]
        where constraint_row.conrelid = 'knowledge_memories'::regclass
          and constraint_row.contype = 'f'
          and cardinality(constraint_row.conkey) = 1
          and local_column.attname = 'created_by_session_id'`;
      expect(legacyBefore?.count).toBeGreaterThan(0);

      await applyFile(admin, migrationName);
      await applyFile(admin, migrationName);

      const [constraints] = await admin<
        Array<{
          definition: string | null;
          composite_count: number;
          legacy_count: number;
        }>
      >`
        select
          (
            select pg_get_constraintdef(oid)
            from pg_constraint
            where conrelid = 'knowledge_memories'::regclass
              and conname = 'knowledge_memories_created_by_workspace_session_fk'
          ) as definition,
          (
            select count(*)::int
            from pg_constraint
            where conrelid = 'knowledge_memories'::regclass
              and conname = 'knowledge_memories_created_by_workspace_session_fk'
          ) as composite_count,
          (
            select count(*)::int
            from pg_constraint as constraint_row
            join pg_attribute as local_column
              on local_column.attrelid = constraint_row.conrelid
             and local_column.attnum = constraint_row.conkey[1]
            where constraint_row.conrelid = 'knowledge_memories'::regclass
              and constraint_row.contype = 'f'
              and cardinality(constraint_row.conkey) = 1
              and local_column.attname = 'created_by_session_id'
          ) as legacy_count`;
      expect(constraints).toEqual({
        definition:
          "FOREIGN KEY (workspace_id, created_by_session_id) REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (created_by_session_id)",
        composite_count: 1,
        legacy_count: 0,
      });

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0065-account') returning id`;
      const workspaces = await admin<{ id: string; name: string }[]>`
        insert into workspaces (account_id, name) values
          (${account!.id}, 'migration-0065-a'),
          (${account!.id}, 'migration-0065-b')
        returning id, name`;
      const workspaceA = workspaces.find((row) => row.name === "migration-0065-a")!.id;
      const workspaceB = workspaces.find((row) => row.name === "migration-0065-b")!.id;
      const sessionA = crypto.randomUUID();
      const sessionB = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, status
        ) values
          (${sessionA}, ${account!.id}, ${workspaceA}, 'same workspace', 'scripted-model', 'none', ${sessionA}, 'idle'),
          (${sessionB}, ${account!.id}, ${workspaceB}, 'foreign workspace', 'scripted-model', 'none', ${sessionB}, 'idle')`;

      await expect(
        admin`
          insert into knowledge_memories (
            account_id, workspace_id, status, kind, scope, scope_type, text,
            created_by_session_id
          ) values (
            ${account!.id}, ${workspaceA}, 'proposed', 'semantic', 'workspace',
            'workspace', 'Same-workspace creator is valid.', ${sessionA}
          )`.execute(),
      ).resolves.toBeDefined();
      await expect(
        admin`
          insert into knowledge_memories (
            account_id, workspace_id, status, kind, scope, scope_type, text,
            created_by_session_id
          ) values (
            ${account!.id}, ${workspaceA}, 'proposed', 'semantic', 'workspace',
            'workspace', 'Foreign-workspace creator is invalid.', ${sessionB}
          )`.execute(),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
