import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0311-company-scope-private-create");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("migration 0311 requires PostgreSQL");
  }
}, 180_000);

afterAll(async () => shared?.release(), 180_000);

describe("migration 0311 company scope and private session create", () => {
  test("is a rolling, capability-only runtime surface", async () => {
    const source = await readFile(
      new URL("../drizzle/0311_company_scope_and_private_session_create.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("CREATE TABLE organization_profile_events");
    expect(source).toContain("CREATE TABLE private_session_create_capabilities");
    expect(source).toContain("ALTER TABLE organization_profile_events FORCE ROW LEVEL SECURITY");
    expect(source).toContain("ADD COLUMN create_requested_visibility");
    expect(source).toContain("RETURNS TABLE (capability_id uuid, owner_membership_id uuid)");
    expect(source).toContain("capability.session_id = NEW.id");
    expect(source).toContain(
      "RETURNING capability.capability_id INTO private_create_capability_id",
    );
    expect(source).toContain("sessions_create_requested_visibility_immutable");
    expect(source).toContain(
      "FROM managed_accounts account\n  WHERE account.id = p_account_id FOR SHARE",
    );
    expect(source).toContain(
      "FROM managed_accounts candidate\n  WHERE candidate.id = p_account_id FOR UPDATE",
    );
    expect(source).toContain("WITH shared_workspaces AS MATERIALIZED");
    expect(source).toContain("CROSS JOIN bounds");
    expect(source).toContain("membership.personal_workspace_id = p_workspace_id");
    expect(source).not.toContain("GRANT INSERT ON organization_profile_events");
    expect(source).not.toContain("GRANT UPDATE ON managed_accounts");
  });

  test("pins every definer and grants only exact routines to the app role", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{
        name: string;
        arguments: string;
        executable: boolean;
        searchPath: string;
      }>
    >`
      select procedure.proname as name,
        pg_get_function_identity_arguments(procedure.oid) as arguments,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as executable,
        (select config from unnest(procedure.proconfig) config where config like 'search_path=%')
          as "searchPath"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = current_schema()
        and procedure.proname in (
          'get_organization_administration_overview',
          'update_organization_name',
          'open_private_session_create_capability',
          'close_private_session_create_capability'
        )
      order by procedure.proname`;
    expect(Array.from(rows)).toEqual([
      {
        name: "close_private_session_create_capability",
        arguments: "p_capability_id uuid",
        executable: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      },
      {
        name: "get_organization_administration_overview",
        arguments: "p_account_id uuid, p_actor_subject_id text",
        executable: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      },
      {
        name: "open_private_session_create_capability",
        arguments:
          "p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_actor_subject_id text",
        executable: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      },
      {
        name: "update_organization_name",
        arguments:
          "p_account_id uuid, p_actor_subject_id text, p_name text, p_expected_updated_at timestamp with time zone, p_operation_id uuid",
        executable: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      },
    ]);
    const posture = await shared.admin<
      Array<{
        name: string;
        rls: boolean;
        forceRls: boolean;
        appSelect: boolean;
        appInsert: boolean;
        appUpdate: boolean;
        appDelete: boolean;
        policies: number;
      }>
    >`
      select relation.relname as name,
        relation.relrowsecurity as rls,
        relation.relforcerowsecurity as "forceRls",
        has_table_privilege('opengeni_app', relation.oid, 'SELECT') as "appSelect",
        has_table_privilege('opengeni_app', relation.oid, 'INSERT') as "appInsert",
        has_table_privilege('opengeni_app', relation.oid, 'UPDATE') as "appUpdate",
        has_table_privilege('opengeni_app', relation.oid, 'DELETE') as "appDelete",
        (select count(*)::integer from pg_policy policy where policy.polrelid = relation.oid)
          as policies
      from pg_class relation
      where relation.relname in (
        'organization_profile_events', 'private_session_create_capabilities'
      )
      order by relation.relname`;
    expect(Array.from(posture)).toEqual(
      ["organization_profile_events", "private_session_create_capabilities"].map((name) => ({
        name,
        rls: true,
        forceRls: true,
        appSelect: false,
        appInsert: false,
        appUpdate: false,
        appDelete: false,
        policies: 1,
      })),
    );
  });
});
