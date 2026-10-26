import { describe, expect, test } from "bun:test";
import {
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
} from "../src/organization-access";
import {
  PERSONAL_INTEGRATION_SETUP_PERMISSION,
  isPersonalIntegrationSetupCandidate,
  permissionSetCovers,
  personalIntegrationSetupAccess,
} from "../src/personal-integration-setup";

const reviewed = {
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
  runtime: { available: true },
};

describe("personal integration setup", () => {
  test("connections:write covers the narrow permission, not the reverse", () => {
    expect(PERSONAL_INTEGRATION_SETUP_PERMISSION).toBe("connections:personal");
    expect(permissionSetCovers(["connections:write"], "connections:personal")).toBe(true);
    expect(permissionSetCovers(["connections:personal"], "connections:write")).toBe(false);
    expect(permissionSetCovers(["connections:read"], "connections:personal")).toBe(false);
  });

  test("only reviewed, available OAuth MCP integrations are candidates", () => {
    expect(isPersonalIntegrationSetupCandidate(reviewed)).toBe(true);
    expect(isPersonalIntegrationSetupCandidate({ ...reviewed, source: "configured" })).toBe(true);
    for (const item of [
      { ...reviewed, source: "manual" },
      { ...reviewed, source: "library" },
      { ...reviewed, source: "public_registry" },
      { ...reviewed, authKind: "api_key" },
      { ...reviewed, kind: "api" },
      { ...reviewed, stale: true },
      { ...reviewed, workspaceId: "workspace" },
      { ...reviewed, runtime: { available: false } },
      { ...reviewed, source: "registry" },
      {
        ...reviewed,
        source: "registry",
        runtime: { available: true, catalogTrust: { state: "unverified" } },
      },
    ])
      expect(isPersonalIntegrationSetupCandidate(item)).toBe(false);
    expect(
      isPersonalIntegrationSetupCandidate({
        ...reviewed,
        source: "registry",
        runtime: { available: true, catalogTrust: { state: "trusted" } },
      }),
    ).toBe(true);
  });

  test("access: any for connect admins, personal for the narrow permission, else none", () => {
    const admin = {
      permissions: ["connections:read", "connections:write", "capabilities:manage"],
    };
    const narrow = { permissions: ["connections:personal"] };
    expect(personalIntegrationSetupAccess(admin, reviewed)).toBe("any");
    expect(personalIntegrationSetupAccess(narrow, reviewed)).toBe("personal");
    expect(personalIntegrationSetupAccess(narrow, { ...reviewed, source: "manual" })).toBeNull();
    expect(
      personalIntegrationSetupAccess({ permissions: ["connections:read"] }, reviewed),
    ).toBeNull();
    // Already on: only an installation that signs each person in.
    const personalBinding = {
      ...reviewed,
      enabled: true,
      connectionRef: { subjectScope: "subject" },
    };
    const sharedBinding = {
      ...reviewed,
      enabled: true,
      connectionRef: { subjectScope: "workspace" },
    };
    expect(personalIntegrationSetupAccess(narrow, personalBinding)).toBe("personal");
    expect(personalIntegrationSetupAccess(narrow, sharedBinding)).toBeNull();
    // A custom server needs an integration admin to turn it on.
    const custom = { ...reviewed, source: "manual" };
    expect(
      personalIntegrationSetupAccess(
        { permissions: ["connections:personal", "capabilities:manage"] },
        custom,
      ),
    ).toBe("personal");
  });

  test("legacy workspace:admin covers it; an explicit grant does not", () => {
    expect(personalIntegrationSetupAccess({ permissions: ["workspace:admin"] }, reviewed)).toBe(
      "any",
    );
    expect(
      personalIntegrationSetupAccess(
        { permissions: ["workspace:admin"], permissionMode: "explicit" },
        reviewed,
      ),
    ).toBeNull();
  });

  test("organization policies holding connections:write keep their preset", () => {
    const full = organizationAccessPresetPermissions("full");
    expect(full).toContain("connections:personal");
    const saved = normalizeOrganizationAccessPolicy({
      preset: "custom",
      permissions: full.filter((permission) => permission !== "connections:personal"),
      workspaceScope: { kind: "all" },
    });
    expect(saved.preset).toBe("full");
    expect(saved.permissions).toContain("connections:personal");
  });
});
