// Pure organization and workspace selection rules shared by the web rail's
// switcher and native renderers. The wire model has no account *name*, so a
// display label is derived from the access grant — preferring the account
// name, falling back to a short, stable id fragment. No DOM, no React.
import type { AccessContext, AccountGrant, Workspace } from "@opengeni/sdk";
import { type OpenGeniText } from "./messages/runtime";

export type OrgOption = {
  accountId: string;
  label: string;
  /** Whether the subject has the owner/admin authority required by organization settings. */
  canManage: boolean;
};

/** Organizations the subject administers (owner or admin), sorted by id. */
export function organizationAdministrationAccountIds(accessContext: AccessContext): string[] {
  return accessContext.accountGrants
    .filter(
      (grant) =>
        grant.subjectId === accessContext.subjectId &&
        (grant.role === "owner" || grant.role === "admin"),
    )
    .map((grant) => grant.accountId)
    .sort();
}

/** A short, stable id fragment for an account that has no human name. */
export function shortAccountId(accountId: string): string {
  return accountId.length > 8 ? accountId.slice(0, 8) : accountId;
}

/** The organization's real name, or null when the API sent none. */
export function orgName(accountId: string, grants: AccountGrant[]): string | null {
  const grant = grants.find((candidate) => candidate.accountId === accountId);
  const label =
    grant?.metadata && typeof grant.metadata.accountName === "string"
      ? grant.metadata.accountName
      : undefined;
  return label?.trim() || null;
}

/** Human label for an organization: the grant's subjectLabel, else a short id. */
export function orgLabel(t: OpenGeniText, accountId: string, grants: AccountGrant[]): string {
  return (
    orgName(accountId, grants) ??
    t("organizationModel.orgShortaccountid", { shortAccountId: shortAccountId(accountId) })
  );
}

/**
 * The organizations the subject belongs to, in a stable order (default org
 * first, then by name). Derived from account grants, unioned with the accounts
 * that own the accessible workspaces so an org always shows even without an
 * explicit grant.
 */
export function organizationsForSubject(
  t: OpenGeniText,
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
  const options = [...ids].map((accountId) => ({
    accountId,
    label: orgLabel(t, accountId, context.accountGrants),
    canManage: administeredIds.has(accountId),
  }));
  return options.sort((a, b) => {
    if (a.accountId === context.defaultAccountId) {
      return -1;
    }
    if (b.accountId === context.defaultAccountId) {
      return 1;
    }
    return a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId);
  });
}

/** Workspaces that belong to a given organization, ordered by name. */
export function workspacesInOrg(workspaces: Workspace[], accountId: string): Workspace[] {
  return workspaces
    .filter((workspace) => workspace.accountId === accountId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type OrgWorkspaces = { org: OrgOption; workspaces: Workspace[] };

/**
 * Every workspace open to the person, grouped by organization in the
 * switcher's order: organizations as `organizationsForSubject` orders them,
 * each one's workspaces by name. The workspace picker lists them this way and
 * the previous and next workspace keys walk them in the same order.
 */
export function workspacesByOrganization(
  t: OpenGeniText,
  context: AccessContext,
  workspaces: Workspace[],
): OrgWorkspaces[] {
  return organizationsForSubject(t, context, workspaces)
    .map((org) => ({ org, workspaces: workspacesInOrg(workspaces, org.accountId) }))
    .filter((group) => group.workspaces.length > 0);
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

/**
 * Where switching to an organization lands: the workspace last used there
 * while it is still open to the person, else its first shared workspace, else
 * their Personal workspace there. Null when nothing in it is open to them.
 */
export function organizationLandingWorkspaceId(
  workspaces: Workspace[],
  accountId: string,
  rememberedWorkspaceId?: string | null,
): string | null {
  const candidates = workspacesInOrg(workspaces, accountId);
  return (
    candidates.find((workspace) => workspace.id === rememberedWorkspaceId)?.id ??
    candidates.find((workspace) => workspace.kind !== "personal")?.id ??
    candidates[0]?.id ??
    null
  );
}
