import type { RoleOption, RoleValue } from "@/components/ui/role-select";

import {
  organization,
  organizationRoles,
  people as fixturePeople,
  platformEngineeringAccess,
  workspaceRoles,
  workspaces as fixtureWorkspaces,
  type OrganizationRole,
  type Person,
  type Workspace,
  type WorkspaceRole,
} from "../../fixtures";

/* ----------------------------------------------------------------------------
   Organization page state, from the shared fixtures (brief section 8). One
   extra workspace, Hardware lab, is one you have no access to, so the
   Workspaces table can show "No access · Join" (Q38).
   -------------------------------------------------------------------------- */

export const HARDWARE_LAB: Workspace = {
  id: "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a",
  name: "Hardware lab",
  kind: "shared",
  typeLabel: `Shared · ${organization.name}`,
  description: "Firmware builds and test rigs for the warehouse robots.",
  createdLabel: "Created 8 Jul 2026",
  peopleCount: 2,
};

export interface OrgWorkspace extends Workspace {
  createdAt: string;
}

const CREATED_AT: Record<string, string> = {
  "Design preview": "2026-03-14T09:00:00Z",
  "Platform engineering": "2026-02-02T09:00:00Z",
  "Customer success": "2026-04-21T09:00:00Z",
  "Finance ops": "2026-06-05T09:00:00Z",
  "Hardware lab": "2026-07-08T09:00:00Z",
};

export function initialWorkspaces(): OrgWorkspace[] {
  return [...fixtureWorkspaces, HARDWARE_LAB].map((workspace) => ({
    ...workspace,
    createdAt: CREATED_AT[workspace.name] ?? "2026-02-02T09:00:00Z",
  }));
}

export type Grant = WorkspaceRole | "custom";

export interface OrgPerson extends Omit<Person, "workspaceAccess"> {
  /** Role per shared workspace id. Missing means no access. */
  grants: Record<string, Grant>;
  /** Where a pending invitation will give access. */
  invitedLabel?: string;
}

export function initialPeople(): OrgPerson[] {
  const tomCustom = platformEngineeringAccess.find((entry) => entry.personId === "person-tom");
  const platform = fixtureWorkspaces.find(
    (workspace) => workspace.name === "Platform engineering",
  )!;
  return fixturePeople.map((person) => {
    const grants: Record<string, Grant> = {};
    for (const grant of person.workspaceAccess) grants[grant.workspaceId] = grant.role;
    if (person.id === "person-maria") grants[HARDWARE_LAB.id] = "workspace_admin";
    if (person.id === "person-jonas") grants[HARDWARE_LAB.id] = "member";
    // A legacy grant set through the API (brief fixtures).
    if (person.id === "person-tom" && tomCustom) grants[platform.id] = "custom";
    const { workspaceAccess: _drop, ...rest } = person;
    return { ...rest, grants };
  });
}

/** Someone removed earlier, for the re-invite question (Q37). */
export const REMOVED_PERSON = {
  name: "Lena Holm",
  email: "lena@acme.dev",
  removedLabel: "3 Aug",
};

/* ----------------------------------------------------------------------------
   Roles, from the server's catalog fixture. Escalations ask first.
   -------------------------------------------------------------------------- */

export function organizationRoleOptions(adminLabel: string): RoleOption<OrganizationRole>[] {
  return organizationRoles.map((role) => ({
    ...role,
    label: role.id === "admin" ? adminLabel : role.label,
    escalation:
      role.id === "owner"
        ? `Owners have full control of ${organization.name}, including billing and recovery. Only another owner can undo this.`
        : role.id === "admin"
          ? `Admins manage people, workspaces and shared connections across ${organization.name}.`
          : undefined,
  }));
}

export const WORKSPACE_ROLE_OPTIONS: RoleOption<WorkspaceRole>[] = workspaceRoles.map((role) => ({
  ...role,
  escalation:
    role.id === "workspace_admin"
      ? "They'll be able to change this workspace's settings, integrations and who has access."
      : undefined,
}));

export function workspaceRoleLabel(role: RoleValue<WorkspaceRole>): string {
  if (role === null) return "No access";
  if (role === "custom") return "Custom (set via API)";
  return workspaceRoles.find((each) => each.id === role)?.label ?? role;
}

/** "a member", "an admin": roles read as nouns inside sentences. */
export function withArticle(label: string): string {
  const lower = label.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
}

export function firstName(person: { name: string }): string {
  return person.name.split(" ")[0] ?? person.name;
}

/** "Design preview, Platform engineering and Customer success". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** The local single-user owner (Q40). */
export const LOCAL_USER: OrgPerson = {
  id: "person-local",
  name: "Local dev",
  email: "dev@localhost",
  initials: "LD",
  kind: "person",
  organizationRole: "owner",
  status: "active",
  isYou: true,
  isOnlyOwner: true,
  joinedLabel: "This computer",
  grants: {},
};
