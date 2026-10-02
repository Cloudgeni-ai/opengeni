// Settings > Access for an organization administrator who manages a shared
// workspace without having access to it. Same AccessList rows and verbs as the
// workspace's own Access page; roles come from the server's catalog.
import { Link } from "@tanstack/react-router";
import { UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { OrganizationWorkspaceAdministration } from "@/components/settings/organization-workspace-administration";
import { SettingsHeaderActions } from "@/components/settings/settings-header-actions";
import { AccessList, type AccessMember } from "@/components/ui/access-list";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import type { RoleOption } from "@/components/ui/role-select";
import { Section } from "@/components/ui/section";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import type { OrganizationMember, OrganizationWorkspaceAccessMember } from "@/types";

import {
  AddPeoplePage,
  asRole,
  FLUSH_ACCESS_LIST,
  initialsOf,
  type AccessView,
} from "./workspace-members-section";

type ManagedRole = "viewer" | "member" | "admin";

const ADMIN_ESCALATION =
  "They'll be able to change this workspace's settings, integrations and who has access.";

function managedWorkspaceMemberLabel(member: OrganizationWorkspaceAccessMember): string {
  return member.name ?? member.email ?? member.subjectLabel ?? "Workspace member";
}

export function OrganizationManagedWorkspaceAccess({
  administration,
  view: controlledView,
  onViewChange,
}: {
  administration: OrganizationWorkspaceAdministration;
  view?: AccessView;
  onViewChange?: (view: AccessView) => void;
}) {
  const context = useAppContext();
  const { organizationId, overview, workspace, refresh } = administration;
  const organizationName = overview.organization.name;
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [membersError, setMembersError] = useState<Error | null>(null);
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const [removing, setRemoving] = useState<OrganizationWorkspaceAccessMember | null>(null);
  const [localView, setLocalView] = useState<AccessView>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const view = controlledView !== undefined ? controlledView : localView;
  const setView = (next: AccessView) => {
    if (onViewChange) onViewChange(next);
    else setLocalView(next);
  };

  // The server's role catalog, least to most access.
  const roles: RoleOption<ManagedRole>[] = overview.roles.map((role) => ({
    id: role.role,
    label: role.label,
    description: role.description,
    escalation: role.role === "admin" ? ADMIN_ESCALATION : undefined,
  }));
  const roleLabelOf = (role: ManagedRole) =>
    roles.find((candidate) => candidate.id === role)?.label ?? role;

  useEffect(() => {
    let disposed = false;
    setMembers(null);
    setMembersError(null);
    void context.client
      .listOrganizationAdministrationMembers(organizationId)
      .then((response) => {
        if (!disposed) setMembers(response.members.filter((member) => member.status === "active"));
      })
      .catch((error) => {
        if (!disposed) {
          setMembers([]);
          setMembersError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    return () => {
      disposed = true;
    };
  }, [context.client, organizationId, overview, loadRevision]);

  const assignedSubjects = new Set(workspace.members.map((member) => member.subjectId));
  const candidates = members?.filter((member) => !assignedSubjects.has(member.subjectId)) ?? null;

  async function addMembers(ids: string[], role: ManagedRole) {
    const added: string[] = [];
    try {
      for (const id of ids) {
        await context.client.putOrganizationWorkspaceMember(organizationId, workspace.id, id, {
          role,
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        });
        const member = members?.find((candidate) => candidate.id === id);
        added.push(member?.name ?? member?.email ?? "Organization member");
      }
    } catch (caught) {
      if (added.length > 0) refresh();
      const reason = userErrorText(caught);
      throw new Error(
        added.length > 0
          ? `Added ${added.join(", ")}, but couldn't add the rest. ${reason}`
          : `Couldn't add them. ${reason}`,
        { cause: caught },
      );
    }
    toast.success(added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} people`, {
      description: `As ${asRole(roleLabelOf(role))} in ${workspace.name}.`,
    });
    await context.revalidatePrincipalAccess();
    refresh();
  }

  async function setMemberRole(member: OrganizationWorkspaceAccessMember, role: ManagedRole) {
    if (!member.organizationMembershipId) return;
    setSavingIds((ids) => [...ids, member.membershipId]);
    try {
      await context.client.putOrganizationWorkspaceMember(
        organizationId,
        workspace.id,
        member.organizationMembershipId,
        {
          role,
          expectedUpdatedAt: member.updatedAt,
          operationId: crypto.randomUUID(),
        },
      );
      toast.success(`${managedWorkspaceMemberLabel(member)} is now ${asRole(roleLabelOf(role))}`);
      await context.revalidatePrincipalAccess();
      refresh();
    } catch (error) {
      toast.error(`Couldn't change ${managedWorkspaceMemberLabel(member)}'s role`, {
        description: userErrorText(error),
      });
    } finally {
      setSavingIds((ids) => ids.filter((id) => id !== member.membershipId));
    }
  }

  async function removeMember(): Promise<boolean> {
    if (!removing?.organizationMembershipId) return false;
    try {
      await context.client.revokeOrganizationWorkspaceMember(
        organizationId,
        workspace.id,
        removing.organizationMembershipId,
        {
          expectedUpdatedAt: removing.updatedAt,
          operationId: crypto.randomUUID(),
        },
      );
    } catch (error) {
      throw new Error(
        `Couldn't remove ${managedWorkspaceMemberLabel(removing)}. ${userErrorText(error)}`,
        { cause: error },
      );
    }
    toast.success(`Removed ${managedWorkspaceMemberLabel(removing)} from ${workspace.name}`);
    setRemoving(null);
    await context.revalidatePrincipalAccess();
    refresh();
    return true;
  }

  const peopleLink = (
    <Link
      to="/workspaces/$workspaceId/organization"
      params={{ workspaceId: workspace.id }}
      search={{ section: "people" }}
      className="rounded-sm font-medium text-brand underline-offset-2 hover:underline"
    >
      Invite people
    </Link>
  );

  if (view?.kind === "add") {
    return (
      <AddPeoplePage
        workspaceName={workspace.name}
        organizationName={organizationName}
        candidates={
          candidates?.map((member) => {
            const name = member.name ?? member.email ?? "Organization member";
            const orgRole =
              member.role === "owner"
                ? "Organization owner"
                : member.role === "admin"
                  ? "Organization admin"
                  : null;
            return {
              id: member.id,
              name,
              description: [member.email !== name ? member.email : null, orgRole]
                .filter(Boolean)
                .join(" · "),
              searchText: [member.name, member.email].filter(Boolean).join(" ").toLowerCase(),
            };
          }) ?? null
        }
        loadError={membersError}
        onRetry={() => setLoadRevision((revision) => revision + 1)}
        roles={roles}
        inviteLink={peopleLink}
        onSubmit={addMembers}
        onClose={() => setView(null)}
      />
    );
  }

  const selfSubjectId = context.accessContext.subjectId;
  const accessMembers: AccessMember<ManagedRole>[] = workspace.members.map((member) => {
    const name = managedWorkspaceMemberLabel(member);
    const editable = Boolean(member.organizationMembershipId) && member.principalKind === "human";
    return {
      id: member.membershipId,
      name,
      email: member.email && member.email !== name ? member.email : null,
      initials: initialsOf(name),
      kind: member.principalKind === "service" ? "service" : "person",
      isYou: member.subjectId === selfSubjectId,
      tag: member.organizationRole === "owner" ? "Organization owner" : undefined,
      role: member.role,
      roleLockedReason: editable ? undefined : "Service accounts keep the role they were given.",
      removeLockedReason: member.organizationMembershipId
        ? undefined
        : "Service accounts are removed from the organization, not from here.",
    };
  });
  const byId = (entry: AccessMember<ManagedRole>) =>
    workspace.members.find((member) => member.membershipId === entry.id);

  return (
    <>
      <SettingsHeaderActions>
        <Button type="button" onClick={() => setView({ kind: "add" })}>
          <UserPlusIcon aria-hidden="true" />
          Add people
        </Button>
      </SettingsHeaderActions>
      <Section
        title="People"
        description={
          <>
            People come from {organizationName}. To invite someone new, go to{" "}
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId: workspace.id }}
              search={{ section: "people" }}
              className="rounded-sm font-medium text-brand underline-offset-2 hover:underline"
            >
              Organization {">"} People
            </Link>
            .
          </>
        }
      >
        <AccessList
          label={`People with access to ${workspace.name}`}
          roles={roles}
          members={accessMembers}
          className={FLUSH_ACCESS_LIST}
          savingIds={savingIds}
          onRoleChange={(entry, role) => {
            const member = byId(entry);
            if (!member || !role) return;
            return setMemberRole(member, role);
          }}
          onRemove={(entry) => setRemoving(byId(entry) ?? null)}
        />
        {accessMembers.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No one has access yet. Add people from {organizationName}.
          </p>
        ) : null}
      </Section>

      <DestructiveConfirm
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={
          removing
            ? `Remove ${managedWorkspaceMemberLabel(removing)} from ${workspace.name}?`
            : "Remove from workspace?"
        }
        consequences={[
          `They lose access to ${workspace.name} right away.`,
          `They stay in ${organizationName}, with their Personal workspace unchanged.`,
        ]}
        confirmLabel="Remove from workspace"
        pendingLabel="Removing…"
        onConfirm={removeMember}
      />
    </>
  );
}
