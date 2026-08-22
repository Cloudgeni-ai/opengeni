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
    expect(route).toContain('/v1/organizations/:organizationId/private-session-settings');
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
      join(repo, "packages/db/drizzle/0315_organization_private_session_enablement.sql"),
      "utf8",
    );
    expect(migration).toContain("actor.personal_workspace_id = p_workspace_id");
    expect(migration).toContain("organization_private_sessions_enabled(p_account_id)");
    expect(migration).toContain("actor.role NOT IN ('owner', 'admin')");
    const create = await readFile(join(repo, "packages/core/src/domain/sessions.ts"), "utf8");
    expect(create).toContain('requestedVisibility: personalWorkspace ? "private"');
  });
});