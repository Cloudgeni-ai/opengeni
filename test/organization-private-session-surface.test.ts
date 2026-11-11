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
      join(repo, "apps/web/src/components/organization/security-page.tsx"),
      "utf8",
    );
    const start = component.indexOf("function PrivateChatsRow");
    const end = component.indexOf("function RetentionRow", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const surface = component.slice(start, end);
    expect(surface).toContain("getOrganizationPrivateSessionSettings");
    expect(surface).toContain("updateOrganizationPrivateSessionSettings");
    expect(surface).not.toContain("listOrganizationMembers");
    expect(surface).not.toContain("/members");
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
