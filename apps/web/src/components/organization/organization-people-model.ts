import type { RoleOption, RoleValue } from "@/components/ui/role-select";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembershipRole,
  OrganizationWorkspaceAccessMember,
} from "@/types";

import type { WorkspaceRoleId } from "./organization-directory";

/* ----------------------------------------------------------------------------
   Names, roles and statuses for the People and Workspaces pages, in product
   words. Workspace roles come from the server's role catalog; organization
   roles are fixed by the membership model (migration 0263).
   -------------------------------------------------------------------------- */

export const ORGANIZATION_ROLE_LABELS: Record<OrganizationMembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const ORGANIZATION_ROLE_DESCRIPTIONS: Record<OrganizationMembershipRole, string> = {
  owner: "Everything, including billing, API keys, organization identity and recovery.",
  admin: "Manages people, workspaces, models and integrations. Can't buy credits.",
  member: "No organization settings. Works in the workspaces they're given.",
};

/** Least to most access, for RoleSelect and the invite choice cards. */
export function organizationRoleOptions(
  allowed?: readonly OrganizationMembershipRole[],
  lockedReason = "Only owners can make someone an owner or admin.",
): RoleOption<OrganizationMembershipRole>[] {
  return (["member", "admin", "owner"] as const).map((role) => ({
    id: role,
    label: ORGANIZATION_ROLE_LABELS[role],
    description: ORGANIZATION_ROLE_DESCRIPTIONS[role],
    escalation:
      role === "owner"
        ? "They'll get full control of the organization, including billing and recovery."
        : role === "admin"
          ? "They'll be able to manage people, workspaces, models and integrations."
          : undefined,
    disabledReason: allowed && !allowed.includes(role) ? lockedReason : undefined,
  }));
}

/** The workspace roles from the server's catalog. */
export function workspaceRoleOptions(
  overview: OrganizationAdministrationOverview | null,
): RoleOption<WorkspaceRoleId>[] {
  return (overview?.roles ?? []).map((role) => ({
    id: role.role,
    label: role.label,
    description: role.description,
  }));
}

export function workspaceRoleLabel(
  roles: readonly RoleOption<WorkspaceRoleId>[],
  role: RoleValue<WorkspaceRoleId>,
): string {
  if (role === null) return "No access";
  if (role === "custom") return "Custom (set via API)";
  return roles.find((option) => option.id === role)?.label ?? "Member";
}

export function withArticle(label: string): string {
  const lower = label.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
}

export function memberName(member: Pick<OrganizationMember, "name" | "email">): string {
  return member.name?.trim() || member.email || "Unnamed person";
}

export function firstName(name: string): string {
  if (name.includes("@")) return name;
  return name.split(/\s+/)[0] || name;
}

export function initialsOf(name: string): string {
  const source = name.includes("@") ? name.split("@")[0]!.replace(/[._-]+/g, " ") : name;
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts.at(-1)![0]!;
  return letters.toUpperCase();
}

/** A workspace member's name; `you` names the signed-in person when the server has no name. */
export function workspaceMemberName(
  member: OrganizationWorkspaceAccessMember,
  you?: { subjectId: string; label: string | null | undefined },
): string {
  const known = member.name ?? member.email ?? member.subjectLabel;
  if (known) return known;
  if (you && member.subjectId === you.subjectId && you.label) return you.label;
  return member.principalKind === "service" ? "Service account" : "Unnamed person";
}

/** "Suspended", "Joining", or null when active. */
export function memberStatusLabel(member: Pick<OrganizationMember, "status">): string | null {
  if (member.status === "suspended") return "Suspended";
  if (member.status === "provisioning") return "Joining";
  if (member.status === "revoked") return "Removed";
  return null;
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Days until the invitation expires, as words. */
export function expiresLabel(expiresAt: string, now = Date.now()): string {
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "expired";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export type InvitationState = "sent" | "sending" | "failed" | "unknown" | "not-sent";

export function invitationState(invitation: OrganizationInvitation): InvitationState {
  switch (invitation.delivery?.state) {
    case "sent":
      return "sent";
    case "pending":
      return "sending";
    case "failed":
      return "failed";
    case "outcome_unknown":
      return "unknown";
    default:
      return "not-sent";
  }
}

/** One status line for an invitation row: "Invited · expires in 5 days". */
export function invitationStatusLabel(invitation: OrganizationInvitation): string {
  const state = invitationState(invitation);
  if (state === "failed") return "Invitation email failed";
  if (state === "unknown") return "Email may not have been sent";
  if (state === "not-sent") return "Invitation not sent yet";
  if (state === "sending") return "Sending invitation";
  return `Invited · ${expiresLabel(invitation.expiresAt)}`;
}

/** Whether Resend can run now (a failed or unsent email, never a possible duplicate). */
export function canResendInvitation(invitation: OrganizationInvitation): boolean {
  return (
    invitation.status === "pending" &&
    (!invitation.delivery || invitation.delivery.retryState === "available")
  );
}

/** A delivery outcome for a toast. */
export function invitationDeliveryOutcome(invitation: OrganizationInvitation): string {
  switch (invitation.delivery?.state) {
    case "sent":
      return `Sent an invitation to ${invitation.targetEmail}.`;
    case "failed":
      return `The email to ${invitation.targetEmail} failed. Resend it from their row.`;
    case "outcome_unknown":
      return invitation.delivery.retryState === "reconciliation_required"
        ? `We can't tell whether the email to ${invitation.targetEmail} was sent. Don't resend yet.`
        : `We can't tell whether the email to ${invitation.targetEmail} was sent. Resending is safe.`;
    case "pending":
      return `Sending the invitation to ${invitation.targetEmail}.`;
    default:
      return `Saved the invitation to ${invitation.targetEmail}. The email hasn't gone out yet.`;
  }
}
