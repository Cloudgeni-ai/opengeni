// Organization (the tenant formerly surfaced as "account") helpers for the
// rail's org switcher. The wire model has no account *name*, so a display
// label is derived from the access grant — preferring a human subjectLabel,
// falling back to a short, stable id fragment.
import { hasAccountPermission } from "@/lib/permissions";
import type { AccessContext, AccountGrant, Workspace } from "@/types";

export type OrgOption = {
  accountId: string;
  label: string;
  /** Whether the subject can open this org's settings (read billing/members). */
  canManage: boolean;
};

/** A short, stable id fragment for an account that has no human name. */
export function shortAccountId(accountId: string): string {
  return accountId.length > 8 ? accountId.slice(0, 8) : accountId;
}

/** Human label for an organization: the grant's subjectLabel, else a short id. */
export function orgLabel(accountId: string, grants: AccountGrant[]): string {
  const grant = grants.find((candidate) => candidate.accountId === accountId);
  const label = grant?.metadata && typeof grant.metadata.accountName === "string"
    ? grant.metadata.accountName
    : undefined;
  return label?.trim() || `Org ${shortAccountId(accountId)}`;
}

/**
 * The organizations the subject belongs to, in a stable order (default org
 * first). Derived from account grants, unioned with the accounts that own the
 * accessible workspaces so an org always shows even without an explicit grant.
 */
export function organizationsForSubject(context: AccessContext, workspaces: Workspace[]): OrgOption[] {
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
    canManage: hasAccountPermission(context, accountId, "billing:read")
      || hasAccountPermission(context, accountId, "account:read"),
  }));
}

/** Workspaces that belong to a given organization, ordered by name. */
export function workspacesInOrg(workspaces: Workspace[], accountId: string): Workspace[] {
  return workspaces
    .filter((workspace) => workspace.accountId === accountId)
    .sort((a, b) => a.name.localeCompare(b.name));
}
