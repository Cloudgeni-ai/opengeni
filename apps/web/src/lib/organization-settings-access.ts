// Which organization settings pages a person can use. One rule, shared by the
// organization settings route (what it renders) and the settings rail (which
// organization pages it lists), so the rail never offers a page the route
// would refuse.
import {
  ORGANIZATION_ADMIN_SECTIONS,
  type OrganizationAdminSection,
} from "@/lib/organization-admin";
import { hasAccountPermission } from "@/lib/permissions";
import { administersOrganization } from "@/lib/workspaces";
import type { AccessContext, ClientConfig, OrganizationMembershipRole } from "@/types";

export type OrganizationSettingsAccess = {
  actorRole: OrganizationMembershipRole | null;
  /** The single local user, who administers the built-in organization. */
  singleUser: boolean;
  /** A signed-in person (Better Auth cookie), not a key or a service. */
  managedHumanSession: boolean;
  /** A session that may administer an organization: a person or the single local user. */
  organizationAdministratorSession: boolean;
  /** An owner or admin in an administrator session. */
  administrator: boolean;
  canReadBilling: boolean;
  canManageBilling: boolean;
  canManageOrganizationKnowledge: boolean;
  canManageCompanyProfileAgentPolicy: boolean;
  canManageOrganizationApiKeys: boolean;
  /** Pages this person can use. The rest are hidden. */
  visibleSections: ReadonlySet<OrganizationAdminSection>;
};

export function organizationSettingsAccess(input: {
  accessContext: AccessContext;
  clientConfig: Pick<ClientConfig, "productAccessMode"> & {
    auth: Pick<ClientConfig["auth"], "mode">;
  };
  accountId: string;
}): OrganizationSettingsAccess {
  const { accessContext, accountId } = input;
  const canManageBilling = hasAccountPermission(accessContext, accountId, "billing:manage");
  const canReadBilling =
    canManageBilling || hasAccountPermission(accessContext, accountId, "billing:read");
  const canManageOrganizationKnowledge = hasAccountPermission(
    accessContext,
    accountId,
    "account:admin",
  );
  const accountGrant =
    accessContext.accountGrants.find((grant) => grant.accountId === accountId) ?? null;
  const canManageCompanyProfileAgentPolicy = accountGrant?.role === "owner";
  const canManageOrganizationApiKeys = hasAccountPermission(
    accessContext,
    accountId,
    "api_keys:manage",
  );
  const actorRole: OrganizationMembershipRole | null =
    accountGrant?.role === "owner" ||
    accountGrant?.role === "admin" ||
    accountGrant?.role === "member"
      ? accountGrant.role
      : null;
  const singleUser = input.clientConfig.productAccessMode === "local";
  const managedHumanSession = input.clientConfig.auth.mode === "managedSession";
  const organizationAdministratorSession = managedHumanSession || singleUser;
  // The one rule the rail's picker also uses for "New workspace in <organization>".
  const administrator = administersOrganization(input);

  const visible = new Set<OrganizationAdminSection>();
  if (administrator) {
    visible.add("general");
    if (managedHumanSession && !singleUser) visible.add("people");
    visible.add("workspaces");
    visible.add("models");
    visible.add("integrations");
  }
  visible.add("identity");
  if (canReadBilling) visible.add("billing");
  if (canManageOrganizationApiKeys) visible.add("developer");
  // Recovery contacts are members, not only owners and admins: they accept
  // and approve recovery on this page, so every managed person can reach it.
  if (administrator || (managedHumanSession && !singleUser)) visible.add("security");

  return {
    actorRole,
    singleUser,
    managedHumanSession,
    organizationAdministratorSession,
    administrator,
    canReadBilling,
    canManageBilling,
    canManageOrganizationKnowledge,
    canManageCompanyProfileAgentPolicy,
    canManageOrganizationApiKeys,
    visibleSections: visible,
  };
}

/** The page a request lands on: the one asked for when visible, else the first visible page. */
export function resolveOrganizationSettingsSection(
  requested: OrganizationAdminSection | null | undefined,
  visibleSections: ReadonlySet<OrganizationAdminSection>,
): OrganizationAdminSection {
  return requested && visibleSections.has(requested)
    ? requested
    : (ORGANIZATION_ADMIN_SECTIONS.find((each) => visibleSections.has(each)) ?? "identity");
}
