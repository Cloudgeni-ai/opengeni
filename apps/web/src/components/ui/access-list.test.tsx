import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AccessList,
  groupAccessMembers,
  removeBlockedReason,
  type AccessMember,
} from "./access-list";
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

const maria: AccessMember<Role> = {
  id: "maria",
  name: "Maria Chen",
  email: "maria@acme.dev",
  initials: "MC",
  role: "member",
};
const you: AccessMember<Role> = {
  id: "bendik",
  name: "Bendik Hansen",
  email: "bendik@acme.dev",
  initials: "BH",
  isYou: true,
  isOwner: true,
  role: "workspace_admin",
};
const bot: AccessMember<Role> = {
  id: "ci",
  name: "CI bot",
  initials: "CI",
  kind: "service",
  role: "member",
};
const tom: AccessMember<Role> = {
  id: "tom",
  name: "Tom Eriksen",
  email: "tom@acme.dev",
  initials: "TE",
  role: "custom",
  resetRole: "member",
};
const priya: AccessMember<Role> = {
  id: "priya",
  name: "Priya Nair",
  email: "priya@acme.dev",
  initials: "PN",
  role: "member",
  status: "invited",
  statusLabel: "Invited · expires in 5 days",
};

describe("groupAccessMembers", () => {
  test("lists you first, then owners, then everyone else, with services apart", () => {
    const owner = { ...maria, id: "owner", name: "Olivia Owner", isOwner: true };
    const { people, services } = groupAccessMembers([maria, bot, owner, you, tom]);
    expect(people.map((member) => member.id)).toEqual(["bendik", "owner", "maria", "tom"]);
    expect(services.map((member) => member.id)).toEqual(["ci"]);
  });
});

describe("removeBlockedReason", () => {
  test("you and owners always stay listed", () => {
    expect(removeBlockedReason(you)).toBe("You can't remove yourself here.");
    expect(removeBlockedReason({ ...maria, isOwner: true })).toBe("Owners always have access.");
    expect(removeBlockedReason({ ...maria, removeLockedReason: "Managed by SCIM." })).toBe(
      "Managed by SCIM.",
    );
    expect(removeBlockedReason(maria)).toBeNull();
  });
});

describe("roles", () => {
  test("labels come from the catalog, with custom and no access spelled out", () => {
    expect(roleLabel(ROLES, "workspace_admin")).toBe("Workspace admin");
    expect(roleLabel(ROLES, "custom")).toBe("Custom (set via API)");
    expect(roleLabel(ROLES, null)).toBe("No access");
    expect(roleLabel(ROLES, null, { noAccessLabel: "None" })).toBe("None");
  });

  test("only roles marked as escalations ask first", () => {
    expect(needsEscalationConfirm(ROLES, "viewer", "workspace_admin")).toBe(true);
    expect(needsEscalationConfirm(ROLES, "custom", "workspace_admin")).toBe(true);
    expect(needsEscalationConfirm(ROLES, "workspace_admin", "workspace_admin")).toBe(false);
    expect(needsEscalationConfirm(ROLES, "workspace_admin", "viewer")).toBe(false);
    expect(needsEscalationConfirm(ROLES, "member", null)).toBe(false);
  });
});

describe("AccessList", () => {
  const render = (props: Partial<Parameters<typeof AccessList<Role>>[0]> = {}) =>
    renderToStaticMarkup(
      <AccessList
        label="People with access to Platform engineering"
        roles={ROLES}
        members={[maria, you, tom, priya, bot]}
        onRoleChange={() => undefined}
        onRemove={() => undefined}
        onResetToRole={() => undefined}
        {...props}
      />,
    );

  test("shows legacy custom grants with Reset to role, invites and the service subgroup", () => {
    const html = render();
    expect(html).toContain("Custom (set via API)");
    expect(html).toContain("Reset to Member");
    expect(html).toContain("Invited · expires in 5 days");
    expect(html).toContain("Service accounts");
    // You come first and can't change your own role.
    expect(html.indexOf("Bendik Hansen")).toBeLessThan(html.indexOf("Maria Chen"));
    expect(html).toContain("You can&#x27;t change your own role. Ask another admin.");
  });

  test("read-only lists say why and render roles as text", () => {
    const html = render({ readOnlyReason: "Only workspace admins can change access." });
    expect(html).toContain("Only workspace admins can change access.");
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain("Reset to Member");
  });

  test("loading and errors replace the rows", () => {
    expect(render({ loading: true })).toContain("Loading who has access");
    const error = render({
      error: { message: "Couldn't load who has access.", onRetry: () => undefined },
    });
    expect(error).toContain("Couldn&#x27;t load who has access.");
    expect(error).toContain("Try again");
    expect(error).not.toContain("Maria Chen");
  });

  test("the matrix shows one role per workspace, with no access spelled out", () => {
    const html = render({
      variant: "matrix",
      noAccessLabel: "No access",
      scopes: [
        { id: "design", label: "Design preview" },
        { id: "platform", label: "Platform engineering" },
      ],
      members: [{ ...maria, grants: { design: "member", platform: null } }],
    });
    expect(html).toContain("<table");
    expect(html).toContain("Design preview");
    expect(html).toContain("No access");
    expect(html).toContain("Member");
  });
});
