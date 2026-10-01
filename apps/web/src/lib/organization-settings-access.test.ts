import { describe, expect, test } from "bun:test";

import { organizationLandingWorkspaceId, organizationSettingsWorkspaceId } from "./org";
import {
  organizationSettingsAccess,
  resolveOrganizationSettingsSection,
} from "./organization-settings-access";
import type { AccessContext, Workspace } from "@/types";

const managed = { productAccessMode: "managed", auth: { mode: "managedSession" } } as const;
const local = { productAccessMode: "local", auth: { mode: "none" } } as const;

function context(
  role: "owner" | "admin" | "member" | undefined,
  permissions: string[],
  workspaceGrants: { workspaceId: string; accountId: string; permissions: string[] }[] = [],
): AccessContext {
  return {
    mode: "managed",
    subjectId: "user:alex",
    defaultAccountId: "acme",
    accountGrants: [{ accountId: "acme", subjectId: "user:alex", role, permissions }],
    workspaceGrants: workspaceGrants.map((grant) => ({ ...grant, subjectId: "user:alex" })),
  } as unknown as AccessContext;
}

function visible(
  role: "owner" | "admin" | "member" | undefined,
  permissions: string[],
  clientConfig: typeof managed | typeof local = managed,
  workspaceGrants: { workspaceId: string; accountId: string; permissions: string[] }[] = [],
): string[] {
  return [
    ...organizationSettingsAccess({
      accessContext: context(role, permissions, workspaceGrants),
      clientConfig: clientConfig as never,
      accountId: "acme",
    }).visibleSections,
  ].sort();
}

describe("organization settings access", () => {
  test("owners see every page", () => {
    expect(
      visible("owner", [
        "account:read",
        "account:admin",
        "workspace:create",
        "billing:read",
        "billing:manage",
        "api_keys:manage",
      ]),
    ).toEqual(
      [
        "billing",
        "developer",
        "general",
        "identity",
        "integrations",
        "models",
        "people",
        "security",
        "workspaces",
      ].sort(),
    );
  });

  test("members see only what they can use: identity (read-only) and security", () => {
    expect(visible("member", ["account:read"])).toEqual(["identity", "security"]);
  });

  test("a workspace admin also sees Models, for the workspaces they administer", () => {
    const grants = [
      { workspaceId: "ws-team", accountId: "acme", permissions: ["workspace:admin"] },
      { workspaceId: "ws-other", accountId: "acme", permissions: ["workspace:read"] },
      { workspaceId: "ws-elsewhere", accountId: "other", permissions: ["workspace:admin"] },
    ];
    expect(visible("member", ["account:read"], managed, grants)).toEqual([
      "identity",
      "models",
      "security",
    ]);
    expect(
      organizationSettingsAccess({
        accessContext: context("member", ["account:read"], grants),
        clientConfig: managed as never,
        accountId: "acme",
      }).administeredWorkspaceIds,
    ).toEqual(["ws-team"]);
    // A Personal workspace grant (no workspace:admin) is not administering one.
    expect(
      visible("member", ["account:read"], managed, [
        {
          workspaceId: "ws-me",
          accountId: "acme",
          permissions: ["workspace:read", "connections:write"],
        },
      ]),
    ).toEqual(["identity", "security"]);
  });

  test("the single local user administers without a People page", () => {
    const pages = visible("owner", ["account:admin"], local);
    expect(pages).toContain("workspaces");
    expect(pages).not.toContain("people");
  });

  test("a hidden page falls back to the first page the person can use", () => {
    const sections = new Set(["identity", "security"] as const);
    expect(resolveOrganizationSettingsSection("people", sections)).toBe("identity");
    expect(resolveOrganizationSettingsSection("security", sections)).toBe("security");
    expect(resolveOrganizationSettingsSection(null, sections)).toBe("identity");
  });
});

describe("organization helpers for the picker", () => {
  const workspaces = [
    { id: "ws-member", accountId: "member", name: "Member workspace", kind: "shared" },
    { id: "ws-a", accountId: "a", name: "Main", kind: "shared" },
    { id: "ws-b-personal", accountId: "b", name: "Alpha", kind: "personal" },
    { id: "ws-b-z", accountId: "b", name: "Zulu", kind: "shared" },
    { id: "ws-c-personal", accountId: "c", name: "Personal workspace", kind: "personal" },
  ] as Workspace[];

  test("switching organization lands on its first shared workspace, else the Personal one", () => {
    expect(organizationLandingWorkspaceId(workspaces, "b")).toBe("ws-b-z");
    expect(organizationLandingWorkspaceId(workspaces, "c")).toBe("ws-c-personal");
    expect(organizationLandingWorkspaceId(workspaces, "empty")).toBeNull();
  });

  test("organization settings open through an accessible workspace of that organization", () => {
    expect(organizationSettingsWorkspaceId(workspaces, "a", "ws-a")).toBe("ws-a");
    expect(organizationSettingsWorkspaceId(workspaces, "b", "ws-a")).toBe("ws-b-personal");
    expect(organizationSettingsWorkspaceId(workspaces, "b", "ws-b-z")).toBe("ws-b-z");
    expect(organizationSettingsWorkspaceId(workspaces, "empty", "ws-a")).toBeNull();
  });

  test("switching organization returns to the workspace last used there, while it is still open", () => {
    expect(organizationLandingWorkspaceId(workspaces, "b", "ws-b-personal")).toBe("ws-b-personal");
    // Gone, or in another organization: fall back to the first shared workspace.
    expect(organizationLandingWorkspaceId(workspaces, "b", "ws-deleted")).toBe("ws-b-z");
    expect(organizationLandingWorkspaceId(workspaces, "b", "ws-a")).toBe("ws-b-z");
    expect(organizationLandingWorkspaceId(workspaces, "b", null)).toBe("ws-b-z");
  });

  test("creating workspaces follows Organization settings > Workspaces: owners and admins only", () => {
    const pages = (role: "owner" | "admin" | "member", permissions: string[]) =>
      organizationSettingsAccess({
        accessContext: context(role, permissions),
        clientConfig: managed as never,
        accountId: "acme",
      }).visibleSections.has("workspaces");
    expect(pages("owner", ["account:admin"])).toBe(true);
    expect(pages("admin", ["account:read", "workspace:create"])).toBe(true);
    expect(pages("member", ["account:read"])).toBe(false);
  });
});
