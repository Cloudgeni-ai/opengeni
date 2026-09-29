import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  HashIcon,
  LockKeyholeIcon,
  PencilIcon,
  SquareStackIcon,
  Trash2Icon,
  UserPlusIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ModelsFormPage } from "@/components/models/models-ui";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { AccessList, type AccessMember } from "@/components/ui/access-list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { DestructiveConfirm, showUndoToast } from "@/components/ui/destructive-confirm";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@/components/ui/detail-sheet";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SelectMenu } from "@/components/ui/select-menu";
import type {
  OrganizationMember,
  OrganizationWorkspaceAccess,
  OrganizationWorkspaceAccessMember,
} from "@/types";

import {
  useOrganizationDirectory,
  type OrganizationDirectory,
  type WorkspaceRoleId,
} from "./organization-directory";
import { useOrganizationNavigation, type OrganizationNavigation } from "./organization-nav";
import {
  initialsOf,
  joinNames,
  memberName,
  withArticle,
  workspaceMemberName,
  workspaceRoleLabel,
  workspaceRoleOptions,
} from "./organization-people-model";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import type { ReturnTo } from "@/lib/return-to";

/* ----------------------------------------------------------------------------
   Organization settings > Workspaces: every shared workspace, who is in it
   and your own access. Owners and admins manage access without seeing the
   content, and join explicitly to open it. A workspace's own page edits
   access with the shared AccessList.
   -------------------------------------------------------------------------- */

const COLUMNS: RowListColumn[] = [
  { id: "people", label: "People", width: 132, hideLabel: true },
  { id: "access", label: "Your access", width: 168 },
  { id: "created", label: "Created", width: 96 },
];

const SERVICE_LOCK = "Service accounts get access from their API key, in Developer.";
const SINGLE_USER_LOCK = "Single-user mode: only you use this Opengeni.";

export function OrganizationWorkspacesPage({
  workspaceId,
  workspace,
  view,
  returnTo,
  onEnterWorkspace,
}: {
  workspaceId: string;
  workspace?: string;
  view?: "new-workspace";
  /**
   * New workspace opened from outside this list (the workspace picker): its
   * back link returns there, and a created workspace opens with `onEnterWorkspace`.
   */
  returnTo?: ReturnTo | undefined;
  onEnterWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
  const directory = useOrganizationDirectory();
  const nav = useOrganizationNavigation(workspaceId);
  if (view === "new-workspace") {
    return <NewWorkspacePage nav={nav} returnTo={returnTo} onEnterWorkspace={onEnterWorkspace} />;
  }
  if (workspace) return <WorkspacePage key={workspace} workspaceId={workspace} nav={nav} />;
  return <WorkspacesList directory={directory} nav={nav} />;
}

/* ----------------------------------------------------------------- helpers */

function youOf(directory: OrganizationDirectory) {
  return { subjectId: directory.identity.subjectId, label: directory.youLabel };
}

/** Your role in a workspace, or null when you can't open it. */
function yourGrant(
  directory: OrganizationDirectory,
  workspace: OrganizationWorkspaceAccess,
): OrganizationWorkspaceAccessMember | null {
  return (
    workspace.members.find((member) => member.subjectId === directory.identity.subjectId) ?? null
  );
}

function YourAccess({
  workspace,
  onJoin,
}: {
  workspace: OrganizationWorkspaceAccess;
  onJoin?: () => void;
}) {
  const directory = useOrganizationDirectory();
  const roles = workspaceRoleOptions(directory.overview.value);
  if (directory.singleUser) return <span className="text-fg">Owner</span>;
  const grant = yourGrant(directory, workspace);
  if (grant) return <span className="text-fg">{workspaceRoleLabel(roles, grant.role)}</span>;
  if (directory.accessibleWorkspaceIds.has(workspace.id)) {
    return <span className="text-fg">Has access</span>;
  }
  return (
    <span className="relative z-10 flex min-w-0 items-center gap-2">
      <span className="text-fg-subtle">No access</span>
      {onJoin && directory.you ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onJoin}
          aria-label={`Join ${workspace.name}`}
          className="h-6 rounded-full px-2.5 pointer-coarse:h-9"
        >
          Join
        </Button>
      ) : null}
    </span>
  );
}

function PeopleStack({ members }: { members: readonly OrganizationWorkspaceAccessMember[] }) {
  const directory = useOrganizationDirectory();
  const you = youOf(directory);
  const humans = members.filter((member) => member.principalKind === "human");
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* Spans only: on narrow lists this cell folds into the row's meta line (a <p>). */}
      <span aria-hidden="true" className="flex shrink-0 -space-x-1">
        {humans.slice(0, 3).map((member) => (
          <Avatar key={member.membershipId} size="sm" className="ring-2 ring-bg">
            <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
              {initialsOf(workspaceMemberName(member, you))}
            </AvatarFallback>
          </Avatar>
        ))}
      </span>
      <span className="text-fg-muted tabular-nums">
        {members.length} {members.length === 1 ? "person" : "people"}
      </span>
    </span>
  );
}

/** Join: an explicit self-grant as Workspace admin that the workspace's admins can see. */
function JoinDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: OrganizationWorkspaceAccess;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const directory = useOrganizationDirectory();
  const admins = workspace.members
    .filter((member) => member.role === "admin" && member.principalKind === "human")
    .map((member) => workspaceMemberName(member, youOf(directory)));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Join ${workspace.name}?`}
      description={`You'll join as Workspace admin, so you can open its chats and files.${
        admins.length > 0 ? ` ${joinNames(admins)} will see that you joined.` : ""
      }`}
      submitLabel="Join as workspace admin"
      pendingLabel="Joining…"
      initialFocus="cancel"
      onSubmit={async () => {
        const you = directory.you;
        if (!you) throw new Error("Your membership hasn't loaded yet. Try again.");
        await directory.setWorkspaceRole({
          workspaceId: workspace.id,
          organizationMembershipId: you.id,
          role: "admin",
          current: null,
        });
        toast.success(`You joined ${workspace.name} as a workspace admin`);
      }}
      onSubmitted={() => onOpenChange(false)}
    />
  );
}

/* -------------------------------------------------------------------- list */

function WorkspacesList({
  directory,
  nav,
}: {
  directory: OrganizationDirectory;
  nav: OrganizationNavigation;
}) {
  const [joining, setJoining] = useState<OrganizationWorkspaceAccess | null>(null);
  const overview = directory.overview;
  if (overview.error && !overview.value) {
    return (
      <ErrorMessage
        variant="inline"
        title="Couldn't load the workspaces."
        action={<RowButton onClick={() => void directory.reload()}>Try again</RowButton>}
      >
        {overview.error.message}
      </ErrorMessage>
    );
  }
  if (!overview.value) {
    return (
      <RowList columns={COLUMNS} label="Workspaces" busy flush>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  }
  const workspaces = overview.value.workspaces;
  if (workspaces.length === 0) {
    return (
      <EmptyState
        variant="page"
        icon={<SquareStackIcon />}
        title="No shared workspaces yet"
        description="Create one for a team. Everyone also has a private Personal workspace."
        action={
          <RowButton variant="default" onClick={nav.openNewWorkspace}>
            New workspace
          </RowButton>
        }
        className="pt-8 pb-6"
      />
    );
  }
  return (
    <>
      <RowList
        columns={COLUMNS}
        label={`Workspaces in ${overview.value.organization.name}`}
        nameLabel="Workspace"
        flush
      >
        {workspaces.map((workspace) => (
          <ListRow
            key={workspace.id}
            leading={<LogoTile name={workspace.name} />}
            title={workspace.name}
            cells={{
              people: <PeopleStack members={workspace.members} />,
              access: <YourAccess workspace={workspace} onJoin={() => setJoining(workspace)} />,
              created: <RelativeTime date={workspace.createdAt} format="date" />,
            }}
            indicator="open"
            onOpen={() => nav.openWorkspace(workspace.id)}
          />
        ))}
      </RowList>
      {joining ? (
        <JoinDialog
          workspace={joining}
          open
          onOpenChange={(open) => {
            if (!open) setJoining(null);
          }}
        />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- one page */

function accessMembers(
  directory: OrganizationDirectory,
  workspace: OrganizationWorkspaceAccess,
): AccessMember<WorkspaceRoleId>[] {
  const people = new Map(directory.members.value.map((member) => [member.id, member]));
  const you = youOf(directory);
  return workspace.members.map((member) => {
    const person: OrganizationMember | undefined = member.organizationMembershipId
      ? people.get(member.organizationMembershipId)
      : undefined;
    const service = member.principalKind === "service";
    const suspended = person?.status === "suspended";
    return {
      id: member.membershipId,
      name: workspaceMemberName(member, you),
      email: member.email,
      initials: initialsOf(workspaceMemberName(member, you)),
      kind: service ? "service" : "person",
      isYou: member.subjectId === directory.identity.subjectId,
      tag: directory.singleUser ? "Owner" : undefined,
      // Single-user mode: the local administrator has every permission.
      role: directory.singleUser ? "admin" : member.role,
      resetRole: !directory.singleUser && member.role === "custom" ? "member" : undefined,
      status: suspended ? "suspended" : undefined,
      statusLabel: suspended ? "Suspended" : undefined,
      roleLockedReason: service
        ? SERVICE_LOCK
        : !member.organizationMembershipId
          ? "This access was given outside the organization."
          : undefined,
      removeLockedReason: service ? SERVICE_LOCK : undefined,
    };
  });
}

function AddPeople({
  workspace,
  nav,
}: {
  workspace: OrganizationWorkspaceAccess;
  nav: OrganizationNavigation;
}) {
  const directory = useOrganizationDirectory();
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const present = new Set(workspace.members.map((member) => member.organizationMembershipId));
  const candidates = directory.members.value.filter(
    (member) => member.status === "active" && !present.has(member.id),
  );
  if (directory.members.loading && directory.members.value.length === 0) return null;
  if (candidates.length === 0) {
    return (
      <RowButton onClick={nav.openInvite}>
        <UserPlusIcon aria-hidden="true" />
        Invite people
      </RowButton>
    );
  }
  return (
    <SelectMenu
      variant="combobox"
      size="sm"
      aria-label={`Add people to ${workspace.name}`}
      placeholder="Add people"
      searchPlaceholder="Search people"
      value={value}
      disabled={saving}
      loading={saving}
      loadingLabel="Adding…"
      options={candidates.map((member) => ({
        value: member.id,
        label: memberName(member),
        meta: member.email && member.email !== memberName(member) ? member.email : undefined,
        leading: (
          <Avatar size="sm" aria-hidden="true">
            <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
              {initialsOf(memberName(member))}
            </AvatarFallback>
          </Avatar>
        ),
      }))}
      onValueChange={(id) => {
        const member = candidates.find((candidate) => candidate.id === id);
        if (!member) return;
        setValue(id);
        setSaving(true);
        void directory
          .setWorkspaceRole({
            workspaceId: workspace.id,
            organizationMembershipId: member.id,
            role: "member",
            current: null,
          })
          .then(
            () => toast.success(`Added ${memberName(member)} to ${workspace.name} as a member`),
            (error: unknown) =>
              toast.error(`Couldn't add ${memberName(member)}`, {
                description: error instanceof Error ? error.message : String(error),
              }),
          )
          .finally(() => {
            setSaving(false);
            setValue(null);
          });
      }}
      showMetaInTrigger={false}
      className="w-44"
    />
  );
}

function WorkspacePage({ workspaceId, nav }: { workspaceId: string; nav: OrganizationNavigation }) {
  const directory = useOrganizationDirectory();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const back = { label: "Workspaces", onClick: () => nav.openSection("workspaces") };
  const overview = directory.overview.value;
  const workspace = overview?.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;

  if (!overview) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {directory.overview.error ? (
          <ErrorMessage
            variant="inline"
            title="Couldn't load this workspace."
            action={<RowButton onClick={() => void directory.reload()}>Try again</RowButton>}
          >
            {directory.overview.error.message}
          </ErrorMessage>
        ) : (
          <DetailSkeleton />
        )}
      </DetailPage>
    );
  }
  if (!workspace) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<SquareStackIcon />}
          title="This workspace is gone"
          description="It may have been deleted. Pick another one from the list."
          action={<RowButton onClick={back.onClick}>Show workspaces</RowButton>}
        />
      </DetailPage>
    );
  }

  const roles = workspaceRoleOptions(overview);
  const members = accessMembers(directory, workspace);
  const canOpen = directory.singleUser || directory.accessibleWorkspaceIds.has(workspace.id);
  const byId = new Map(workspace.members.map((member) => [member.membershipId, member]));
  const peopleLine = `${workspace.members.length} ${workspace.members.length === 1 ? "person" : "people"}`;

  const changeRole = async (member: AccessMember<WorkspaceRoleId>, role: WorkspaceRoleId) => {
    const current = byId.get(member.id);
    if (!current?.organizationMembershipId) return;
    try {
      await directory.setWorkspaceRole({
        workspaceId: workspace.id,
        organizationMembershipId: current.organizationMembershipId,
        role,
        current,
      });
      toast.success(
        `${member.name} is now ${withArticle(workspaceRoleLabel(roles, role))} in ${workspace.name}`,
      );
    } catch (error) {
      toast.error(`Couldn't change ${member.name}'s role`, {
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const remove = async (member: AccessMember<WorkspaceRoleId>) => {
    const current = byId.get(member.id);
    if (!current?.organizationMembershipId) return;
    const organizationMembershipId = current.organizationMembershipId;
    const before = current.role;
    try {
      await directory.removeWorkspaceAccess({ workspaceId: workspace.id, member: current });
    } catch (error) {
      toast.error(`Couldn't remove ${member.name}`, {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const restore = before === "custom" ? null : before;
    if (restore) {
      showUndoToast({
        title: `${member.name} no longer has access to ${workspace.name}`,
        onUndo: () =>
          void directory
            .setWorkspaceRole({
              workspaceId: workspace.id,
              organizationMembershipId,
              role: restore,
              current: null,
            })
            .catch((error: unknown) =>
              toast.error(`Couldn't give ${member.name} access again`, {
                description: error instanceof Error ? error.message : String(error),
              }),
            ),
      });
    } else {
      toast.success(`${member.name} no longer has access to ${workspace.name}`);
    }
  };

  const aside = (
    <DetailAside label={`About ${workspace.name}`}>
      <DetailAsideItem label="Your access" icon={<UserRoundIcon />}>
        <YourAccess workspace={workspace} />
      </DetailAsideItem>
      <DetailAsideItem label="Created" icon={<CalendarIcon />}>
        <RelativeTime date={workspace.createdAt} format="date" />
      </DetailAsideItem>
      <DetailAsideItem label="Workspace ID" icon={<HashIcon />}>
        <CopyField value={workspace.id} label="workspace ID" truncate="middle" maxLength={20} />
      </DetailAsideItem>
    </DetailAside>
  );

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<LogoTile name={workspace.name} />}
        title={workspace.name}
        chips={<MetaChip variant="soft">Shared</MetaChip>}
        meta={[peopleLine]}
        actions={
          <>
            {canOpen ? (
              <Button asChild variant="outline" className="pointer-coarse:h-11">
                <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId: workspace.id }}>
                  Open workspace
                  <ArrowUpRightIcon aria-hidden="true" />
                </Link>
              </Button>
            ) : directory.you ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setJoinOpen(true)}
                className="pointer-coarse:h-11"
              >
                Join
              </Button>
            ) : null}
            <MoreMenu label={`More actions for ${workspace.name}`}>
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2Icon />
                Delete workspace…
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
      />
      <DetailPageBody aside={aside}>
        {!canOpen ? (
          <DetailSection>
            <Notice
              tone="muted"
              icon={<LockKeyholeIcon className="size-4" />}
              title="You can manage who has access, but not open it"
            >
              Join to see its chats and files. Its workspace admins will see that you joined.
            </Notice>
          </DetailSection>
        ) : null}
        <DetailSection
          title="People with access"
          description={
            directory.singleUser
              ? undefined
              : `People come from ${overview.organization.name}. Roles save right away.`
          }
          action={directory.singleUser ? undefined : <AddPeople workspace={workspace} nav={nav} />}
        >
          <div className="-mx-3">
            <AccessList<WorkspaceRoleId>
              label={`People with access to ${workspace.name}`}
              roles={roles}
              members={members}
              removeLabel="Remove from workspace"
              readOnlyReason={directory.singleUser ? SINGLE_USER_LOCK : undefined}
              emptyMessage={
                directory.singleUser
                  ? undefined
                  : "Only you so far. Add people from the organization."
              }
              onRoleChange={(member, role) => (role ? changeRole(member, role) : remove(member))}
              onResetToRole={(member) => changeRole(member, member.resetRole ?? "member")}
              onRemove={(member) => void remove(member)}
              onOpen={(member) => {
                const organizationMembershipId = byId.get(member.id)?.organizationMembershipId;
                if (organizationMembershipId && !directory.singleUser) {
                  nav.openPerson(organizationMembershipId);
                }
              }}
            />
          </div>
        </DetailSection>
      </DetailPageBody>
      <RenameWorkspaceDialog workspace={workspace} open={renameOpen} onOpenChange={setRenameOpen} />
      <DestructiveConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="type-to-confirm"
        confirmText={workspace.name}
        confirmPlaceholder="Type the workspace name"
        title={`Delete ${workspace.name}?`}
        consequences={[
          workspace.members.length > 0
            ? `${peopleLine} ${workspace.members.length === 1 ? "loses" : "lose"} access.`
            : "Nobody has access to it right now.",
          "Its chats, files, schedules and knowledge are deleted.",
          "This can't be undone.",
        ]}
        confirmLabel="Delete workspace"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await directory.deleteWorkspace(workspace);
          toast.success(`Deleted ${workspace.name}`);
        }}
      />
      <JoinDialog workspace={workspace} open={joinOpen} onOpenChange={setJoinOpen} />
    </DetailPage>
  );
}

/** Rename: a one-field prompt, so a small centered dialog. */
function RenameWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: OrganizationWorkspaceAccess;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const directory = useOrganizationDirectory();
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(workspace.name);
    setError(null);
  }, [open, workspace.name]);
  const trimmed = name.trim();
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Rename workspace"
      submitLabel="Rename"
      pendingLabel="Renaming…"
      submitDisabled={trimmed === workspace.name}
      onSubmit={async () => {
        if (!trimmed) {
          setError("Name the workspace.");
          return false;
        }
        await directory.renameWorkspace(workspace, trimmed);
        toast.success(`Renamed ${workspace.name} to ${trimmed}`);
        return true;
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <Field label="Name" error={error ?? undefined}>
        <TextInput
          value={name}
          maxLength={120}
          suppressAutofill
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/* --------------------------------------------------------------- create */

/**
 * The one New workspace flow, from this list or from the workspace picker
 * ("New workspace in Acme"). From the list, a created workspace opens as its
 * page here; from the picker, it opens itself, like switching to it.
 */
function NewWorkspacePage({
  nav,
  returnTo,
  onEnterWorkspace,
}: {
  nav: OrganizationNavigation;
  returnTo?: ReturnTo | undefined;
  onEnterWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
  const navigate = useNavigate();
  const directory = useOrganizationDirectory();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const organizationName = directory.overview.value?.organization.name ?? "your organization";
  return (
    <ModelsFormPage
      title="New workspace"
      description={`A shared space for a team in ${organizationName}. You'll be its workspace admin.`}
      backLabel={returnTo?.label ?? "Workspaces"}
      onClose={() =>
        returnTo ? void navigate({ href: returnTo.path }) : nav.openSection("workspaces")
      }
      submitLabel="Create workspace"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Name the workspace.");
          return false;
        }
        if (
          directory.overview.value?.workspaces.some(
            (workspace) => workspace.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
          )
        ) {
          setError(`There's already a workspace called ${trimmed}.`);
          return false;
        }
        const id = await directory.createWorkspace(trimmed);
        toast.success(`Created ${trimmed}. You're its workspace admin.`);
        if (id && returnTo && onEnterWorkspace) onEnterWorkspace(id);
        else if (id) nav.openWorkspace(id);
        else nav.openSection("workspaces");
        return true;
      }}
    >
      <FieldStack>
        <Field label="Name" error={error ?? undefined}>
          <TextInput
            value={name}
            maxLength={120}
            placeholder="For example: Data science"
            suppressAutofill
            data-autofocus
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </Field>
      </FieldStack>
    </ModelsFormPage>
  );
}
