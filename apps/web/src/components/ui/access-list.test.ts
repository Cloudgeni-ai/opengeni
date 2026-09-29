import { describe, expect, test } from "bun:test";

import { groupAccessMembers, removeBlockedReason, type AccessMember } from "./access-list";
import { needsEscalationConfirm, roleLabel, type RoleOption } from "./role-select";

type Role = "viewer" | "member" | "workspace_admin";

const ROLES: RoleOption<Role>[] = [
  {
    id: "viewer",
    label: "Viewer",
    description: "Can view sessions, files and approved knowledge.",
  },
  { id: "member", label: "Member", description: "Can start chats and add workspace content." },
  {
    id: "workspace_admin",
    label: "Workspace admin",
    description: "Can manage workspace settings, access and integrations.",
    escalation: true,
  },
];

function member(partial: Partial<AccessMember<Role>> & { id: string }): AccessMember<Role> {
  return { name: partial.id, initials: "XX", role: "member", ...partial };
}

describe("groupAccessMembers", () => {
  test("lists you first, then owners, then everyone else in server order; services apart", () => {
    const { people, services } = groupAccessMembers([
      member({ id: "maria" }),
      member({ id: "ci", kind: "service" }),
      member({ id: "owner", isOwner: true }),
      member({ id: "jonas" }),
      member({ id: "you", isYou: true }),
    ]);
    expect(people.map((each) => each.id)).toEqual(["you", "owner", "maria", "jonas"]);
    expect(services.map((each) => each.id)).toEqual(["ci"]);
  });
});

describe("removeBlockedReason", () => {
  test("you and owners can't be removed here; others can", () => {
    expect(removeBlockedReason(member({ id: "you", isYou: true }))).toBe(
      "You can't remove yourself here.",
    );
    expect(removeBlockedReason(member({ id: "owner", isOwner: true }))).toBe(
      "Owners always have access.",
    );
    expect(removeBlockedReason(member({ id: "maria" }))).toBeNull();
  });
});

describe("roles", () => {
  test("labels come from the catalog, with custom and no access", () => {
    expect(roleLabel(ROLES, "workspace_admin")).toBe("Workspace admin");
    expect(roleLabel(ROLES, "custom")).toBe("Custom (set via API)");
    expect(roleLabel(ROLES, null)).toBe("No access");
  });

  test("only moving to an escalation role asks first", () => {
    expect(needsEscalationConfirm(ROLES, "member", "workspace_admin")).toBe(true);
    expect(needsEscalationConfirm(ROLES, "workspace_admin", "workspace_admin")).toBe(false);
    expect(needsEscalationConfirm(ROLES, "member", "viewer")).toBe(false);
    expect(needsEscalationConfirm(ROLES, "custom", null)).toBe(false);
  });
});
