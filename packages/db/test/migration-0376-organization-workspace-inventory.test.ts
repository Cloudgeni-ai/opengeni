import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0376_organization_workspace_inventory.sql",
  import.meta.url,
);

describe("migration 0376 organization workspace inventory", () => {
  test("installs one account-fenced content-free shared-workspace capability", async () => {
    const source = await Bun.file(migrationUrl).text();
    const provisionRoles = await Bun.file(
      new URL("../src/provision-roles.ts", import.meta.url),
    ).text();
    const runtimePosture = await Bun.file(
      new URL("../src/runtime-posture.ts", import.meta.url),
    ).text();

    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("CREATE FUNCTION list_organization_workspace_ids(p_account_id uuid)");
    expect(source).toContain("RETURNS TABLE (workspace_id uuid)");
    expect(source).toContain("LANGUAGE plpgsql SECURITY DEFINER");
    expect(source).toContain("p_account_id IS DISTINCT FROM opengeni_private.current_account_id()");
    expect(source).toContain("opengeni_private.current_workspace_id() IS NOT NULL");
    expect(source).toContain("FROM organization_memberships membership");
    expect(source).toContain("membership.personal_workspace_id = workspace.id");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION list_organization_workspace_ids(uuid) FROM PUBLIC",
    );
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain("pg_catalog.jsonb_array_elements_text(");
    expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(source).not.toContain("GRANT SELECT ON");
    expect(provisionRoles).toContain('"list_organization_workspace_ids(uuid)"');
    expect(runtimePosture).toContain('"list_organization_workspace_ids(uuid)"');
  });
});
