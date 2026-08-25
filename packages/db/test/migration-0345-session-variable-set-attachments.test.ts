import { describe, expect, test } from "bun:test";

describe("migration 0345 ordered session Variable Set attachments", () => {
  test("declares one drained FK-backed cutover with authority and rotation fences", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0345_session_variable_set_attachments.sql", import.meta.url),
    ).text();

    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("ADD COLUMN variable_set_ids jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(source).toContain("CREATE TABLE session_variable_set_attachments");
    expect(source).toContain("CHECK (position >= 0 AND position < 25)");
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
    expect(source).toContain("variable set remains attached to % sessions");
    expect(source).toContain("CREATE FUNCTION fork_session_content_with_runtime");
    expect(source).toContain("CREATE FUNCTION replay_applied_session_fork_with_runtime");
    expect(source).toContain("opengeni_private.configure_fork_session_runtime");
    expect(source).toContain("rig_version.default_variable_set_ids");
    expect(source).toContain("'session.runtime.configured', 'session'");
    expect(source).toContain("SET CONSTRAINTS sessions_activity_insert_commit_guard");
    expect(source).toContain("SET search_path TO pg_catalog, %I, pg_temp AS %L");
    expect(source).toContain("FOR application_role IN");
    expect(source).toContain("JOIN pg_catalog.pg_roles role_value");
    expect(source).toContain("session_variable_set_attachments TO %I");
    expect(source).not.toContain("session_variable_set_attachments TO opengeni_app");
    expect(source).toContain("REVOKE ALL ON FUNCTION refresh_session_variable_set_selection()");
    expect(source).not.toContain("value_encrypted");
  });
});
