import { describe, expect, test } from "bun:test";
import {
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
} from "../src/organization-access";
import {
  PERSONAL_INTEGRATION_SETUP_PERMISSION,
  canAddIntegrations,
  inChatCapabilitySetup,
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

  test("members turn on any integration that is not on yet, custom servers included", () => {
    const member = { permissions: ["connections:read", "connections:write"] };
    expect(personalIntegrationSetupAccess(member, reviewed)).toBe("any");
    expect(personalIntegrationSetupAccess(member, { ...reviewed, source: "manual" })).toBe("any");
    expect(personalIntegrationSetupAccess(member, { ...reviewed, authKind: "api_key" })).toBe(
      "any",
    );
    expect(canAddIntegrations(member)).toBe(true);
    expect(canAddIntegrations({ permissions: ["capabilities:manage"] })).toBe(true);
    expect(canAddIntegrations({ permissions: ["workspace:admin"] })).toBe(true);
    expect(
      canAddIntegrations({ permissions: ["workspace:admin"], permissionMode: "explicit" }),
    ).toBe(false);
    for (const permissions of [["connections:read"], ["connections:personal"], []])
      expect(canAddIntegrations({ permissions })).toBe(false);
  });

  test("an organization that keeps turning integrations on for admins: members are offered nothing new", () => {
    const member = { permissions: ["connections:read", "connections:write"] };
    const narrow = { permissions: ["connections:read", "connections:personal"] };
    const admin = { permissions: ["workspace:admin"] };
    expect(canAddIntegrations(member, "admins")).toBe(false);
    expect(canAddIntegrations(member, "members")).toBe(true);
    expect(canAddIntegrations(admin, "admins")).toBe(true);
    expect(personalIntegrationSetupAccess(member, reviewed, "admins")).toBeNull();
    expect(personalIntegrationSetupAccess(narrow, reviewed, "admins")).toBeNull();
    expect(personalIntegrationSetupAccess(admin, reviewed, "admins")).toBe("any");
    // Connecting one's own account to what is already on changes no installation.
    const on = { ...reviewed, enabled: true, connectionRef: { subjectScope: "subject" } };
    expect(personalIntegrationSetupAccess(narrow, on, "admins")).toBe("personal");

    const chat = ["workspace:read", "sessions:read", "sessions:control"];
    expect(
      inChatCapabilitySetup(
        { permissions: [...chat, "connections:write"] },
        "plugin:x/y",
        undefined,
        "admins",
      ),
    ).toEqual({ kind: "unavailable" });
    expect(
      inChatCapabilitySetup(
        { permissions: [...chat, ...member.permissions] },
        "mcp:gmail",
        reviewed,
        "admins",
      ),
    ).toEqual({ kind: "unavailable" });
  });

  test("in-chat setup: a member's card can install a plugin", () => {
    const chat = ["workspace:read", "sessions:read", "sessions:control"];
    expect(
      inChatCapabilitySetup(
        { permissions: [...chat, "connections:write"] },
        "plugin:x/y",
        undefined,
      ),
    ).toEqual({ kind: "default" });
    expect(inChatCapabilitySetup({ permissions: chat }, "plugin:x/y", undefined)).toEqual({
      kind: "unavailable",
    });
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

  test("in-chat setup: what the agent's card can offer this person", () => {
    const chat = ["workspace:read", "sessions:read", "sessions:control"];
    const personal = [...chat, "connections:personal"];
    const definition = "api:integration:microsoft-outlook-mail";
    expect(inChatCapabilitySetup({ permissions: chat }, definition, undefined)).toEqual({
      kind: "unavailable",
    });
    expect(inChatCapabilitySetup({ permissions: personal }, definition, undefined)).toEqual({
      kind: "integration",
    });
    expect(
      inChatCapabilitySetup({ permissions: ["connections:personal"] }, definition, undefined),
    ).toEqual({ kind: "unavailable" });

    const gmail = "mcp:gmail";
    expect(inChatCapabilitySetup({ permissions: chat }, gmail, reviewed)).toEqual({
      kind: "unavailable",
    });
    expect(inChatCapabilitySetup({ permissions: personal }, gmail, reviewed)).toEqual({
      kind: "card",
      personalOnly: true,
    });
    expect(inChatCapabilitySetup({ permissions: ["workspace:admin"] }, gmail, reviewed)).toEqual({
      kind: "card",
      personalOnly: false,
    });
    // A workspace's shared account needs only read access to use it here.
    const shared = { ...reviewed, enabled: true, connectionRef: { subjectScope: "workspace" } };
    expect(
      inChatCapabilitySetup({ permissions: [...chat, "connections:read"] }, gmail, shared),
    ).toEqual({ kind: "card", personalOnly: false });
    expect(inChatCapabilitySetup({ permissions: personal }, gmail, shared)).toEqual({
      kind: "unavailable",
    });
    // Other kinds of setup are not decided here.
    expect(inChatCapabilitySetup({ permissions: chat }, "api:github-app", undefined)).toEqual({
      kind: "default",
    });
    expect(
      inChatCapabilitySetup({ permissions: chat }, gmail, { ...reviewed, authKind: "api_key" }),
    ).toEqual({ kind: "default" });
  });
});
