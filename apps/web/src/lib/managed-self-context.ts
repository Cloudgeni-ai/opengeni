import type { ManagedOrganizationMembership, Workspace } from "@/types";

export type ManagedSelfContextIdentity = {
  credentialGeneration: number;
  managedUserId: string;
  subjectId: string;
};

export type ManagedSelfContext = {
  identity: ManagedSelfContextIdentity;
  memberships: ManagedOrganizationMembership[];
};

export function managedSelfContextIdentity(input: {
  credentialGeneration: number;
  managedUserId: string;
}): ManagedSelfContextIdentity {
  return {
    ...input,
    subjectId: `user:${input.managedUserId}`,
  };
}

export function sameManagedSelfContextIdentity(
  left: ManagedSelfContextIdentity | null,
  right: ManagedSelfContextIdentity,
): boolean {
  return (
    left?.credentialGeneration === right.credentialGeneration &&
    left.managedUserId === right.managedUserId &&
    left.subjectId === right.subjectId
  );
}

/**
 * Resolve managed-human membership facts only for the credential/principal
 * identity that started the request. A late response from a replaced cookie
 * session is discarded instead of becoming the next principal's UI truth.
 */
export async function loadCurrentManagedSelfContext(input: {
  identity: ManagedSelfContextIdentity;
  currentIdentity: () => ManagedSelfContextIdentity | null;
  request: () => Promise<{ memberships: ManagedOrganizationMembership[] }>;
}): Promise<ManagedSelfContext | null> {
  try {
    const response = await input.request();
    return sameManagedSelfContextIdentity(input.currentIdentity(), input.identity)
      ? { identity: input.identity, memberships: response.memberships }
      : null;
  } catch (error) {
    if (!sameManagedSelfContextIdentity(input.currentIdentity(), input.identity)) {
      return null;
    }
    throw error;
  }
}

/**
 * Personal-workspace identity is a server-issued tuple. Never infer it from a
 * workspace name, default selection, permissions, creator, or account role.
 */
export function personalWorkspaceMembership(
  workspace: Pick<Workspace, "id" | "accountId"> | null,
  selfContext: ManagedSelfContext | null,
): ManagedOrganizationMembership | null {
  if (!workspace || !selfContext) return null;
  return (
    selfContext.memberships.find(
      (membership) =>
        membership.organizationId === workspace.accountId &&
        membership.personalWorkspaceId === workspace.id,
    ) ?? null
  );
}

export function isPersonalWorkspace(
  workspace: Pick<Workspace, "id" | "accountId"> | null,
  selfContext: ManagedSelfContext | null,
): boolean {
  return personalWorkspaceMembership(workspace, selfContext) !== null;
}
