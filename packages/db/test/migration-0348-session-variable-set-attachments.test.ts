import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb, setRlsContext, type DbClient } from "../src";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0348-runtime-protocol");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("migration 0348 ordered session Variable Set attachments", () => {
  test("declares one drained FK-backed cutover with authority and rotation fences", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0348_session_variable_set_attachments.sql", import.meta.url),
    ).text();

    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("no pre-0348 image may");
    expect(source).not.toContain("no pre-0347 image may");
    expect(source).toContain(
      "opengeni_private.session_variable_set_attachments_protocol_v1_active()",
    );
    expect(source).toContain(
      "current_setting('opengeni.session_variable_set_attachments_v1', true) = '1'",
    );
    expect(source).toContain("CREATE POLICY sessions_variable_set_attachments_protocol_v1");
    expect(source).toContain("AS RESTRICTIVE");
    expect(source).toContain("0348-or-newer runtime");
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

  test("rejects a pre-0348 transaction and admits the current runtime receipt", async () => {
    if (!available) return;
    await expect(
      client!.db.transaction((tx) =>
        tx.execute(
          sql`select opengeni_private.session_variable_set_attachments_protocol_v1_active()`,
        ),
      ),
    ).rejects.toThrow("0348-or-newer runtime");

    await expect(
      client!.db.transaction(async (tx) => {
        await setRlsContext(tx, {
          accountId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
        });
        return await tx.execute<{ active: boolean }>(
          sql`select opengeni_private.session_variable_set_attachments_protocol_v1_active() as active`,
        );
      }),
    ).resolves.toEqual([{ active: true }]);
  }, 180_000);
});
