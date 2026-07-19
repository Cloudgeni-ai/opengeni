import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationUrl = new URL("../drizzle/0067_transcription_grants.sql", import.meta.url);

let available = true;
let blank: BlankTestDatabase | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0067-transcription");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0067-transcription] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("0067 transcription grants migration (real PostgreSQL)", () => {
  test("is rolling, schema-safe, RLS-scoped, constrained, and credential-free", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");

    try {
      await sql.unsafe(`
        create schema tenant_schema;
        create schema opengeni_private;
        create or replace function opengeni_private.workspace_rls_visible(uuid, uuid)
          returns boolean language sql stable as $$ select true $$;
        set search_path to tenant_schema, public;
        create table managed_accounts (id uuid primary key default gen_random_uuid());
        create table workspaces (
          id uuid primary key default gen_random_uuid(),
          account_id uuid not null references managed_accounts(id),
          unique (id, account_id)
        );
        create table sessions (
          id uuid primary key default gen_random_uuid(),
          workspace_id uuid not null references workspaces(id),
          unique (workspace_id, id)
        );
      `);
      await sql.unsafe(migration);

      const columns = await sql<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
        where table_schema = 'tenant_schema' and table_name = 'transcription_grants'
        order by ordinal_position`;
      const names = columns.map(({ column_name }) => column_name);
      expect(names).toContain("provider_session_id");
      expect(names).not.toContain("client_secret");
      expect(names).not.toContain("api_key");
      expect(names).not.toContain("audio");
      expect(names).not.toContain("transcript");
      expect(names).not.toContain("provider_payload");

      const [security] = await sql<
        Array<{
          row_security: boolean;
          force_row_security: boolean;
          policy_count: number;
        }>
      >`
        select c.relrowsecurity as row_security,
               c.relforcerowsecurity as force_row_security,
               (select count(*)::int from pg_policies
                where schemaname = 'tenant_schema'
                  and tablename = 'transcription_grants') as policy_count
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'tenant_schema' and c.relname = 'transcription_grants'`;
      expect(security).toEqual({
        row_security: true,
        force_row_security: true,
        policy_count: 1,
      });

      const indexes = await sql<
        Array<{ indexname: string; indexdef: string; predicate: string | null }>
      >`
        select pi.indexname, pi.indexdef, pg_get_expr(i.indpred, i.indrelid) as predicate
        from pg_indexes pi
        join pg_class c on c.relname = pi.indexname
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = pi.schemaname
        join pg_index i on i.indexrelid = c.oid
        where pi.schemaname = 'tenant_schema' and pi.tablename = 'transcription_grants'
        order by pi.indexname`;
      expect(indexes.map(({ indexname }) => indexname)).toEqual([
        "transcription_grants_one_active_session_uq",
        "transcription_grants_pkey",
        "transcription_grants_request_uq",
        "transcription_grants_subject_created_idx",
        "transcription_grants_workspace_status_idx",
      ]);
      expect(
        indexes
          .find(({ indexname }) => indexname === "transcription_grants_one_active_session_uq")
          ?.predicate?.replaceAll('"', "")
          .replace(/\s+/gu, "")
          .toLowerCase(),
      ).toBe("(status=any(array['reserved'::text,'active'::text]))");

      const constraints = await sql<
        Array<{ conname: string; contype: string; definition: string }>
      >`
        select conname, contype, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'tenant_schema.transcription_grants'::regclass
        order by conname`;
      const constraintNames = constraints.map(({ conname }) => conname);
      expect(constraintNames).toContain("transcription_grants_pkey");
      expect(constraintNames).toContain("transcription_grants_reservation_check");
      expect(constraintNames).toContain("transcription_grants_status_check");
      expect(constraintNames).toContain("transcription_grants_workspace_account_fk");
      expect(constraintNames).toContain("transcription_grants_workspace_session_fk");
      expect(constraints.filter(({ contype }) => contype === "p")).toHaveLength(1);
      expect(constraints.filter(({ contype }) => contype === "c")).toHaveLength(2);
      const foreignKeys = constraints
        .filter(({ contype }) => contype === "f")
        .map(({ definition }) => definition.replaceAll('"', "").replace(/\s+/gu, " "));
      expect(foreignKeys).toHaveLength(5);
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          expect.stringContaining("FOREIGN KEY (account_id) REFERENCES managed_accounts(id)"),
          expect.stringContaining("FOREIGN KEY (workspace_id) REFERENCES workspaces(id)"),
          expect.stringContaining("FOREIGN KEY (session_id) REFERENCES sessions(id)"),
          expect.stringContaining(
            "FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id)",
          ),
          expect.stringContaining(
            "FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id)",
          ),
        ]),
      );

      const [account] = await sql<{ id: string }[]>`
        insert into tenant_schema.managed_accounts default values returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into tenant_schema.workspaces (account_id) values (${account!.id}) returning id`;
      const [session] = await sql<{ id: string }[]>`
        insert into tenant_schema.sessions (workspace_id) values (${workspace!.id}) returning id`;
      const requestId = crypto.randomUUID();
      await sql`
        insert into tenant_schema.transcription_grants (
          account_id, workspace_id, session_id, subject_id, request_id,
          provider, provider_project_id, endpoint, reserved_duration_seconds,
          reserved_cost_micros, active_expires_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${session!.id}, 'user:test', ${requestId},
          'openai', 'project', 'https://api.openai.com/v1/realtime', 60, 10000,
          now() + interval '1 minute'
        )`;
      await expect(
        sql`
          insert into tenant_schema.transcription_grants (
            account_id, workspace_id, session_id, subject_id, request_id,
            provider, provider_project_id, endpoint, status,
            reserved_duration_seconds, reserved_cost_micros, active_expires_at
          ) values (
            ${account!.id}, ${workspace!.id}, ${session!.id}, 'user:other', ${crypto.randomUUID()},
            'openai', 'project', 'https://api.openai.com/v1/realtime', 'invalid',
            60, 10000, now() + interval '1 minute'
          )`,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`
          insert into tenant_schema.transcription_grants (
            account_id, workspace_id, session_id, subject_id, request_id,
            provider, provider_project_id, endpoint, reserved_duration_seconds,
            reserved_cost_micros, active_expires_at
          ) values (
            ${account!.id}, ${workspace!.id}, ${session!.id}, 'user:other', ${crypto.randomUUID()},
            'openai', 'project', 'https://api.openai.com/v1/realtime', 60, 10000,
            now() + interval '1 minute'
          )`,
      ).rejects.toMatchObject({ code: "23505" });

      const [role] = await sql<{ exists: boolean }[]>`
        select exists(select 1 from pg_roles where rolname = 'opengeni_app') as exists`;
      if (role?.exists) {
        const [privileges] = await sql<{ allowed: boolean }[]>`
          select has_table_privilege(
            'opengeni_app', 'tenant_schema.transcription_grants',
            'SELECT,INSERT,UPDATE,DELETE'
          ) as allowed`;
        expect(privileges?.allowed).toBe(true);
      }
      const [timeouts] = await sql<{ statement_timeout: string; lock_timeout: string }[]>`
        select current_setting('statement_timeout') as statement_timeout,
               current_setting('lock_timeout') as lock_timeout`;
      expect(timeouts).toEqual({ statement_timeout: "0", lock_timeout: "0" });
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, 180_000);
});
