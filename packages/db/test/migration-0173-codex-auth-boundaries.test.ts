import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = new URL("../drizzle/0173_codex_auth_boundaries.sql", import.meta.url);
const migrationName = "0173_codex_auth_boundaries.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0173-codex-auth-boundaries");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

describe("0173 Codex authentication boundaries migration", () => {
  test("is a maintenance cutover with schema-generic, least-privilege SQL", async () => {
    const source = await readFile(migrationPath, "utf8");

    expect(source.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(source).toContain('CREATE TABLE "codex_apps_settings"');
    expect(source).toContain("ON DELETE CASCADE");
    expect(source).toContain("current_schema()");
    expect(source).toContain('CONSTRAINT "codex_apps_settings_credential_scope_fk"');
    expect(source).toContain(
      'REFERENCES "codex_subscription_credentials"("workspace_id", "account_id", "id")',
    );
    expect(source).toContain("ON TABLE %I.codex_apps_settings TO opengeni_app");
    expect(source).not.toContain("ON ALL TABLES");
    expect(source).not.toContain('public."codex_subscription_credentials"');
    expect(source).toContain('DROP COLUMN "producer_codex_credential_id"');
    expect(source).toContain('DROP COLUMN "frozen_codex_credential_id"');
    expect(source).toContain('DROP COLUMN "connector_namespaces"');
    expect(source).toContain('DROP COLUMN "connectors_checked_at"');
    expect(source.match(/opengeni_app sessions to be stopped/g)).toHaveLength(2);
    expect(source).toContain(
      'LOCK TABLE "codex_subscription_credentials" IN ACCESS EXCLUSIVE MODE',
    );
    expect(source).toContain('LOCK TABLE "session_history_items" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "agent_run_states" IN ACCESS EXCLUSIVE MODE');
  });

  test("rejects a live app session with SQLSTATE 55000 and rolls the cutover back", async () => {
    const blank = await acquireBlankTestDatabase("migration-0173-live-writer-guard");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migrationName) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const source = await readFile(migrationPath, "utf8");
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const liveApp = postgres(appUrl.toString(), { max: 1 });
      let guardError: unknown;
      try {
        await liveApp`select 1`;
        await sql.unsafe(source);
      } catch (error) {
        guardError = error;
      } finally {
        await liveApp.end();
      }
      expect((guardError as { code?: string } | undefined)?.code).toBe("55000");
      const [rolledBack] = await sql<{ tablePresent: boolean; legacyColumnPresent: boolean }[]>`
        select
          to_regclass('codex_apps_settings') is not null as "tablePresent",
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_history_items'
              and column_name = 'producer_codex_credential_id'
          ) as "legacyColumnPresent"`;
      expect(rolledBack).toEqual({ tablePresent: false, legacyColumnPresent: true });

      await sql.unsafe(source);
      const [applied] = await sql<{ tablePresent: boolean; legacyColumnPresent: boolean }[]>`
        select
          to_regclass('codex_apps_settings') is not null as "tablePresent",
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_history_items'
              and column_name = 'producer_codex_credential_id'
          ) as "legacyColumnPresent"`;
      expect(applied).toEqual({ tablePresent: true, legacyColumnPresent: false });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);

  test("declares the exact FORCE-RLS full-DML posture", () => {
    expect(FORCE_RLS_TABLES).toContain("codex_apps_settings");
    expect(RUNTIME_FULL_DML_TABLES).toContain("codex_apps_settings");
  });

  test("installs the protected singleton with exact app-role privileges", async () => {
    const [table] = await shared.admin<
      {
        rlsEnabled: boolean;
        rlsForced: boolean;
        policyCount: number;
        appSelect: boolean;
        appInsert: boolean;
        appUpdate: boolean;
        appDelete: boolean;
        appTruncate: boolean;
      }[]
    >`
      select
        c.relrowsecurity as "rlsEnabled",
        c.relforcerowsecurity as "rlsForced",
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as "policyCount",
        has_table_privilege('opengeni_app', c.oid, 'select') as "appSelect",
        has_table_privilege('opengeni_app', c.oid, 'insert') as "appInsert",
        has_table_privilege('opengeni_app', c.oid, 'update') as "appUpdate",
        has_table_privilege('opengeni_app', c.oid, 'delete') as "appDelete",
        has_table_privilege('opengeni_app', c.oid, 'truncate') as "appTruncate"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = 'codex_apps_settings'`;

    expect(table).toEqual({
      rlsEnabled: true,
      rlsForced: true,
      policyCount: 1,
      appSelect: true,
      appInsert: true,
      appUpdate: true,
      appDelete: true,
      appTruncate: false,
    });

    const [constraints] = await shared.admin<
      { workspaceUnique: boolean; credentialDeleteAction: string | null }[]
    >`
      select
        exists (
          select 1 from pg_indexes
          where schemaname = current_schema()
            and indexname = 'codex_apps_settings_workspace_idx'
            and indexdef like '%UNIQUE%'
        ) as "workspaceUnique",
        (
          select confdeltype::text from pg_constraint
          where conrelid = 'codex_apps_settings'::regclass
            and contype = 'f'
            and conname = 'codex_apps_settings_credential_scope_fk'
        ) as "credentialDeleteAction"`;

    expect(constraints).toEqual({ workspaceUnique: true, credentialDeleteAction: "c" });
  });

  test("removes account-coupled history and connector-ranking columns", async () => {
    const rows = await shared.admin<{ tableName: string; columnName: string }[]>`
      select table_name as "tableName", column_name as "columnName"
      from information_schema.columns
      where table_schema = current_schema()
        and (table_name, column_name) in (
          ('session_history_items', 'producer_codex_credential_id'),
          ('agent_run_states', 'frozen_codex_credential_id'),
          ('codex_subscription_credentials', 'connector_namespaces'),
          ('codex_subscription_credentials', 'connectors_checked_at')
        )`;
    expect([...rows]).toEqual([]);
  });
});
