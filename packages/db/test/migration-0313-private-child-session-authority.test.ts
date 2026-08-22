import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0313-private-child-authority");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("migration 0313 requires PostgreSQL");
  }
}, 180_000);

afterAll(async () => shared?.release(), 180_000);

describe("migration 0313 private child session authority", () => {
  test("binds one insert to an exact parent attempt and blocks capability reuse", async () => {
    const source = await readFile(
      new URL("../drizzle/0313_private_child_session_authority.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("turn_row.active_attempt_id = p_actor_attempt_id");
    expect(source).toContain("attempt.state IN ('claimed', 'running')");
    expect(source).toContain("actor_human_subject_id IS DISTINCT FROM parent_row.owner_subject_id");
    expect(source).toContain("SELECT access.id INTO owner_workspace_access_id");
    expect(source).toContain("FOR KEY SHARE;");
    expect(source).toContain("child_capability.session_id IS DISTINCT FROM NEW.id");
    expect(source).toContain("TG_OP <> 'INSERT'");
    expect(source).toContain("NEW.sandbox_group_id IS NULL");
    expect(source).toContain("NEW.sandbox_group_id IS DISTINCT FROM NEW.id");
    expect(source).toContain("NEW.sandbox_group_id IS DISTINCT FROM parent_sandbox_group_id");
    expect(source).toContain("DELETE FROM session_visibility_write_capabilities capability");
    expect(source).toContain("CREATE FUNCTION fence_child_session_authority()");
    expect(source).toContain("NEW.visibility IS DISTINCT FROM parent_visibility");
    expect(source).toContain("NEW.create_requested_visibility IS DISTINCT FROM parent_visibility");
    expect(source).toContain("FOR SHARE;");
  });

  test("keeps the capability tables opaque and grants only the definer routine", async () => {
    if (!shared) return;
    const [routine] = await shared.admin<
      Array<{
        executable: boolean;
        searchPath: string;
        privateTriggerCount: number;
        universalTriggerCount: number;
      }>
    >`
      select
        has_function_privilege(
          'opengeni_app',
          to_regprocedure(
            current_schema() || '.open_private_child_session_create_capability(uuid,uuid,uuid,uuid,uuid,uuid,integer)'
          ),
          'EXECUTE'
        ) as executable,
        (
          select config from unnest(procedure.proconfig) config
          where config like 'search_path=%'
        ) as "searchPath",
        (
          select count(*)::integer from pg_trigger trigger_row
          join pg_class relation on relation.oid = trigger_row.tgrelid
          where relation.relname = 'sessions'
            and trigger_row.tgname = 'session_00_private_child_create_fence'
            and not trigger_row.tgisinternal
        ) as "privateTriggerCount",
        (
          select count(*)::integer from pg_trigger trigger_row
          join pg_class relation on relation.oid = trigger_row.tgrelid
          where relation.relname = 'sessions'
            and trigger_row.tgname = 'sessions_child_authority_fence'
            and not trigger_row.tgisinternal
        ) as "universalTriggerCount"
      from pg_proc procedure
      where procedure.oid = to_regprocedure(
        current_schema() || '.open_private_child_session_create_capability(uuid,uuid,uuid,uuid,uuid,uuid,integer)'
      )`;
    expect(routine).toEqual({
      executable: true,
      searchPath: "search_path=pg_catalog, public, pg_temp",
      privateTriggerCount: 1,
      universalTriggerCount: 1,
    });
    const [table] = await shared.admin<
      Array<{ appSelect: boolean; appInsert: boolean; appUpdate: boolean; appDelete: boolean }>
    >`
      select
        has_table_privilege('opengeni_app', relation.oid, 'SELECT') as "appSelect",
        has_table_privilege('opengeni_app', relation.oid, 'INSERT') as "appInsert",
        has_table_privilege('opengeni_app', relation.oid, 'UPDATE') as "appUpdate",
        has_table_privilege('opengeni_app', relation.oid, 'DELETE') as "appDelete"
      from pg_class relation
      where relation.relname = 'private_session_create_capabilities'`;
    expect(table).toEqual({
      appSelect: false,
      appInsert: false,
      appUpdate: false,
      appDelete: false,
    });
  });
});
