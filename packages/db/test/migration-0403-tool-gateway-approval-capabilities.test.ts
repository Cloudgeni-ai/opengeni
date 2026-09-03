// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type BlankTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, provisionRoles } from "../src";
import {
  evaluateRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  inspectRuntimeDatabasePosture,
  NON_RLS_RUNTIME_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
} from "../src/runtime-posture";

const migrationPath = new URL(
  "../drizzle/0403_tool_gateway_approval_capabilities.sql",
  import.meta.url,
);
const source = await Bun.file(migrationPath).text();
const mcpOauthSource = await Bun.file(
  new URL("../drizzle/0402_mcp_oauth_authorization_server.sql", import.meta.url),
).text();
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(900_000);

let blank: BlankTestDatabase | null = null;
let admin: ReturnType<typeof postgres> | null = null;
let app: ReturnType<typeof postgres> | null = null;

async function applyMaintenanceMigration(
  sql: ReturnType<typeof postgres>,
  migration: string,
  applicationRoles: readonly string[],
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`select set_config(
      'opengeni.migration_application_roles',
      ${JSON.stringify(applicationRoles)},
      true
    )`;
    await transaction.unsafe(migration);
  });
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0401-tool-gateway-approval");
  if (!blank) {
    if (requireRealDatabase) throw new Error("migration 0402 requires real PostgreSQL");
    return;
  }
  if (!blank.appPassword) throw new Error("migration 0402 app password is unavailable");
  admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
  await admin.unsafe(`
    create schema opengeni_private;
    grant usage on schema opengeni_private to opengeni_app;
    create function opengeni_private.current_subject_id() returns text
      language sql stable as $$ select nullif(current_setting('opengeni.subject_id', true), '') $$;
    create function opengeni_private.workspace_rls_visible(row_account_id uuid, row_workspace_id uuid)
      returns boolean language sql stable as $$
        select row_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
          and row_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
      $$;
    create table managed_accounts (id uuid primary key);
    create table workspaces (
      id uuid primary key,
      account_id uuid not null references managed_accounts(id) on delete cascade,
      unique (id, account_id)
    );
  `);
  await applyMaintenanceMigration(admin, source, ["opengeni_app"]);
  await provisionRoles(blank.databaseUrl, {
    appRole: "opengeni_app",
    appPassword: blank.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(blank.databaseUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = blank.appPassword;
  app = postgres(appUrl.toString(), { max: 1, prepare: false });
}, 900_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("migration 0403 tool gateway approval capabilities", () => {
  test("stores only bounded hash-only one-shot approval evidence", () => {
    expect(source).toContain("-- deployment-mode: maintenance");
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain("tool_gateway_approval_runtime_drain_before");
    expect(source).toContain("tool_gateway_approval_runtime_drain_after");
    expect(source).toContain("pg_stat_activity");
    expect(source.match(/0402 tool gateway approval activation/g)).toHaveLength(5);
    expect(source).toContain("never restart a");
    expect(source).toContain("pre-0403 image after commit");
    expect(source).toContain('CREATE TABLE "tool_gateway_approval_capabilities"');
    expect(source).toContain('"token_hash" text PRIMARY KEY');
    expect(source).not.toContain('"approval_token"');
    expect(source).toContain('"operation_id" uuid NOT NULL');
    expect(source).toContain('"arguments_digest" text NOT NULL');
    expect(source).not.toContain('"site_version_id"');
    expect(source).toContain('length("tool_name") BETWEEN 1 AND 512');
    expect(source).toContain("interval '10 minutes'");
    expect(source).toContain(
      'ALTER TABLE "tool_gateway_approval_capabilities" FORCE ROW LEVEL SECURITY',
    );
    expect(source).toContain('"subject_id" = opengeni_private.current_subject_id()');
    expect(source).toContain("tool_gateway_approval_table_acl_reset");
    expect(source).toContain("pg_catalog.aclexplode");
    expect(source).toContain("post-migration role provisioner");
    expect(source).not.toContain("DO $application_grants$");
    expect(source).not.toContain("UNION SELECT 'opengeni_app'");
    expect(FORCE_RLS_TABLES).toContain("tool_gateway_approval_capabilities");
    expect(RUNTIME_FULL_DML_TABLES).toContain("tool_gateway_approval_capabilities");
  });

  test("requires every old/new application login to drain and grants only the provisioned target", async () => {
    const cutover = await acquireBlankTestDatabase("migration-0402-0403-runtime-drain");
    if (!cutover) {
      if (requireRealDatabase) throw new Error("migrations 0402-0403 require real PostgreSQL");
      return;
    }
    const cutoverAdmin = postgres(cutover.databaseUrl, { max: 1, prepare: false });
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const oldRole = `og_401_old_${suffix}`;
    const newRole = `og_401_new_${suffix}`;
    const oldPassword = crypto.randomUUID().replaceAll("-", "");
    const newPassword = crypto.randomUUID().replaceAll("-", "");
    const databaseName = decodeURIComponent(new URL(cutover.databaseUrl).pathname.slice(1));
    let oldRuntime: ReturnType<typeof postgres> | null = null;
    let newRuntime: ReturnType<typeof postgres> | null = null;
    try {
      await cutoverAdmin.unsafe(`
        create schema opengeni_private;
        create function opengeni_private.current_subject_id() returns text
          language sql stable as $$ select nullif(current_setting('opengeni.subject_id', true), '') $$;
        create function opengeni_private.workspace_rls_visible(
          row_account_id uuid,
          row_workspace_id uuid
        ) returns boolean language sql stable as $$
          select row_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
            and row_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
        $$;
        create table managed_accounts (id uuid primary key);
        create table workspaces (
          id uuid primary key,
          account_id uuid not null references managed_accounts(id) on delete cascade,
          unique (id, account_id)
        );
        create role "${oldRole}" login password '${oldPassword}';
        create role "${newRole}" login password '${newPassword}';
        grant connect on database "${databaseName.replaceAll('"', '""')}" to "${oldRole}", "${newRole}";
        alter default privileges in schema public
          grant select, insert, update, delete on tables to "${oldRole}", "${newRole}";
        alter default privileges in schema opengeni_private
          grant execute on functions to "${oldRole}", "${newRole}";
      `);

      const oldUrl = new URL(cutover.databaseUrl);
      oldUrl.username = oldRole;
      oldUrl.password = oldPassword;
      oldRuntime = postgres(oldUrl.toString(), { max: 1, prepare: false });
      await oldRuntime`select 1`;
      await expect(
        applyMaintenanceMigration(cutoverAdmin, mcpOauthSource, [oldRole, newRole]),
      ).rejects.toMatchObject({ code: "55000" });
      const [oauthTableAfterRejectedCutover] = await cutoverAdmin<Array<{ present: boolean }>>`
        select to_regclass('mcp_oauth_clients') is not null as present`;
      expect(oauthTableAfterRejectedCutover).toEqual({ present: false });
      await oldRuntime.end();
      oldRuntime = null;

      const newUrl = new URL(cutover.databaseUrl);
      newUrl.username = newRole;
      newUrl.password = newPassword;
      newRuntime = postgres(newUrl.toString(), { max: 1, prepare: false });
      await newRuntime`select 1`;
      await expect(
        applyMaintenanceMigration(cutoverAdmin, mcpOauthSource, [oldRole, newRole]),
      ).rejects.toMatchObject({ code: "55000" });
      await newRuntime.end();
      newRuntime = null;

      await applyMaintenanceMigration(cutoverAdmin, mcpOauthSource, [oldRole, newRole]);
      const [oauthAcls] = await cutoverAdmin<
        Array<{
          oldTable: boolean;
          newTable: boolean;
          oldFunction: boolean;
          newFunction: boolean;
        }>
      >`select
          has_table_privilege(${oldRole}, 'mcp_oauth_clients', 'SELECT') as "oldTable",
          has_table_privilege(${newRole}, 'mcp_oauth_clients', 'SELECT') as "newTable",
          has_function_privilege(
            ${oldRole},
            'opengeni_private.reap_mcp_oauth_state(integer)',
            'EXECUTE'
          ) as "oldFunction",
          has_function_privilege(
            ${newRole},
            'opengeni_private.reap_mcp_oauth_state(integer)',
            'EXECUTE'
          ) as "newFunction"`;
      expect(oauthAcls).toEqual({
        oldTable: false,
        newTable: false,
        oldFunction: false,
        newFunction: false,
      });

      newRuntime = postgres(newUrl.toString(), { max: 1, prepare: false });
      await newRuntime`select 1`;
      await expect(
        applyMaintenanceMigration(cutoverAdmin, source, [oldRole, newRole]),
      ).rejects.toMatchObject({ code: "55000" });
      const [approvalTableAfterRejectedCutover] = await cutoverAdmin<
        Array<{ present: boolean }>
      >`select to_regclass('tool_gateway_approval_capabilities') is not null as present`;
      expect(approvalTableAfterRejectedCutover).toEqual({ present: false });
      await newRuntime.end();
      newRuntime = null;

      await applyMaintenanceMigration(cutoverAdmin, source, [oldRole, newRole]);
      await provisionRoles(cutover.databaseUrl, {
        appRole: newRole,
        appPassword: newPassword,
        rlsStrategy: "force",
      });
      const [finalAcls] = await cutoverAdmin<
        Array<{
          oldOauth: boolean;
          oldApproval: boolean;
          oldFunction: boolean;
          newOauth: boolean;
          newApproval: boolean;
          newFunction: boolean;
        }>
      >`select
          has_table_privilege(${oldRole}, 'mcp_oauth_clients', 'SELECT') as "oldOauth",
          has_table_privilege(
            ${oldRole},
            'tool_gateway_approval_capabilities',
            'SELECT'
          ) as "oldApproval",
          has_function_privilege(
            ${oldRole},
            'opengeni_private.reap_mcp_oauth_state(integer)',
            'EXECUTE'
          ) as "oldFunction",
          has_table_privilege(${newRole}, 'mcp_oauth_clients', 'SELECT') as "newOauth",
          has_table_privilege(
            ${newRole},
            'tool_gateway_approval_capabilities',
            'SELECT'
          ) as "newApproval",
          has_function_privilege(
            ${newRole},
            'opengeni_private.reap_mcp_oauth_state(integer)',
            'EXECUTE'
          ) as "newFunction"`;
      expect(finalAcls).toEqual({
        oldOauth: false,
        oldApproval: false,
        oldFunction: false,
        newOauth: true,
        newApproval: true,
        newFunction: true,
      });
    } finally {
      await oldRuntime?.end().catch(() => undefined);
      await newRuntime?.end().catch(() => undefined);
      for (const role of [oldRole, newRole]) {
        await cutoverAdmin.unsafe(`drop owned by "${role}"`).catch(() => undefined);
        await cutoverAdmin.unsafe(`drop role if exists "${role}"`).catch(() => undefined);
      }
      await cutoverAdmin.end().catch(() => undefined);
      await cutover.release();
    }
  });

  test("the previous runtime-posture catalog rejects the provisioned target schema", async () => {
    const shared = await acquireSharedTestDatabase("migration-0402-0403-mixed-runtime-posture");
    if (!shared) {
      if (requireRealDatabase) throw new Error("migrations 0402-0403 require real PostgreSQL");
      return;
    }
    const runtime = createDb(shared.appUrl, { max: 1 });
    try {
      const options = { rlsStrategy: "force" as const };
      const posture = await inspectRuntimeDatabasePosture(runtime.db, options);
      expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);

      const targetTables = new Set([
        "mcp_oauth_access_tokens",
        "mcp_oauth_authorization_codes",
        "mcp_oauth_authorization_requests",
        "mcp_oauth_clients",
        "mcp_oauth_refresh_tokens",
        "tool_gateway_approval_capabilities",
      ]);
      const previousTablePrivileges = Object.fromEntries(
        Object.entries(RUNTIME_TABLE_PRIVILEGES).filter(([table]) => !targetTables.has(table)),
      );
      const previousViolations = evaluateRuntimeDatabasePosture(posture, {
        ...options,
        protectedTables: FORCE_RLS_TABLES.filter((table) => !targetTables.has(table)),
        tablePrivileges: previousTablePrivileges,
        protectedNoDirectDmlTables: PROTECTED_NO_DIRECT_DML_TABLES.filter(
          (table) => !targetTables.has(table),
        ),
      });

      expect(previousViolations).toContain(
        "RLS tables are absent from the declared contract: tool_gateway_approval_capabilities",
      );
      for (const table of [...NON_RLS_RUNTIME_TABLES, "tool_gateway_approval_capabilities"].filter(
        (tableName) => targetTables.has(tableName),
      )) {
        expect(previousViolations).toContain(
          `table ${table} grants excess runtime privileges: SELECT, INSERT, UPDATE, DELETE`,
        );
      }
    } finally {
      await runtime.close().catch(() => undefined);
      await shared.release();
    }
  });

  test("allows the matching application principal to consume one capability once", async () => {
    if (!admin || !app) return;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `subject:${crypto.randomUUID()}`;
    const tokenHash = "a".repeat(64);
    await admin`insert into managed_accounts (id) values (${accountId})`;
    await admin`insert into workspaces (id, account_id) values (${workspaceId}, ${accountId})`;

    await app.begin(async (transaction) => {
      await transaction`select
        set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      await transaction`
        insert into tool_gateway_approval_capabilities (
          token_hash, account_id, workspace_id, subject_id, operation_id,
          catalog_digest, server_id, tool_name, arguments_digest, expires_at
        ) values (
          ${tokenHash}, ${accountId}, ${workspaceId}, ${subjectId}, ${crypto.randomUUID()},
          ${"b".repeat(64)}, 'docs', 'search', ${"c".repeat(64)},
          clock_timestamp() + interval '5 minutes'
        )`;
      const consumed = await transaction<{ token_hash: string }[]>`
        update tool_gateway_approval_capabilities
        set consumed_at = clock_timestamp()
        where token_hash = ${tokenHash} and consumed_at is null
        returning token_hash`;
      expect(consumed).toHaveLength(1);
      const replay = await transaction<{ token_hash: string }[]>`
        update tool_gateway_approval_capabilities
        set consumed_at = clock_timestamp()
        where token_hash = ${tokenHash} and consumed_at is null
        returning token_hash`;
      expect(replay).toHaveLength(0);
    });
  });
});
