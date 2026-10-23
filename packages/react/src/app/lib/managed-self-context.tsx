import type { ManagedOrganizationMembership, Workspace } from "../types";

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
 * Additional organization creation is available only after the exact current
 * managed identity is verified and its server-issued membership projection
 * proves that initial onboarding has completed.
 */
export function canCreateAdditionalOrganization(input: {
  managedUserId: string | null;
  emailVerified: boolean;
  selfContext: ManagedSelfContext | null;
}): boolean {
  const { managedUserId, selfContext } = input;
  if (!managedUserId || !input.emailVerified || !selfContext) return false;
  return (
    selfContext.identity.managedUserId === managedUserId &&
    selfContext.identity.subjectId === `user:${managedUserId}` &&
    selfContext.memberships.some((membership) => membership.status === "active")
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
        membership.status === "active" &&
        membership.organizationId === workspace.accountId &&
        membership.personalWorkspaceId === workspace.id,
    ) ?? null
  );
}

export function isPersonalWorkspace(
  workspace: Pick<Workspace, "id" | "accountId" | "kind"> | null,
  _selfContext: ManagedSelfContext | null,
): boolean {
  return workspace?.kind === "personal";
}

/**
 * Personal workspaces the person's organization turned off. They still exist,
 * anchor the person's own machines, browsers and vaults, and keep their
 * existing chats reachable by link, but nobody browses to or lands in them.
 */
export function hiddenPersonalWorkspaceIds(
  selfContext: ManagedSelfContext | null,
): ReadonlySet<string> {
  return new Set(
    (selfContext?.memberships ?? [])
      .filter(
        (membership) =>
          membership.status === "active" && membership.personalWorkspacesEnabled === false,
      )
      .map((membership) => membership.personalWorkspaceId),
  );
}

/**
 * The workspaces to offer in pickers and landing: every workspace except a
 * hidden Personal one, unless it is the workspace the person is already in.
 */
export function navigableWorkspaces<T extends Pick<Workspace, "id">>(
  workspaces: readonly T[],
  selfContext: ManagedSelfContext | null,
  currentWorkspaceId?: string | null,
): T[] {
  const hidden = hiddenPersonalWorkspaceIds(selfContext);
  if (hidden.size === 0) return [...workspaces];
  return workspaces.filter(
    (workspace) => workspace.id === currentWorkspaceId || !hidden.has(workspace.id),
  );
}
