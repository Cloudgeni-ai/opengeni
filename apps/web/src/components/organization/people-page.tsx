import {
  CalendarIcon,
  LockIcon,
  MailIcon,
  PauseIcon,
  PlayIcon,
  UserMinusIcon,
  UserRoundIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { ModelsFormPage } from "@/components/models/models-ui";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@/components/ui/detail-sheet";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmailChipsInput, type EmailChip } from "@/components/ui/email-chips-input";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField, Field, FieldStack } from "@/components/ui/field";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { RoleSelect } from "@/components/ui/role-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Toolbar, ToolbarGroup, ToolbarSearch, ToolbarSummary } from "@/components/ui/toolbar";
import {
  canInviteOrganizationRole,
  canRevokeOrganizationInvitation,
  organizationMemberCapabilities,
} from "@/lib/organization-admin";
import { cn } from "@/lib/utils";
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembershipRole,
  OrganizationWorkspaceAccess,
} from "@/types";

import {
  useOrganizationDirectory,
  type OrganizationDirectory,
  type WorkspaceRoleId,
} from "./organization-directory";
import { useOrganizationNavigation, type OrganizationNavigation } from "./organization-nav";
import {
  canResendInvitation,
  expiresLabel,
  firstName,
  initialsOf,
  invitationDeliveryOutcome,
  invitationState,
  invitationStatusLabel,
  joinNames,
  memberName,
  memberStatusLabel,
  ORGANIZATION_ROLE_LABELS,
  organizationRoleOptions,
  withArticle,
  workspaceRoleLabel,
  workspaceRoleOptions,
} from "./organization-people-model";

/* ----------------------------------------------------------------------------
   Organization settings > People: one list for everyone in the organization,
   invitations included. A person's page changes their organization role and
   their access to each shared workspace; Invite people is its own page.
   -------------------------------------------------------------------------- */

type Confirm =
  | { kind: "suspend"; member: OrganizationMember }
  | { kind: "remove"; member: OrganizationMember }
  | { kind: "revoke"; invitation: OrganizationInvitation };

export function OrganizationPeoplePage({
  workspaceId,
  person,
  invitation,
  view,
}: {
  workspaceId: string;
  person?: string;
  invitation?: string;
  view?: "invite";
}) {
  const directory = useOrganizationDirectory();
  const nav = useOrganizationNavigation(workspaceId);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const actions = usePeopleActions(directory, setConfirm);

  let page;
  if (view === "invite") page = <InvitePage nav={nav} />;
  else if (person) page = <PersonPage key={person} id={person} nav={nav} actions={actions} />;
  else if (invitation) {
    page = <InvitationPage key={invitation} id={invitation} nav={nav} actions={actions} />;
  } else page = <PeopleList nav={nav} actions={actions} />;

  return (
    <>
      {page}
      <PeopleConfirm
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onRemoved={() => {
          if (person || invitation) nav.openSection("people");
        }}
      />
    </>
  );
}

/* ----------------------------------------------------------------- actions */

interface PeopleActions {
  requestSuspend: (member: OrganizationMember) => void;
  requestRemove: (member: OrganizationMember) => void;
  requestRevoke: (invitation: OrganizationInvitation) => void;
  restore: (member: OrganizationMember) => Promise<void>;
  resend: (invitation: OrganizationInvitation) => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usePeopleActions(
  directory: OrganizationDirectory,
  setConfirm: (confirm: Confirm) => void,
): PeopleActions {
  return useMemo(
    () => ({
      requestSuspend: (member) => setConfirm({ kind: "suspend", member }),
      requestRemove: (member) => setConfirm({ kind: "remove", member }),
      requestRevoke: (invitation) => setConfirm({ kind: "revoke", invitation }),
      restore: async (member) => {
        try {
          await directory.transitionMember(member, "reactivate");
          toast.success(`Restored ${memberName(member)}`, {
            description: "Give them workspace access again from their page.",
          });
        } catch (error) {
          toast.error(`Couldn't restore ${memberName(member)}`, { description: errorText(error) });
        }
      },
      resend: async (invitation) => {
        try {
          const updated = await directory.retryInvitation(invitation);
          if (updated.delivery?.state === "sent") {
            toast.success(`Sent a new invitation to ${invitation.targetEmail}`);
          } else {
            toast.error("The invitation email still needs attention", {
              description: invitationDeliveryOutcome(updated),
            });
          }
        } catch (error) {
          toast.error("Couldn't resend the invitation", { description: errorText(error) });
        }
      },
    }),
    [directory, setConfirm],
  );
}

function activeOwnerCount(members: readonly OrganizationMember[]): number {
  return members.filter((member) => member.role === "owner" && member.status === "active").length;
}

function isSoleOwner(member: OrganizationMember, members: readonly OrganizationMember[]): boolean {
  return member.role === "owner" && member.status === "active" && activeOwnerCount(members) <= 1;
}

function MemberMenuItems({
  member,
  directory,
  actions,
  onOpen,
  onPage = false,
}: {
  member: OrganizationMember;
  directory: OrganizationDirectory;
  actions: PeopleActions;
  /** In the list: "Change role and access" opens the person's page. */
  onOpen?: () => void;
  /** On the person's page, Restore is the header's primary button. */
  onPage?: boolean;
}) {
  const capability = organizationMemberCapabilities(
    directory.actorRole,
    member,
    activeOwnerCount(directory.members.value),
  );
  return (
    <>
      {onOpen && member.status === "active" ? (
        <>
          <DropdownMenuItem onSelect={onOpen}>
            <UserRoundIcon />
            Change role and access
          </DropdownMenuItem>
          {capability.canSuspend || capability.canOffboard ? <DropdownMenuSeparator /> : null}
        </>
      ) : null}
      {capability.canReactivate && !onPage ? (
        <DropdownMenuItem onSelect={() => void actions.restore(member)}>
          <PlayIcon />
          Restore access
        </DropdownMenuItem>
      ) : null}
      {capability.canSuspend ? (
        <DropdownMenuItem onSelect={() => actions.requestSuspend(member)}>
          <PauseIcon />
          Suspend…
        </DropdownMenuItem>
      ) : null}
      {capability.canReactivate && !onPage && capability.canOffboard ? (
        <DropdownMenuSeparator />
      ) : null}
      {capability.canOffboard ? (
        <DropdownMenuItem variant="destructive" onSelect={() => actions.requestRemove(member)}>
          <UserMinusIcon />
          Remove from organization…
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function hasMemberActions(member: OrganizationMember, directory: OrganizationDirectory): boolean {
  const capability = organizationMemberCapabilities(
    directory.actorRole,
    member,
    activeOwnerCount(directory.members.value),
  );
  return capability.canSuspend || capability.canReactivate || capability.canOffboard;
}

function InvitationMenuItems({
  invitation,
  directory,
  actions,
}: {
  invitation: OrganizationInvitation;
  directory: OrganizationDirectory;
  actions: PeopleActions;
}) {
  const canResend = canResendInvitation(invitation);
  const canRevoke = canRevokeOrganizationInvitation(directory.actorRole, invitation.role);
  return (
    <>
      {canResend ? (
        <DropdownMenuItem onSelect={() => void actions.resend(invitation)}>
          <MailIcon />
          {invitation.delivery ? "Resend invitation" : "Send invitation"}
        </DropdownMenuItem>
      ) : null}
      {canResend && canRevoke ? <DropdownMenuSeparator /> : null}
      {canRevoke ? (
        <DropdownMenuItem variant="destructive" onSelect={() => actions.requestRevoke(invitation)}>
          <XIcon />
          Revoke invitation…
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ small parts */

function PersonAvatar({
  name,
  pending = false,
  size = "default",
}: {
  name: string;
  pending?: boolean;
  size?: "default" | "lg";
}) {
  return (
    <Avatar size={size} aria-hidden="true">
      <AvatarFallback
        className={cn(
          "font-semibold",
          size === "lg" ? "text-sm" : "text-xs",
          pending
            ? "border border-dashed border-border-strong bg-transparent text-fg-subtle"
            : "bg-surface-2 text-fg-muted",
        )}
      >
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** "Design preview · Workspace admin" and a "+2" button that lists the rest. */
function WorkspaceChips({
  name,
  grants,
}: {
  name: string;
  grants: readonly { workspaceId: string; workspaceName: string; role: string }[];
}) {
  const directory = useOrganizationDirectory();
  const roles = workspaceRoleOptions(directory.overview.value);
  const rank: Record<string, number> = { admin: 0, member: 1, custom: 2, viewer: 3 };
  const sorted = [...grants].sort((a, b) => (rank[a.role] ?? 4) - (rank[b.role] ?? 4));
  const [first, ...rest] = sorted;
  const label = (role: string) => workspaceRoleLabel(roles, role as WorkspaceRoleId | "custom");
  if (!first) return <span className="text-fg-subtle">No workspaces</span>;
  return (
    <span className="relative z-10 flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">
        <span className="text-fg">{first.workspaceName}</span>
        <span className="text-fg-subtle"> · {label(first.role)}</span>
      </span>
      {rest.length > 0 ? (
        <PopoverPrimitive.Root>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label={`Show all ${sorted.length} workspaces for ${name}`}
              className="inline-flex h-5.5 shrink-0 items-center rounded-full border border-border bg-surface px-1.5 text-2xs font-medium text-fg-muted tabular-nums transition-colors duration-[120ms] hover:border-border-strong hover:text-fg data-[state=open]:border-border-strong data-[state=open]:text-fg pointer-coarse:h-8 pointer-coarse:px-2.5"
            >
              +{rest.length}
            </button>
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className="z-50 w-72 rounded-[16px] border border-border bg-surface p-1.5 text-fg shadow-og-md outline-none"
            >
              <p className="px-2.5 pt-1.5 pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
                {firstName(name)}'s workspaces
              </p>
              <ul className="flex flex-col">
                {sorted.map((grant) => (
                  <li
                    key={grant.workspaceId}
                    className="flex min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2"
                  >
                    <LogoTile size="sm" name={grant.workspaceName} />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {grant.workspaceName}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">{label(grant.role)}</span>
                  </li>
                ))}
              </ul>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      ) : null}
    </span>
  );
}

function RoleCell({ role, soleOwner }: { role: OrganizationMembershipRole; soleOwner?: boolean }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <span className="truncate text-fg">{ORGANIZATION_ROLE_LABELS[role]}</span>
      {soleOwner ? (
        <span className="text-xs whitespace-nowrap text-fg-subtle">Only owner</span>
      ) : null}
    </span>
  );
}

function invitationWorkspaces(
  invitation: OrganizationInvitation,
  workspaces: readonly OrganizationWorkspaceAccess[],
) {
  return invitation.initialWorkspaceIds.map((workspaceId) => ({
    workspaceId,
    workspaceName:
      workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "A deleted workspace",
    role: "member",
  }));
}

/* -------------------------------------------------------------------- list */

type PeopleFilter = "all" | "invited" | "suspended";

const COLUMNS: RowListColumn[] = [
  { id: "role", label: "Role", width: 136, hideLabel: true },
  { id: "workspaces", label: "Workspaces", width: 256, hideLabel: true },
];

function PeopleList({ nav, actions }: { nav: OrganizationNavigation; actions: PeopleActions }) {
  const directory = useOrganizationDirectory();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const members = directory.members.value.filter((member) => member.status !== "revoked");
  const invitations = directory.invitations.value.invitations.filter(
    (invitation) => invitation.status === "pending",
  );
  const workspaces = directory.overview.value?.workspaces ?? [];
  const loading =
    directory.members.loading && directory.members.value.length === 0 && !directory.members.error;

  const needle = query.trim().toLocaleLowerCase();
  const matches = (...values: Array<string | null | undefined>) =>
    !needle || values.some((value) => value?.toLocaleLowerCase().includes(needle));
  const counts = {
    all: members.length + invitations.length,
    invited: invitations.length,
    suspended: members.filter((member) => member.status === "suspended").length,
  };
  const shownMembers = members
    .filter(
      (member) => filter === "all" || (filter === "suspended" && member.status === "suspended"),
    )
    .filter((member) =>
      matches(
        memberName(member),
        member.email,
        ...member.sharedWorkspaceAccess.map((access) => access.workspaceName),
      ),
    )
    .sort((a, b) => {
      if (a.subjectId === directory.identity.subjectId) return -1;
      if (b.subjectId === directory.identity.subjectId) return 1;
      return memberName(a).localeCompare(memberName(b));
    });
  const shownInvitations = invitations
    .filter(() => filter !== "suspended")
    .filter((invitation) => matches(invitation.targetName, invitation.targetEmail));
  const filtered = Boolean(needle) || filter !== "all";

  if (directory.members.error && members.length === 0) {
    return (
      <ErrorMessage
        variant="inline"
        title="Couldn't load the people in this organization."
        action={<RowButton onClick={() => void directory.reload()}>Try again</RowButton>}
      >
        {directory.members.error.message}
      </ErrorMessage>
    );
  }

  const total = shownMembers.length + shownInvitations.length;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Toolbar>
        <ToolbarSearch
          value={query}
          onValueChange={setQuery}
          placeholder="Search people or workspaces"
          aria-label="Search people"
          disabled={loading}
        />
        <ToolbarGroup>
          <SegmentedControl<PeopleFilter>
            aria-label="Show"
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "invited", label: "Invited", count: counts.invited },
              { value: "suspended", label: "Suspended", count: counts.suspended },
            ]}
            value={filter}
            onValueChange={setFilter}
            disabled={loading}
          />
        </ToolbarGroup>
      </Toolbar>
      {filtered && !loading ? (
        <ToolbarSummary>
          {total} of {counts.all} {counts.all === 1 ? "person" : "people"}
        </ToolbarSummary>
      ) : null}
      {loading ? (
        <RowList columns={COLUMNS} label="People" busy flush>
          <ListRowSkeleton count={4} />
        </RowList>
      ) : total === 0 ? (
        <EmptyState
          variant="inline"
          title={
            needle
              ? `No one matches "${query.trim()}".`
              : filter === "invited"
                ? "No open invitations."
                : filter === "suspended"
                  ? "Nobody is suspended."
                  : "No one here yet."
          }
          action={
            filtered ? (
              <EmptyStateLink
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                {needle ? "Clear search" : "Show everyone"}
              </EmptyStateLink>
            ) : undefined
          }
        />
      ) : (
        <RowList
          columns={COLUMNS}
          label={`People in ${directory.overview.value?.organization.name ?? "the organization"}`}
          nameLabel="Person"
          flush
        >
          {filter !== "invited"
            ? shownMembers.map((member) => {
                const name = memberName(member);
                const you = member.subjectId === directory.identity.subjectId;
                const status = memberStatusLabel(member);
                return (
                  <ListRow
                    key={member.id}
                    leading={<PersonAvatar name={name} />}
                    title={name}
                    titleAddon={you ? <MetaChip variant="outline">You</MetaChip> : undefined}
                    description={member.email && member.email !== name ? member.email : undefined}
                    status={
                      status ? (
                        <StatusBadge
                          variant="dot"
                          status={member.status === "suspended" ? "suspended" : "queued"}
                        >
                          {status}
                        </StatusBadge>
                      ) : undefined
                    }
                    cells={{
                      role: (
                        <RoleCell
                          role={member.role}
                          soleOwner={isSoleOwner(member, directory.members.value)}
                        />
                      ),
                      workspaces: (
                        <WorkspaceChips name={name} grants={member.sharedWorkspaceAccess} />
                      ),
                    }}
                    onOpen={() => nav.openPerson(member.id)}
                    menu={
                      !you && hasMemberActions(member, directory) ? (
                        <MemberMenuItems
                          member={member}
                          directory={directory}
                          actions={actions}
                          onOpen={() => nav.openPerson(member.id)}
                        />
                      ) : undefined
                    }
                    indicator={you || !hasMemberActions(member, directory) ? "open" : undefined}
                  />
                );
              })
            : null}
          {shownInvitations.map((invitation) => {
            const name = invitation.targetName || invitation.targetEmail;
            const failed = invitationState(invitation) === "failed";
            return (
              <ListRow
                key={invitation.id}
                leading={<PersonAvatar name={name} pending />}
                title={name}
                description={invitation.targetName ? invitation.targetEmail : undefined}
                status={
                  <StatusBadge variant="dot" status={failed ? "invite_failed" : "invited"}>
                    {invitationStatusLabel(invitation)}
                  </StatusBadge>
                }
                cells={{
                  role: <RoleCell role={invitation.role} />,
                  workspaces: (
                    <WorkspaceChips
                      name={name}
                      grants={invitationWorkspaces(invitation, workspaces)}
                    />
                  ),
                }}
                onOpen={() => nav.openInvitation(invitation.id)}
                menu={
                  <InvitationMenuItems
                    invitation={invitation}
                    directory={directory}
                    actions={actions}
                  />
                }
              />
            );
          })}
        </RowList>
      )}
      {directory.invitations.value.nextCursor ? (
        <div>
          <RowButton
            disabled={directory.invitations.loading}
            onClick={() => void directory.loadMoreInvitations()}
          >
            Show more invitations
          </RowButton>
        </div>
      ) : null}
      {!loading && counts.all === 1 && !filtered ? (
        <EmptyState
          variant="inline"
          title="Only you so far."
          description="Invite people to share workspaces with them."
          action={<EmptyStateLink onClick={nav.openInvite}>Invite people</EmptyStateLink>}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ person page */

function WorkspaceAccessRows({
  member,
  lockedReason,
}: {
  member: OrganizationMember;
  lockedReason?: string;
}) {
  const directory = useOrganizationDirectory();
  const [saving, setSaving] = useState<string | null>(null);
  const overview = directory.overview.value;
  const roles = workspaceRoleOptions(overview);
  const name = memberName(member);
  if (!overview) return <ListRowSkeleton count={2} />;
  if (overview.workspaces.length === 0) {
    return <p className="text-sm text-fg-muted">There are no shared workspaces yet.</p>;
  }
  return (
    <ul
      aria-label={`Workspace access for ${name}`}
      className="-mx-3 flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-border"
    >
      {overview.workspaces.map((workspace) => {
        const grant =
          workspace.members.find((each) => each.organizationMembershipId === member.id) ?? null;
        return (
          <li
            key={workspace.id}
            className="grid min-h-14 min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2.5 @[440px]/detail:grid-cols-[2rem_minmax(0,1fr)_auto]"
          >
            <LogoTile size="md" name={workspace.name} />
            <p className="min-w-0 truncate text-sm leading-5 font-medium text-fg">
              {workspace.name}
            </p>
            <div className="col-start-2 min-w-0 @[440px]/detail:col-start-3">
              <RoleSelect<WorkspaceRoleId>
                roles={roles}
                value={grant?.role ?? null}
                noAccessLabel="No access"
                subjectName={name}
                aria-label={`${name} in ${workspace.name}`}
                disabledReason={lockedReason}
                pending={saving === workspace.id}
                className="w-[11.5rem]"
                onValueChange={async (role) => {
                  setSaving(workspace.id);
                  try {
                    if (role === null) {
                      if (!grant) return;
                      await directory.removeWorkspaceAccess({
                        workspaceId: workspace.id,
                        member: grant,
                      });
                      toast.success(`${name} no longer has access to ${workspace.name}`);
                    } else {
                      await directory.setWorkspaceRole({
                        workspaceId: workspace.id,
                        organizationMembershipId: member.id,
                        role,
                        current: grant,
                      });
                      const label = withArticle(workspaceRoleLabel(roles, role));
                      toast.success(
                        grant
                          ? `${name} is now ${label} in ${workspace.name}`
                          : `Added ${name} to ${workspace.name} as ${label}`,
                      );
                    }
                  } catch (error) {
                    toast.error(`Couldn't change ${name}'s access to ${workspace.name}`, {
                      description: errorText(error),
                    });
                  } finally {
                    setSaving(null);
                  }
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PersonPage({
  id,
  nav,
  actions,
}: {
  id: string;
  nav: OrganizationNavigation;
  actions: PeopleActions;
}) {
  const directory = useOrganizationDirectory();
  const roleHeadingId = useId();
  const back = { label: "People", onClick: () => nav.openSection("people") };
  const member = directory.members.value.find((candidate) => candidate.id === id) ?? null;

  if (!member) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {directory.members.loading ? (
          <DetailSkeleton />
        ) : directory.members.error ? (
          <ErrorMessage
            variant="inline"
            title="Couldn't load this person."
            action={<RowButton onClick={() => void directory.reload()}>Try again</RowButton>}
          >
            {directory.members.error.message}
          </ErrorMessage>
        ) : (
          <EmptyState
            variant="page"
            icon={<UsersIcon />}
            title="This person isn't in the organization"
            description="They may have been removed. Pick someone from the list."
            action={<RowButton onClick={back.onClick}>Show people</RowButton>}
          />
        )}
      </DetailPage>
    );
  }

  const name = memberName(member);
  const you = member.subjectId === directory.identity.subjectId;
  const capability = organizationMemberCapabilities(
    directory.actorRole,
    member,
    activeOwnerCount(directory.members.value),
  );
  const soleOwner = isSoleOwner(member, directory.members.value);
  const suspended = member.status === "suspended";
  const removed = member.status === "revoked";
  const roleLocked = soleOwner
    ? `${you ? "You're" : `${firstName(name)} is`} the only owner. Make someone else an owner first.`
    : suspended
      ? "Restore their access before changing their role."
      : member.status === "provisioning"
        ? "They're still joining. Try again in a moment."
        : removed
          ? "They were removed from the organization."
          : !capability.canChangeRole
            ? "Only owners can change an owner's or admin's role."
            : undefined;
  const roles = organizationRoleOptions(capability.allowedRoles);
  const accessLocked = suspended
    ? "Restore their access first."
    : removed
      ? "They were removed from the organization."
      : undefined;
  const status = memberStatusLabel(member);

  const aside = (
    <DetailAside label={`About ${name}`}>
      <DetailAsideItem label="Joined" icon={<CalendarIcon />}>
        <RelativeTime date={member.createdAt} format="date" />
      </DetailAsideItem>
      <DetailAsideItem label="Personal workspace" icon={<LockIcon />}>
        Private to {you ? "you" : firstName(name)}. Nobody else can open it, including owners and
        admins.
      </DetailAsideItem>
    </DetailAside>
  );

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<PersonAvatar name={name} size="lg" />}
        title={name}
        chips={
          <>
            {you ? <MetaChip variant="outline">You</MetaChip> : null}
            {status ? (
              <StatusBadge status={suspended ? "suspended" : removed ? "revoked" : "queued"}>
                {status}
              </StatusBadge>
            ) : null}
          </>
        }
        meta={[
          member.email && member.email !== name ? member.email : null,
          ORGANIZATION_ROLE_LABELS[member.role],
        ]}
        actions={
          <>
            {capability.canReactivate ? (
              <Button
                type="button"
                onClick={() => void actions.restore(member)}
                className="pointer-coarse:h-11"
              >
                Restore access
              </Button>
            ) : null}
            {!you && (capability.canSuspend || capability.canOffboard) ? (
              <MoreMenu label={`More actions for ${name}`}>
                <MemberMenuItems member={member} directory={directory} actions={actions} onPage />
              </MoreMenu>
            ) : null}
          </>
        }
      />
      <DetailPageBody aside={aside}>
        {suspended ? (
          <DetailSection>
            <InlineHelp icon>
              {firstName(name)} can't sign in, and their workspace access was removed when they were
              suspended. Restoring gives back their Personal workspace only.
            </InlineHelp>
          </DetailSection>
        ) : null}
        <DetailSection
          title={<span id={roleHeadingId}>Organization role</span>}
          description="Saves as soon as you pick one."
        >
          <RoleSelect<OrganizationMembershipRole>
            variant="list"
            aria-labelledby={roleHeadingId}
            roles={roles}
            value={member.role}
            subjectName={name}
            disabledReason={roleLocked}
            onValueChange={async (role) => {
              if (!role || role === member.role) return;
              try {
                await directory.changeOrganizationRole(member, role);
                toast.success(`${name} is now ${withArticle(ORGANIZATION_ROLE_LABELS[role])}`);
              } catch (error) {
                toast.error(`Couldn't change ${name}'s role`, { description: errorText(error) });
                throw error;
              }
            }}
          />
        </DetailSection>
        <DetailSection
          title="Workspace access"
          description="One role per shared workspace. Saves right away."
        >
          <WorkspaceAccessRows member={member} lockedReason={accessLocked} />
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}

/* -------------------------------------------------------- invitation page */

function InvitationPage({
  id,
  nav,
  actions,
}: {
  id: string;
  nav: OrganizationNavigation;
  actions: PeopleActions;
}) {
  const directory = useOrganizationDirectory();
  const back = { label: "People", onClick: () => nav.openSection("people") };
  const invitation =
    directory.invitations.value.invitations.find((candidate) => candidate.id === id) ?? null;
  if (!invitation || invitation.status !== "pending") {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {directory.invitations.loading ? (
          <DetailSkeleton />
        ) : (
          <EmptyState
            variant="page"
            icon={<MailIcon />}
            title={
              invitation?.status === "accepted"
                ? "This invitation was accepted"
                : "This invitation is no longer open"
            }
            description={
              invitation?.status === "accepted"
                ? "They're in the organization now. Find them in the list."
                : "It was revoked or it expired. Invite them again to send a new one."
            }
            action={<RowButton onClick={back.onClick}>Show people</RowButton>}
          />
        )}
      </DetailPage>
    );
  }
  const name = invitation.targetName || invitation.targetEmail;
  const state = invitationState(invitation);
  const workspaces = invitationWorkspaces(invitation, directory.overview.value?.workspaces ?? []);
  const canResend = canResendInvitation(invitation);
  const canRevoke = canRevokeOrganizationInvitation(directory.actorRole, invitation.role);
  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<PersonAvatar name={name} pending size="lg" />}
        title={name}
        chips={
          <StatusBadge status={state === "failed" ? "invite_failed" : "invited"}>
            {state === "failed" ? "Email failed" : "Invited"}
          </StatusBadge>
        }
        meta={[
          invitation.targetName ? invitation.targetEmail : null,
          ORGANIZATION_ROLE_LABELS[invitation.role],
          expiresLabel(invitation.expiresAt).replace(/^e/, "E"),
        ]}
        actions={
          <>
            {canResend ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void actions.resend(invitation)}
                className="pointer-coarse:h-11"
              >
                <MailIcon aria-hidden="true" />
                {invitation.delivery ? "Resend invitation" : "Send invitation"}
              </Button>
            ) : null}
            {canRevoke ? (
              <MoreMenu label={`More actions for the invitation to ${invitation.targetEmail}`}>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => actions.requestRevoke(invitation)}
                >
                  <XIcon />
                  Revoke invitation…
                </DropdownMenuItem>
              </MoreMenu>
            ) : null}
          </>
        }
      />
      <DetailPageBody>
        {state === "failed" || state === "unknown" || state === "not-sent" ? (
          <DetailSection>
            <Notice
              tone={state === "failed" ? "failed" : "waiting"}
              title={
                state === "failed"
                  ? "The invitation email didn't go out"
                  : state === "unknown"
                    ? "We can't tell whether the email went out"
                    : "The invitation email hasn't gone out yet"
              }
            >
              {state === "unknown" && !canResend
                ? "Wait for it to settle before sending again, so they don't get two emails."
                : `Check that ${invitation.targetEmail} is right, then send it again.`}
            </Notice>
          </DetailSection>
        ) : null}
        <DetailSection
          title="Organization role"
          description="What they can do once they join. To change it, revoke this invitation and invite them again."
        >
          <p className="text-sm text-fg">{ORGANIZATION_ROLE_LABELS[invitation.role]}</p>
        </DetailSection>
        <DetailSection
          title="Workspace access"
          description="Where they can work once they join. Invitations give access as Member."
        >
          {workspaces.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Only their private Personal workspace. Add workspaces from their page once they join.
            </p>
          ) : (
            <ul className="-mx-3 flex min-w-0 flex-col">
              {workspaces.map((workspace) => (
                <li
                  key={workspace.workspaceId}
                  className="flex min-h-12 min-w-0 items-center gap-3 px-3 py-2"
                >
                  <LogoTile size="md" name={workspace.workspaceName} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {workspace.workspaceName}
                  </span>
                  <span className="shrink-0 text-sm text-fg-muted">Member</span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}

/* ------------------------------------------------------------ invite page */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function InvitePage({ nav }: { nav: OrganizationNavigation }) {
  const directory = useOrganizationDirectory();
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<OrganizationMembershipRole>("member");
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const organizationName = directory.overview.value?.organization.name ?? "the organization";
  const workspaces = directory.overview.value?.workspaces ?? [];

  const members = new Map(
    directory.members.value
      .filter((member) => member.email && member.status !== "revoked")
      .map((member) => [member.email!.toLowerCase(), member]),
  );
  const invited = new Set(
    directory.invitations.value.invitations
      .filter((invitation) => invitation.status === "pending")
      .map((invitation) => invitation.targetEmail.toLowerCase()),
  );
  const chips: EmailChip[] = emails.map((value) => {
    if (!EMAIL.test(value)) return { value, problem: "Not an email address" };
    if (members.has(value)) return { value, problem: `Already in ${organizationName}` };
    if (invited.has(value)) return { value, problem: "Already invited" };
    return { value };
  });
  const problems = chips.filter((chip) => chip.problem);
  const count = Math.max(1, chips.length - problems.length);
  const emailError =
    emails.length === 0
      ? showErrors
        ? "Add at least one email address."
        : undefined
      : problems.length === 1
        ? `${problems[0]!.value}: ${problems[0]!.problem}.`
        : problems.length > 1
          ? `Fix these addresses: ${problems.map((chip) => chip.value).join(", ")}.`
          : undefined;
  const roles = organizationRoleOptions();

  return (
    <ModelsFormPage
      title="Invite people"
      description={`They'll get an email with a link to join ${organizationName}.`}
      backLabel="People"
      onClose={() => nav.openSection("people")}
      submitLabel={count > 1 ? `Send ${count} invitations` : "Send invitation"}
      submitAnalyticsAction="invite_member"
      pendingLabel="Sending…"
      footerStart="Invitations expire in 7 days."
      onSubmit={async () => {
        setShowErrors(true);
        if (emails.length === 0 || problems.length > 0) return false;
        if (!canInviteOrganizationRole(directory.actorRole, role)) {
          throw new Error("Only owners can invite owners and admins.");
        }
        const result = await directory.invite({ emails, role, workspaceIds });
        if (result.sent.length > 0) {
          toast.success(
            result.sent.length === 1
              ? `Invited ${result.sent[0]!.targetEmail}`
              : `Invited ${result.sent.length} people`,
            result.sent.length === 1
              ? { description: invitationDeliveryOutcome(result.sent[0]!) }
              : undefined,
          );
        }
        if (result.failed.length > 0) {
          setEmails(result.failed.map((each) => each.email));
          throw new Error(
            result.failed.length === 1
              ? `Couldn't invite ${result.failed[0]!.email}: ${result.failed[0]!.message}`
              : `Couldn't invite ${joinNames(result.failed.map((each) => each.email))}. ${result.failed[0]!.message}`,
          );
        }
        nav.openSection("people");
        return true;
      }}
    >
      <FieldStack>
        <Field
          label="Email addresses"
          hint="Separate with commas, or press Enter after each one."
          error={emailError}
        >
          <EmailChipsInput chips={chips} onChange={setEmails} placeholder="name@example.com" />
        </Field>
        <Field label="Organization role" group>
          <ChoiceCards
            value={role}
            onValueChange={(value) => setRole(value as OrganizationMembershipRole)}
            aria-label="Organization role"
          >
            {roles.map((option) => (
              <ChoiceCard
                key={option.id}
                value={option.id}
                title={option.label}
                description={option.description}
                disabled={!canInviteOrganizationRole(directory.actorRole, option.id)}
                disabledReason={
                  canInviteOrganizationRole(directory.actorRole, option.id)
                    ? undefined
                    : "Only owners can invite owners and admins."
                }
              />
            ))}
          </ChoiceCards>
        </Field>
        {workspaces.length > 0 ? (
          <Field
            label="Give access as Member to:"
            group
            hint="Everyone also gets a private Personal workspace."
          >
            <div className="flex min-w-0 flex-col gap-3">
              {workspaces.map((workspace) => (
                <CheckboxField
                  key={workspace.id}
                  label={workspace.name}
                  checked={workspaceIds.includes(workspace.id)}
                  onCheckedChange={(checked) =>
                    setWorkspaceIds((current) =>
                      checked
                        ? [...new Set([...current, workspace.id])]
                        : current.filter((each) => each !== workspace.id),
                    )
                  }
                />
              ))}
            </div>
          </Field>
        ) : null}
      </FieldStack>
    </ModelsFormPage>
  );
}

/* ----------------------------------------------------------- confirmations */

function PeopleConfirm({
  confirm,
  onClose,
  onRemoved,
}: {
  confirm: Confirm | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const directory = useOrganizationDirectory();
  const organizationName = directory.overview.value?.organization.name ?? "the organization";
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  if (confirm?.kind === "suspend") {
    const member = confirm.member;
    const name = memberName(member);
    const first = firstName(name);
    const names = member.sharedWorkspaceAccess.map((access) => access.workspaceName);
    return (
      <DestructiveConfirm
        open
        onOpenChange={onOpenChange}
        title={`Suspend ${name}?`}
        consequences={[
          `${first} can't sign in to ${organizationName} until you restore their access.`,
          names.length > 0
            ? `Their access to ${joinNames(names)} is removed. Restoring doesn't bring it back.`
            : "They have no shared workspaces right now.",
          "Their unfinished work is stopped. Their Personal workspace is kept.",
        ]}
        confirmLabel="Suspend"
        pendingLabel="Suspending…"
        onConfirm={async () => {
          await directory.transitionMember(member, "suspend");
          toast.success(`Suspended ${name}`, {
            description: "Their workspace access was removed.",
          });
        }}
      />
    );
  }
  if (confirm?.kind === "remove") {
    const member = confirm.member;
    const name = memberName(member);
    const first = firstName(name);
    const count = member.sharedWorkspaceAccess.length;
    return (
      <DestructiveConfirm
        open
        onOpenChange={onOpenChange}
        variant="type-to-confirm"
        confirmText={name}
        confirmPlaceholder="Type the name"
        title={`Remove ${name} from ${organizationName}?`}
        consequences={[
          count > 0
            ? `${first} loses access to ${organizationName} and ${count} shared ${count === 1 ? "workspace" : "workspaces"} right away.`
            : `${first} loses access to ${organizationName} right away.`,
          "Their unfinished work is stopped. Their personal data is kept for as long as your retention policy says.",
          `${first} can never be invited to ${organizationName} again.`,
        ]}
        confirmLabel="Remove from organization"
        pendingLabel="Removing…"
        onConfirm={async () => {
          await directory.transitionMember(member, "offboard");
          toast.success(`Removed ${name} from ${organizationName}`);
          onRemoved();
        }}
      />
    );
  }
  if (confirm?.kind === "revoke") {
    const invitation = confirm.invitation;
    return (
      <DestructiveConfirm
        open
        onOpenChange={onOpenChange}
        title={`Revoke the invitation to ${invitation.targetEmail}?`}
        consequences={[
          "The link in their email stops working right away.",
          "You can invite them again later.",
        ]}
        confirmLabel="Revoke invitation"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          await directory.revokeInvitation(invitation);
          toast.success(`Revoked the invitation to ${invitation.targetEmail}`);
          onRemoved();
        }}
      />
    );
  }
  return null;
}
