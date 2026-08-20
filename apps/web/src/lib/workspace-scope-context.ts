import type { AccessContext, Workspace } from "@/types";

import { personalWorkspaceMembership, type ManagedSelfContext } from "./managed-self-context";
import { orgLabel } from "./org";

export type WorkspaceScopeContext = {
  organizationId: string;
  organizationLabel: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceKind: "personal" | "shared";
  personalWorkspaceId: string | null;
};

/**
 * Build display context only from the exact server-issued workspace grant and,
 * for Personal facts, the current managed principal's organization membership.
 * Names, permissions, defaults, and creator fields are never treated as scope
 * authority.
 */
export function resolveWorkspaceScopeContext(input: {
  workspace: Workspace | null;
  workspaces: readonly Workspace[];
  accessContext: AccessContext;
  managedSelfContext: ManagedSelfContext | null;
}): WorkspaceScopeContext | null {
  const { accessContext, managedSelfContext, workspace, workspaces } = input;
  if (!workspace) return null;

  const workspaceGrant = accessContext.workspaceGrants.find(
    (grant) =>
      grant.workspaceId === workspace.id &&
      grant.accountId === workspace.accountId &&
      grant.subjectId === accessContext.subjectId,
  );
  if (!workspaceGrant) return null;

  const currentManagedContext =
    managedSelfContext?.identity.subjectId === accessContext.subjectId ? managedSelfContext : null;
  const organizationMembership =
    currentManagedContext?.memberships.find(
      (membership) =>
        membership.organizationId === workspace.accountId && membership.status === "active",
    ) ?? null;
  const exactPersonalWorkspace = organizationMembership?.personalWorkspaceId
    ? (workspaces.find(
        (candidate) =>
          candidate.id === organizationMembership.personalWorkspaceId &&
          candidate.accountId === workspace.accountId &&
          accessContext.workspaceGrants.some(
            (grant) =>
              grant.workspaceId === candidate.id &&
              grant.accountId === candidate.accountId &&
              grant.subjectId === accessContext.subjectId,
          ),
      ) ?? null)
    : null;

  return {
    organizationId: workspace.accountId,
    organizationLabel: orgLabel(workspace.accountId, accessContext.accountGrants),
    workspaceId: workspace.id,
    workspaceLabel: workspace.name,
    workspaceKind:
      personalWorkspaceMembership(workspace, currentManagedContext) !== null
        ? "personal"
        : "shared",
    personalWorkspaceId: exactPersonalWorkspace?.id ?? null,
  };
}
