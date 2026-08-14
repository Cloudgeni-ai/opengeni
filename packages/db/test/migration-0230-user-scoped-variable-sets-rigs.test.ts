import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0230_user_scoped_variable_sets_rigs.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type SessionAuthorityCatalog = {
  policies: Array<{
    tableName: string;
    usingExpression: string | null;
    checkExpression: string | null;
  }>;
  routines: Array<{
    name: string;
    securityDefiner: boolean;
    acl: string | null;
    definition: string;
  }>;
};

async function sessionAuthorityCatalog(sql: postgres.Sql): Promise<SessionAuthorityCatalog> {
  const policies = await sql<SessionAuthorityCatalog["policies"]>`
    select tablename as "tableName", qual as "usingExpression",
      with_check as "checkExpression"
    from pg_policies
    where schemaname = current_schema()
      and policyname = 'organization_tenancy_lifecycle'
      and tablename in (
        'organization_memberships', 'organization_user_resource_grants'
      )
    order by tablename
  `;
  const routines = await sql<SessionAuthorityCatalog["routines"]>`
    select procedure.proname as name,
      procedure.prosecdef as "securityDefiner",
      procedure.proacl::text as acl,
      pg_get_functiondef(procedure.oid) as definition
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = current_schema()
      and procedure.proname in (
        'transition_session_visibility', 'fork_session_content'
      )
    order by procedure.proname
  `;
  return { policies: Array.from(policies), routines: Array.from(routines) };
}

describe("migration 0230 Variable Set and Rig authority foundation", () => {
  test("is an inert additive foundation that preserves migration 0225 authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const executableSource = source.replace(/^--.*$/gmu, "");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ALTER TABLE "workspace_variable_sets"');
    expect(source).toContain('ALTER TABLE "rigs"');
    expect(source).toContain("\"authority_scope\" text NOT NULL DEFAULT 'workspace'");
    expect(source).toContain("workspace_variable_sets_authority_shape_check");
    expect(source).toContain("rigs_authority_shape_check");
    expect(source).toContain("organization_user_resource_authorities");
    expect(source).toContain('ON DELETE SET NULL ("origin_workspace_id")');
    expect(executableSource).not.toMatch(/organization_tenancy_lifecycle/u);
    expect(executableSource).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/iu);
    expect(executableSource).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY/iu);
    expect(executableSource).not.toMatch(/\bGRANT\b|\bREVOKE\b/iu);
    expect(executableSource).not.toMatch(/session_turn_attempts|scheduled_task_runs/u);
    expect(executableSource).not.toMatch(/user_resource_runtime_capabilities/u);
    expect(executableSource).not.toMatch(
      /bind_user_resource_authority|resolve_user_resource_authority/u,
    );
    expect(executableSource).not.toMatch(/value_encrypted|plaintext|secret_value/u);

    const blank = await acquireBlankTestDatabase(
      "migration-0230-user-resource-authority-foundation",
    );
    if (!blank && requireRealDatabase) {
      throw new Error(
        "[migration-0230-user-resource-authority-foundation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    if (!blank) return;

    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      // Use the real migration runner for every special directive, but mark
      // 0230 and later migrations as already applied so we can capture an exact
      // catalog checkpoint immediately after the predecessors (including 0225).
      const laterMigrations = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql") && file >= migrationName)
        .sort();
      await sql.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of laterMigrations) {
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }
      await migrate(blank.databaseUrl);
      const before0230 = await sessionAuthorityCatalog(sql);

      await sql.unsafe(source);
      const after0230 = await sessionAuthorityCatalog(sql);
      expect(after0230).toEqual(before0230);

      expect(after0230.policies).toHaveLength(2);
      for (const policy of after0230.policies) {
        expect(policy.usingExpression).toContain("managed_human_provisioning");
        expect(policy.usingExpression).toContain("session_visibility_activation");
        expect(policy.checkExpression).toBe(policy.usingExpression);
      }
      expect(
        after0230.routines.map(({ name, securityDefiner }) => ({
          name,
          securityDefiner,
        })),
      ).toEqual([
        { name: "fork_session_content", securityDefiner: true },
        { name: "transition_session_visibility", securityDefiner: true },
      ]);
      for (const routine of after0230.routines) {
        expect(routine.definition).toContain("opengeni.organization_tenancy_lifecycle");
        expect(routine.definition).toContain("session_visibility_activation");
      }

      const columns = await sql<
        Array<{
          tableName: string;
          columnName: string;
          nullable: boolean;
          defaultValue: string | null;
        }>
      >`
        select table_name as "tableName", column_name as "columnName",
          is_nullable = 'YES' as nullable, column_default as "defaultValue"
        from information_schema.columns
        where table_schema = current_schema()
          and table_name in ('workspace_variable_sets', 'rigs')
          and column_name in (
            'authority_scope', 'authority_id',
            'owner_organization_membership_id', 'origin_workspace_id'
          )
        order by table_name, column_name
      `;
      expect(columns).toHaveLength(8);
      for (const tableName of ["rigs", "workspace_variable_sets"]) {
        expect(
          columns.find(
            (column) => column.tableName === tableName && column.columnName === "authority_scope",
          ),
        ).toMatchObject({ nullable: false, defaultValue: "'workspace'::text" });
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0230-account') returning id
      `;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0230-workspace') returning id
      `;
      const [variableSet] = await sql<
        Array<{
          authorityScope: string;
          authorityId: string | null;
          ownerMembershipId: string | null;
          originWorkspaceId: string | null;
        }>
      >`
        insert into workspace_variable_sets (account_id, workspace_id, name)
        values (${account!.id}, ${workspace!.id}, 'default-workspace-variable-set')
        returning authority_scope as "authorityScope", authority_id as "authorityId",
          owner_organization_membership_id as "ownerMembershipId",
          origin_workspace_id as "originWorkspaceId"
      `;
      const [rig] = await sql<
        Array<{
          authorityScope: string;
          authorityId: string | null;
          ownerMembershipId: string | null;
          originWorkspaceId: string | null;
        }>
      >`
        insert into rigs (account_id, workspace_id, name)
        values (${account!.id}, ${workspace!.id}, 'default-workspace-rig')
        returning authority_scope as "authorityScope", authority_id as "authorityId",
          owner_organization_membership_id as "ownerMembershipId",
          origin_workspace_id as "originWorkspaceId"
      `;
      const expectedWorkspaceAuthority = {
        authorityScope: "workspace",
        authorityId: null,
        ownerMembershipId: null,
        originWorkspaceId: null,
      };
      expect(variableSet).toEqual(expectedWorkspaceAuthority);
      expect(rig).toEqual(expectedWorkspaceAuthority);

      const [inert] = await sql<
        Array<{
          bindRoutine: boolean;
          resolveRoutine: boolean;
          privateCapabilities: boolean;
          attemptSnapshots: number;
          scheduledSnapshots: number;
        }>
      >`
        select
          to_regprocedure(
            'bind_user_resource_authority(uuid,uuid,text,text,uuid)'
          ) is not null as "bindRoutine",
          to_regprocedure(
            'resolve_user_resource_authority(uuid,uuid,text,text,uuid,text,uuid,integer,boolean)'
          ) is not null as "resolveRoutine",
          to_regclass('opengeni_private.user_resource_runtime_capabilities') is not null
            as "privateCapabilities",
          (
            select count(*)::int from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_turn_attempts'
              and column_name like 'variable_set_authority_%'
          ) as "attemptSnapshots",
          (
            select count(*)::int from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'scheduled_task_runs'
              and column_name like 'variable_set_authority_%'
          ) as "scheduledSnapshots"
      `;
      expect(inert).toEqual({
        bindRoutine: false,
        resolveRoutine: false,
        privateCapabilities: false,
        attemptSnapshots: 0,
        scheduledSnapshots: 0,
      });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 300_000);
});
