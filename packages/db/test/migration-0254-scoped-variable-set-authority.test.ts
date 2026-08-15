import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../drizzle/0254_scoped_variable_set_authority.sql", import.meta.url);

describe("migration 0254 scoped variable-set authority", () => {
  test("is rolling, derives user ownership, and keeps authority tables capability-only", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("'organization', 'workspace', 'user'");
    expect(source).toContain("CREATE OR REPLACE FUNCTION %1$I.create_scoped_variable_set");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("SET search_path = %1$I, pg_catalog");
    expect(source).toContain("current_setting('opengeni.subject_id', true)");
    expect(source).toContain("membership.subject_id = caller_subject");
    expect(source).toContain("membership.status = 'active'");
    expect(source).toContain("membership.revoked_at IS NULL");
    expect(source).not.toMatch(/p_owner|owner_subject|p_membership/iu);
    expect(source).toContain(
      "REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app",
    );
    expect(source).toContain(
      "REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app",
    );
    expect(source).toContain('ADD COLUMN "generation" bigint NOT NULL DEFAULT 1');
    expect(source).toContain("ADD COLUMN \"status\" text NOT NULL DEFAULT 'active'");
    expect(source).toContain("variable_set_authority_capabilities");
    expect(source).toContain("list_scoped_variable_sets");
    expect(source).toContain("mutate_scoped_variable_set");
    expect(source).toContain("read_scoped_variable_set_secret");
    expect(source).toContain("materialize_scoped_variable_set_for_attempt");
    expect(source).toContain("materialize_scoped_variable_set_for_session");
    expect(source).toContain("resolve_session_attempt_personal_resources");
    expect(source).toContain("variable_set.materialized");
    expect(source).toContain("metadata_codec_version");
    expect(source).toContain(
      "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_variable_sets",
    );
    expect(source).toContain(
      "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_variable_set_variables",
    );
    expect(source).not.toMatch(/value_encrypted[^\n]*audit_events/iu);
  });
});
