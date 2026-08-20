import type {
  OrganizationMember,
  OrganizationMembershipRole,
  OrganizationRetentionPolicy,
} from "@/types";

export const ORGANIZATION_ADMIN_SECTIONS = ["overview", "people", "retention", "billing"] as const;

export type OrganizationAdminSection = (typeof ORGANIZATION_ADMIN_SECTIONS)[number];
export type OrganizationAdminResource =
  | "members"
  | "admin-invitations"
  | "incoming-invitations"
  | "retention"
  | "billing"
  | "entitlements";

export type OrganizationAdminIdentity = {
  principalGeneration: number;
  subjectId: string;
  organizationId: string;
  workspaceId: string;
};

export type OrganizationAdminOperation = {
  identity: OrganizationAdminIdentity;
  resource: OrganizationAdminResource;
  sequence: number;
};

export function organizationAdminIdentityKey(identity: OrganizationAdminIdentity): string {
  return [
    identity.principalGeneration,
    identity.subjectId,
    identity.organizationId,
    identity.workspaceId,
  ].join(":");
}

export function sameOrganizationAdminIdentity(
  left: OrganizationAdminIdentity | null,
  right: OrganizationAdminIdentity,
): boolean {
  return (
    left !== null && organizationAdminIdentityKey(left) === organizationAdminIdentityKey(right)
  );
}

export function beginOrganizationAdminOperation(input: {
  identity: OrganizationAdminIdentity;
  resource: OrganizationAdminResource;
  previousSequence: number;
}): OrganizationAdminOperation {
  return {
    identity: input.identity,
    resource: input.resource,
    sequence: input.previousSequence + 1,
  };
}

export function ownsOrganizationAdminOperation(input: {
  currentIdentity: OrganizationAdminIdentity | null;
  currentOperation: OrganizationAdminOperation | null;
  accepted: OrganizationAdminOperation;
}): boolean {
  return (
    sameOrganizationAdminIdentity(input.currentIdentity, input.accepted.identity) &&
    input.currentOperation?.resource === input.accepted.resource &&
    input.currentOperation.sequence === input.accepted.sequence &&
    sameOrganizationAdminIdentity(input.currentOperation.identity, input.accepted.identity)
  );
}

/** Stable, non-reversible display identity until the API exposes safe profile data. */
export function maskedOrganizationSubject(subjectId: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(subjectId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `Member • ${hash.toString(16).padStart(8, "0").toUpperCase()}`;
}

export type OrganizationMemberCapabilities = {
  canChangeRole: boolean;
  allowedRoles: OrganizationMembershipRole[];
  canSuspend: boolean;
  canReactivate: boolean;
  canOffboard: boolean;
};

/** Mirrors migration 0263's owner/admin/member transition authority. */
export function organizationMemberCapabilities(
  actorRole: OrganizationMembershipRole | null,
  target: Pick<OrganizationMember, "role" | "status">,
): OrganizationMemberCapabilities {
  if (!actorRole || actorRole === "member" || target.status === "revoked") {
    return {
      canChangeRole: false,
      allowedRoles: [],
      canSuspend: false,
      canReactivate: false,
      canOffboard: false,
    };
  }
  const actorMayManageTarget = actorRole === "owner" || target.role === "member";
  if (!actorMayManageTarget) {
    return {
      canChangeRole: false,
      allowedRoles: [],
      canSuspend: false,
      canReactivate: false,
      canOffboard: false,
    };
  }
  return {
    canChangeRole: target.status === "active",
    allowedRoles: actorRole === "owner" ? ["owner", "admin", "member"] : ["member"],
    canSuspend: target.status === "active",
    canReactivate: target.status === "suspended",
    canOffboard: target.status === "active" || target.status === "suspended",
  };
}

export function canInviteOrganizationRole(
  actorRole: OrganizationMembershipRole | null,
  invitedRole: OrganizationMembershipRole,
): boolean {
  return actorRole === "owner" || (actorRole === "admin" && invitedRole === "member");
}

export function validRetentionDays(value: number): boolean {
  return Number.isInteger(value) && value >= 30 && value <= 90;
}

export function retentionPolicySummary(
  policy: Pick<OrganizationRetentionPolicy, "mode" | "retentionDays">,
): string {
  return policy.mode === "retain"
    ? "Retain offboarded members' personal data indefinitely."
    : `Make offboarded members' personal data eligible for operator cleanup after ${policy.retentionDays} days.`;
}

export function isOrganizationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 409
  );
}
