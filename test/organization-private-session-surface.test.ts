import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const ENABLEMENT_MIGRATION = "packages/db/drizzle/0323_organization_private_session_enablement.sql";

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

  test("gates shared-workspace creates on receipt plus setting and leaves ordinary creates alone", async () => {
    const migration = await readFile(join(repo, ENABLEMENT_MIGRATION), "utf8");
    // The 0303 readiness receipt stays in the entry guard for every caller.
    expect(migration).toContain("OR NOT session_tenancy_product_activated(p_account_id, 1)");
    // The owner/admin setting is consulted only outside the actor's Personal workspace.
    expect(migration).toContain("IF NOT actor_personal_workspace THEN");
    expect(migration).toContain("organization_private_sessions_enabled(p_account_id)");
    expect(migration).toContain("actor.role NOT IN ('owner', 'admin')");
    expect(migration).toContain(
      "ALTER TABLE session_tenancy_activations NO FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("ALTER TABLE session_tenancy_activations FORCE ROW LEVEL SECURITY");
    // No rolling-compat trigger, reserved capability, or reused depth denial code.
    expect(migration).not.toContain("CREATE TRIGGER");
    expect(migration).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(migration).not.toContain("nested_agent_depth_exceeded");
    expect(migration).not.toContain("session_spawn_denials");

    // Ordinary creates never run a per-create policy call; only an explicit
    // private request reaches the target-free readiness preflight.
    const create = await readFile(join(repo, "packages/core/src/domain/sessions.ts"), "utf8");
    expect(create).not.toContain("getPrivateSessionCreatePolicy");
    expect(create).not.toContain("personalWorkspace");
    expect(create).toContain(
      'if (payload.visibility === "private" && !grant.metadata?.["sessionId"]) {',
    );
    const tenancy = await readFile(
      join(repo, "packages/core/src/application/session-tenancy.ts"),
      "utf8",
    );
    expect(tenancy).toContain("getPrivateSessionCreatePolicy(deps.db");
    expect(tenancy).toContain(
      "policy.personalWorkspace ? policy.platformAvailable : policy.organizationEnabled",
    );
    // A missing active membership is a capability answer, never an unmapped 500.
    expect(tenancy).toContain('nestedPostgresSqlState(error) !== "42501"');
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
