import { describe, expect, test } from "bun:test";
import type { AccessContext, Workspace } from "@opengeni/sdk";
import {
  orgLabel,
  organizationLandingWorkspaceId,
  organizationsForSubject,
  workspacesInOrg,
} from "../src/organization-model";

function workspace(id: string, accountId: string, name: string, kind = "shared"): Workspace {
  return { id, accountId, name, kind } as unknown as Workspace;
}

const context = {
  subjectId: "user:me",
  defaultAccountId: "org-b",
  accountGrants: [
    { accountId: "org-a", subjectId: "user:me", role: "member", metadata: { accountName: "Acme" } },
    { accountId: "org-b", subjectId: "user:me", role: "owner", metadata: { accountName: "Zeta" } },
  ],
  workspaceGrants: [],
} as unknown as AccessContext;

const workspaces = [
  workspace("w1", "org-a", "Research"),
  workspace("w2", "org-a", "Personal", "personal"),
  workspace("w3", "org-b", "Ops"),
  workspace("w4", "org-c", "Guest space"),
];

describe("organization model", () => {
  test("lists every organization, default first, with admin authority", () => {
    expect(organizationsForSubject(context, workspaces)).toEqual([
      { accountId: "org-b", label: "Zeta", canManage: true },
      { accountId: "org-a", label: "Acme", canManage: false },
      { accountId: "org-c", label: "Org org-c", canManage: false },
    ]);
    expect(orgLabel("0123456789abcdef", [])).toBe("Org 01234567");
  });

  test("switching lands on the remembered, else first shared, else personal workspace", () => {
    expect(workspacesInOrg(workspaces, "org-a").map((each) => each.id)).toEqual(["w2", "w1"]);
    expect(organizationLandingWorkspaceId(workspaces, "org-a", "w2")).toBe("w2");
    expect(organizationLandingWorkspaceId(workspaces, "org-a", "gone")).toBe("w1");
    expect(organizationLandingWorkspaceId(workspaces, "org-z")).toBeNull();
  });
});
