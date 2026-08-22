import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

describe("organization private-session product surface", () => {
  test("uses a dedicated owner/admin settings API and never the members endpoint", async () => {
    const route = await readFile(
      join(repo, "apps/api/src/routes/organization-memberships.ts"),
      "utf8",
    );
    expect(route).toContain("/v1/organizations/:organizationId/private-session-settings");
    const component = await readFile(
      join(repo, "apps/web/src/components/organization-admin.tsx"),
      "utf8",
    );
    const start = component.indexOf("export function OrganizationPrivateSessionsSection");
    const end = component.indexOf("export function OrganizationOverviewSection", start);
    const surface = component.slice(start, end);
    expect(surface).toContain("getOrganizationPrivateSessionSettings");
    expect(surface).toContain("updateOrganizationPrivateSessionSettings");
    expect(surface).not.toContain("listOrganizationMembers");
    expect(surface).not.toContain("/members");
  });

  test("keeps Personal workspaces automatic and organization workspaces gated", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0316_organization_private_session_enablement.sql"),
      "utf8",
    );
    expect(migration).toContain("actor.personal_workspace_id = p_workspace_id");
    expect(migration).toContain("organization_private_sessions_enabled(p_account_id)");
    expect(migration).toContain("actor.role NOT IN ('owner', 'admin')");
    expect(migration).toContain(
      "ALTER TABLE session_tenancy_activations NO FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("ALTER TABLE session_tenancy_activations FORCE ROW LEVEL SECURITY");
    const create = await readFile(join(repo, "packages/core/src/domain/sessions.ts"), "utf8");
    expect(create).toContain('requestedVisibility: personalWorkspace ? "private"');
    expect(create).toContain("!personalWorkspace && !payload.idempotencyKey");
  });

  test("registers exact capability-only database posture and provisioning", async () => {
    const posture = await readFile(join(repo, "packages/db/src/runtime-posture.ts"), "utf8");
    for (const table of [
      "organization_private_session_setting_events",
      "organization_private_session_settings",
    ]) {
      expect(posture).toContain(`"${table}"`);
    }
    for (const routine of [
      "get_private_session_create_policy(uuid, uuid, text)",
      "get_organization_private_session_settings(uuid, text)",
      "update_organization_private_session_settings(uuid, text, boolean, bigint, uuid)",
      "organization_private_sessions_enabled(uuid)",
    ]) {
      expect(posture).toContain(routine);
    }
    const provisioner = await readFile(join(repo, "packages/db/src/provision-roles.ts"), "utf8");
    expect(provisioner).toContain(
      "REVOKE ALL ON FUNCTION %I.organization_private_sessions_enabled(uuid) FROM %I",
    );
    expect(provisioner).toContain(
      "GRANT EXECUTE ON FUNCTION %I.get_private_session_create_policy(uuid, uuid, text) TO %I",
    );
    expect(provisioner).toContain(
      "GRANT EXECUTE ON FUNCTION %I.get_organization_private_session_settings(uuid, text) TO %I",
    );
    expect(provisioner).toContain(
      "GRANT EXECUTE ON FUNCTION %I.update_organization_private_session_settings(uuid, text, boolean, bigint, uuid) TO %I",
    );
  });
});
