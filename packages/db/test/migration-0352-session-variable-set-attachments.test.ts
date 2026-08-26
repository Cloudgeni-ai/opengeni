import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { provisionRoles } from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let available = true;
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0351-runtime-protocol");
  if (!shared) {
    available = false;
    return;
  }
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

describe("migration 0352 ordered session Variable Set attachments", () => {
  test("declares one drained FK-backed cutover with authority and rotation fences", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0352_session_variable_set_attachments.sql", import.meta.url),
    ).text();
    const provisionRolesSource = await Bun.file(
      new URL("../src/provision-roles.ts", import.meta.url),
    ).text();

    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("no pre-0352 image may");
    expect(source).not.toContain("no pre-0348 image may");
    expect(source).toContain(
      "opengeni_private.session_variable_set_attachments_protocol_v1_active()",
    );
    expect(source).toContain(
      "current_setting('opengeni.session_variable_set_attachments_v1', true) = '1'",
    );
    expect(source).toContain("'opengeni-lossless-v1-session-variable-sets-v1'");
    expect(source).toMatch(
      /fence_legacy_lossless_content_update\(\)[\s\S]*?'opengeni-lossless-v1'[\s\S]*?'opengeni-lossless-v1-session-variable-sets-v1'/u,
    );
    expect(source).toContain("CREATE POLICY sessions_variable_set_attachments_protocol_v1");
    expect(source).toContain("AS RESTRICTIVE");
    expect(source).toContain("0352-or-newer runtime");
    expect(source).toMatch(
      /DO \$session_variable_set_protocol_grants\$[\s\S]*?JOIN pg_catalog\.pg_roles role_value[\s\S]*?role_value\.rolname = configured\.value/u,
    );
    expect(source).toContain("ADD COLUMN variable_set_ids jsonb NOT NULL DEFAULT '[]'::jsonb");
    const backfillFence = source.indexOf(
      "PERFORM acquire_session_tenancy_fence(workspace_id_value);",
    );
    const backfill = source.indexOf("UPDATE sessions\nSET variable_set_ids = CASE");
    expect(backfillFence).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(backfillFence);
    expect(source).toContain("CREATE TABLE session_variable_set_attachments");
    expect(source).toContain("CHECK (position >= 0 AND position < 25)");
    expect(source).toContain("session_status text NOT NULL");
    expect(source).toContain("session_variable_set_attachments_status_check");
    expect(source).toContain("variable_set_id uuid NOT NULL REFERENCES workspace_variable_sets");
    expect(source).toContain("FOREIGN KEY (workspace_id, account_id)");
    expect(source).toContain("REFERENCES workspaces(id, account_id) ON DELETE CASCADE");
    expect(source).toContain("FOREIGN KEY (workspace_id, session_id)");
    expect(source).toContain("REFERENCES sessions(workspace_id, id) ON DELETE CASCADE");
    expect(source).not.toContain("REFERENCES sessions(account_id, workspace_id, id)");
    expect(source.match(/variable_set_authority_capability_active\('write'\)/gu)).toHaveLength(4);
    expect(source).not.toContain("FROM opengeni_private.variable_set_authority_capabilities");
    expect(source).toContain("session_variable_set_attachments_session_set_uq");
    expect(source).toMatch(
      /CREATE OR REPLACE FUNCTION sync_session_variable_set_attachments\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog/u,
    );
    expect(source).toContain("DELETE FROM %I.session_variable_set_attachments");
    expect(source).toContain("resource_count BETWEEN 1 AND 52");
    expect(source).toContain("IF selected_count > 52 THEN");
    expect(source).toContain("targetSessionExecution' -> 'variableSets'");
    expect(source).toContain("session_row.variable_set_ids");
    expect(source).toContain("function_oid := pg_catalog.to_regprocedure");
    expect(source).toContain("IF function_oid IS NULL THEN");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION sync_session_variable_set_attachment_status",
    );
    expect(source).toContain("AFTER UPDATE OF status ON sessions");
    expect(source).toContain("variable set remains attached to % sessions");
    expect(source).not.toContain(
      "CREATE OR REPLACE FUNCTION refresh_session_variable_set_selection",
    );
    expect(source).not.toContain("CREATE TRIGGER session_variable_set_attachments_refresh");
    expect(source).not.toContain(
      "DELETE FROM %I.session_variable_set_attachments\n     WHERE variable_set_id",
    );
    expect(source).toContain("CREATE FUNCTION fork_session_content_with_runtime");
    expect(source).toContain("CREATE FUNCTION replay_applied_session_fork_with_runtime");
    expect(source).toContain("opengeni_private.configure_fork_session_runtime");
    const runtimeGrantBlock = source.slice(
      source.indexOf("DO $fork_runtime_search_path_and_grants$"),
      source.indexOf("REVOKE ALL ON FUNCTION opengeni_private.configure_fork_session_runtime"),
    );
    expect(runtimeGrantBlock).toContain("FOR application_role IN");
    expect(runtimeGrantBlock).toContain("current_setting('opengeni.migration_application_roles')");
    expect(runtimeGrantBlock).toContain("TO %I");
    expect(runtimeGrantBlock).not.toContain("TO opengeni_app");
    expect(provisionRolesSource).toContain(
      "opengeni_private.session_variable_set_attachments_protocol_v1_active() TO %I",
    );
    expect(provisionRolesSource).toContain(
      "%I.fork_session_content_with_runtime(uuid, uuid, uuid, text, uuid, text, boolean, text, text, integer, jsonb, uuid, uuid, text) TO %I",
    );
    expect(provisionRolesSource).toContain(
      "%I.replay_applied_session_fork_with_runtime(uuid, uuid, uuid, text, uuid, text, boolean, text, text, integer, text) TO %I",
    );
    const forkRuntimeFence = source.indexOf(
      "PERFORM acquire_session_tenancy_fence(p_workspace_id);",
    );
    const forkRuntimeLock = source.indexOf(
      "SELECT session_value.* INTO destination_session",
      forkRuntimeFence,
    );
    expect(forkRuntimeFence).toBeGreaterThanOrEqual(0);
    expect(forkRuntimeLock).toBeGreaterThan(forkRuntimeFence);
    expect(source).toContain("rig_version.default_variable_set_ids");
    expect(source).toContain("'session.runtime.configured', 'session'");
    expect(source).toContain("SET CONSTRAINTS sessions_activity_insert_commit_guard");
    expect(source).toContain("SET search_path TO pg_catalog, %I, pg_temp AS %L");
    expect(source).toContain("FOR application_role IN");
    expect(source).toContain("JOIN pg_catalog.pg_roles role_value");
    expect(source).toContain("REVOKE ALL ON TABLE %I.session_variable_set_attachments FROM %I");
    expect(source).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_variable_set_attachments",
    );
    expect(source).not.toContain("session_variable_set_attachments TO opengeni_app");
    expect(source).toContain("FK-backed lifecycle-only projection");
    expect(source).not.toContain("value_encrypted");
  });

  test("rejects a pre-0352 transaction and admits the current runtime receipt", async () => {
    if (!available) return;
    await expect(
      shared!.admin.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE "opengeni_app"');
        await tx`select set_config('application_name', 'opengeni-lossless-v1', true)`;
        return await tx`
          select opengeni_private.session_variable_set_attachments_protocol_v1_active()
        `;
      }),
    ).rejects.toThrow("0352-or-newer runtime");

    const currentReceipt = await shared!.admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE "opengeni_app"');
      await tx`select set_config(
        'application_name', ${LOSSLESS_CONTENT_WRITER_APPLICATION_NAME}, true
      )`;
      return await tx<Array<{ active: boolean; applicationName: string }>>`
        select
          opengeni_private.session_variable_set_attachments_protocol_v1_active() as active,
          current_setting('application_name') as "applicationName"
      `;
    });
    expect([...currentReceipt]).toEqual([
      {
        active: true,
        applicationName: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
      },
    ]);

    const injectedReceipt = await shared!.admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE "opengeni_app"');
      await tx`select set_config('application_name', 'opengeni-lossless-v1', true)`;
      await tx`select set_config(
        'opengeni.session_variable_set_attachments_v1', '1', true
      )`;
      return await tx<{ active: boolean }[]>`
        select opengeni_private.session_variable_set_attachments_protocol_v1_active()
          as active
      `;
    });
    expect([...injectedReceipt]).toEqual([{ active: true }]);
  }, 180_000);

  test("provisionRoles converges all runtime EXECUTE grants for a role created after migration", async () => {
    if (!available) return;
    const role = `varset_runtime_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const password = crypto.randomUUID().replaceAll("-", "");
    try {
      await provisionRoles(shared!.adminUrl, {
        appRole: role,
        appPassword: password,
        rlsStrategy: "force",
      });
      const [privileges] = await shared!.admin<
        Array<{ predicate: boolean; fork: boolean; replay: boolean }>
      >`
        select
          has_function_privilege(
            ${role},
            'opengeni_private.session_variable_set_attachments_protocol_v1_active()',
            'EXECUTE'
          ) as predicate,
          has_function_privilege(
            ${role},
            'public.fork_session_content_with_runtime(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,jsonb,uuid,uuid,text)',
            'EXECUTE'
          ) as fork,
          has_function_privilege(
            ${role},
            'public.replay_applied_session_fork_with_runtime(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,text)',
            'EXECUTE'
          ) as replay`;
      expect(privileges).toEqual({ predicate: true, fork: true, replay: true });
    } finally {
      await shared!.admin.unsafe(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await shared!.admin.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    }
  }, 180_000);
});
