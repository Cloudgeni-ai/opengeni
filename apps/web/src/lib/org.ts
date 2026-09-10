import { organizationAdministrationAccountIds } from "@/lib/permissions";
// Organization (the tenant formerly surfaced as "account") helpers for the
// rail's org switcher. The wire model has no account *name*, so a display
// label is derived from the access grant — preferring a human subjectLabel,
// falling back to a short, stable id fragment.
import type { AccessContext, AccountGrant, Workspace } from "@/types";

export type OrgOption = {
  accountId: string;
  label: string;
  /** Whether the subject has the owner/admin authority required by organization settings. */
  canManage: boolean;
};

/** A short, stable id fragment for an account that has no human name. */
export function shortAccountId(accountId: string): string {
  return accountId.length > 8 ? accountId.slice(0, 8) : accountId;
}

/** Human label for an organization: the grant's subjectLabel, else a short id. */
export function orgLabel(accountId: string, grants: AccountGrant[]): string {
  const grant = grants.find((candidate) => candidate.accountId === accountId);
  const label =
    grant?.metadata && typeof grant.metadata.accountName === "string"
      ? grant.metadata.accountName
      : undefined;
  return label?.trim() || `Org ${shortAccountId(accountId)}`;
}

/**
 * The organizations the subject belongs to, in a stable order (default org
 * first). Derived from account grants, unioned with the accounts that own the
 * accessible workspaces so an org always shows even without an explicit grant.
 */
export function organizationsForSubject(
  context: AccessContext,
  workspaces: Workspace[],
): OrgOption[] {
  const administeredIds = new Set(organizationAdministrationAccountIds(context));
  const ids = new Set<string>();
  for (const grant of context.accountGrants) {
    ids.add(grant.accountId);
  }
  for (const workspace of workspaces) {
    ids.add(workspace.accountId);
  }
  const ordered = [...ids].sort((a, b) => {
    if (a === context.defaultAccountId) {
      return -1;
    }
    if (b === context.defaultAccountId) {
      return 1;
    }
    return a.localeCompare(b);
  });
  return ordered.map((accountId) => ({
    accountId,
    label: orgLabel(accountId, context.accountGrants),
    canManage: administeredIds.has(accountId),
  }));
}

/** Workspaces that belong to a given organization, ordered by name. */
export function workspacesInOrg(workspaces: Workspace[], accountId: string): Workspace[] {
  return workspaces
    .filter((workspace) => workspace.accountId === accountId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Organization settings remain anchored to an accessible workspace in that organization. */
export function organizationSettingsWorkspaceId(
  workspaces: Workspace[],
  accountId: string,
  activeWorkspaceId: string,
): string | null {
  const candidates = workspacesInOrg(workspaces, accountId);
  return (
    candidates.find((workspace) => workspace.id === activeWorkspaceId)?.id ??
    candidates[0]?.id ??
    null
  );
}
