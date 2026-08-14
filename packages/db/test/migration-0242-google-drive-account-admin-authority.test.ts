import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../drizzle/0242_google_drive_account_admin_authority.sql", import.meta.url),
).text();

describe("migration 0242 Google Drive account-admin authority", () => {
  test("keeps the runtime seam exact and least privilege", () => {
    expect(migration).toContain("-- deployment-mode: rolling");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = %1$I, pg_catalog");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION %I.google_drive_workspace_account_admin_authorized(uuid, uuid, text) FROM PUBLIC",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION %I.google_drive_workspace_account_admin_authorized(uuid, uuid, text) TO opengeni_app",
    );
  });

  test("locks every current authority row through credential persistence", () => {
    expect(migration).toMatch(
      /FROM managed_accounts account[\s\S]+INNER JOIN workspaces workspace[\s\S]+FOR SHARE OF account, workspace;/u,
    );
    expect(migration).toMatch(
      /FROM organization_memberships membership[\s\S]+LIMIT 1\s+FOR SHARE OF membership;/u,
    );
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain("membership.revoked_at IS NULL");
  });

  test("restores the transaction-local organization lifecycle marker", () => {
    expect(migration).toContain("previous_marker text := pg_catalog.current_setting(");
    expect(
      migration.match(/CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END/gu),
    ).toHaveLength(2);
  });
});
