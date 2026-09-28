import { useState, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  HashIcon,
  LockKeyholeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TextIcon,
  Trash2Icon,
  UserPlusIcon,
  UserRoundIcon,
} from "lucide-react";
import { toast } from "sonner";

import { AccessList, type AccessMember } from "@/components/ui/access-list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SelectMenu } from "@/components/ui/select-menu";

import { KIT_NOW, KIT_TIME_ZONE, organization, type WorkspaceRole } from "../../fixtures";
import {
  LOCAL_USER,
  WORKSPACE_ROLE_OPTIONS,
  workspaceRoleLabel,
  type OrgPerson,
  type OrgWorkspace,
} from "./org-data";
import { personStatusKey, useOrg } from "./org-store";

/* ----------------------------------------------------------------------------
   Workspaces: every shared workspace, who is in it, and your own access
   (content-blind admins join explicitly, Q38). The workspace's own page edits
   access with the shared AccessList.
   -------------------------------------------------------------------------- */

export function membersOf(workspace: OrgWorkspace, people: OrgPerson[]): OrgPerson[] {
  return people.filter((person) => person.grants[workspace.id]);
}

function PeopleStack({ members }: { members: OrgPerson[] }) {
  const humans = members.filter((person) => person.kind === "person");
  const shown = humans.slice(0, 3);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* Spans only: on narrow lists this cell folds into the row's meta line (a <p>). */}
      <span aria-hidden="true" className="flex shrink-0 -space-x-1">
        {shown.map((person) => (
          <Avatar key={person.id} size="sm" className="ring-2 ring-bg">
            <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
              {person.initials}
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

function YourAccess({ workspace }: { workspace: OrgWorkspace }) {
  const store = useOrg();
  if (store.local) return <span className="text-fg">Owner</span>;
  const grant = store.you.grants[workspace.id] ?? null;
  if (grant) return <span className="text-fg">{workspaceRoleLabel(grant)}</span>;
  if (store.questions.q38 === "automatic") {
    return <span className="text-fg-muted">Sees everything as owner</span>;
  }
  return (
    <span className="relative z-10 flex min-w-0 items-center gap-2">
      <span className="text-fg-subtle">No access</span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => store.requestJoin(workspace)}
        aria-label={`Join ${workspace.name}`}
        className="h-6 rounded-full px-2.5 pointer-coarse:h-9"
      >
        Join
      </Button>
    </span>
  );
}

const COLUMNS: RowListColumn[] = [
  { id: "people", label: "People", width: 124, hideLabel: true },
  { id: "access", label: "Your access", width: 152 },
  { id: "created", label: "Created", width: 80 },
];

export function WorkspacesView({
  state,
  matrix,
}: {
  state: "filled" | "just-you" | "loading";
  /** Pick C of the access list: people by workspaces under the list. */
  matrix?: ReactNode;
}) {
  const store = useOrg();
  const { picks } = store;
  const columns = picks.list === "catalog" ? undefined : COLUMNS;
  const people = store.local ? [LOCAL_USER] : store.people;

  if (state === "loading") {
    return (
      <RowList variant={picks.list} columns={columns} label="Workspaces" busy>
        <ListRowSkeleton count={4} />
      </RowList>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <RowList
        variant={picks.list}
        columns={columns}
        label={`Workspaces in ${organization.name}`}
        nameLabel="Workspace"
      >
        {store.workspaces.map((workspace) => {
          const members = store.local ? [LOCAL_USER] : membersOf(workspace, people);
          const open = store.openWorkspaceId === workspace.id;
          const created = (
            <RelativeTime
              date={workspace.createdAt}
              now={KIT_NOW}
              timeZone={KIT_TIME_ZONE}
              format="date"
            />
          );
          const catalog = picks.list === "catalog";
          return (
            <ListRow
              key={workspace.id}
              leading={<LogoTile name={workspace.name} />}
              title={workspace.name}
              description={workspace.description}
              meta={
                catalog
                  ? [
                      `${members.length} ${members.length === 1 ? "person" : "people"}`,
                      <YourAccess key="access" workspace={workspace} />,
                    ]
                  : undefined
              }
              cells={
                catalog
                  ? undefined
                  : {
                      people: <PeopleStack members={members} />,
                      access: <YourAccess workspace={workspace} />,
                      created,
                    }
              }
              selected={open}
              onOpen={() => store.openWorkspace(workspace.id)}
              indicator="open"
            />
          );
        })}
      </RowList>
      {matrix}
    </div>
  );
}

/** People by workspaces, for the matrix pick. */
export function AccessMatrix() {
  const store = useOrg();
  const members: AccessMember<WorkspaceRole>[] = store.people
    .filter((person) => personStatusKey(person, store.questions) !== "invited")
    .map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      initials: person.initials,
      kind: person.kind,
      isYou: person.isYou,
      isOwner: person.organizationRole === "owner",
      role: null,
      grants: Object.fromEntries(
        store.workspaces.map((workspace) => [workspace.id, person.grants[workspace.id] ?? null]),
      ),
    }));
  return (
    <section aria-label="Who can use what" className="min-w-0">
      <h2 className="text-sm leading-5 font-semibold text-fg">Who can use what</h2>
      <p className="mt-1 mb-3 text-xs leading-4.5 text-fg-muted">
        Everyone's role in each shared workspace. Changes save right away.
      </p>
      <AccessList
        variant="matrix"
        label={`Workspace access for everyone in ${organization.name}`}
        roles={WORKSPACE_ROLE_OPTIONS}
        scopes={store.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name }))}
        noAccessLabel="No access"
        members={members}
        onRoleChange={(member, role, scopeId) =>
          scopeId ? store.setGrant(member.id, scopeId, role) : undefined
        }
      />
    </section>
  );
}

/* ----------------------------------------------------------------------------
   One workspace.
   -------------------------------------------------------------------------- */

function accessMembers(
  workspace: OrgWorkspace,
  people: OrgPerson[],
  local: boolean,
): AccessMember<WorkspaceRole>[] {
  if (local) {
    return [
      {
        id: LOCAL_USER.id,
        name: LOCAL_USER.name,
        email: LOCAL_USER.email,
        initials: LOCAL_USER.initials,
        isYou: true,
        isOwner: true,
        tag: "Owner",
        role: "workspace_admin",
      },
    ];
  }
  return membersOf(workspace, people).map((person) => {
    const pending = person.status === "invited" || person.status === "invite_failed";
    const grant = person.grants[workspace.id] ?? null;
    return {
      id: person.id,
      name: person.name,
      email: person.email,
      initials: person.initials,
      kind: person.kind,
      isYou: person.isYou,
      isOwner: person.organizationRole === "owner",
      status: pending ? person.status : person.status === "suspended" ? "suspended" : undefined,
      statusLabel: pending
        ? person.statusLabel
        : person.status === "suspended"
          ? "Suspended"
          : undefined,
      role: grant,
      resetRole: grant === "custom" ? "member" : undefined,
    };
  });
}

/** Rename: a one-field prompt, so a small centered dialog. */
function RenameWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: OrgWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const store = useOrg();
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        setName(workspace.name);
        setError(null);
      }}
      size="sm"
      title="Rename workspace"
      submitLabel="Rename"
      pendingLabel="Renaming…"
      submitDisabled={name.trim() === workspace.name}
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Name the workspace.");
          return false;
        }
        if (
          store.workspaces.some(
            (each) =>
              each.id !== workspace.id &&
              each.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
          )
        ) {
          setError(`There's already a workspace called ${trimmed}.`);
          return false;
        }
        await store.renameWorkspace(workspace, trimmed);
        return true;
      }}
    >
      <Field label="Name" error={error ?? undefined}>
        <TextInput
          value={name}
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

function AddPeople({ workspace }: { workspace: OrgWorkspace }) {
  const store = useOrg();
  const candidates = store.people.filter(
    (person) => !person.grants[workspace.id] && person.status !== "suspended",
  );
  const [value, setValue] = useState<string | null>(null);
  if (candidates.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={store.openInvite}
        className="pointer-coarse:h-11"
      >
        <UserPlusIcon aria-hidden="true" />
        {store.vocab.invite}
      </Button>
    );
  }
  return (
    <SelectMenu
      variant="combobox"
      size="sm"
      aria-label={`${store.vocab.addPeople} to ${workspace.name}`}
      placeholder={store.vocab.addPeople}
      searchPlaceholder="Search people"
      value={value}
      options={candidates.map((person) => ({
        value: person.id,
        label: person.name,
        meta: person.email ?? "Service account",
        leading: (
          <Avatar size="sm" aria-hidden="true">
            <AvatarFallback className="bg-surface-2 text-2xs font-semibold text-fg-muted">
              {person.initials}
            </AvatarFallback>
          </Avatar>
        ),
      }))}
      onValueChange={(id) => {
        setValue(id);
        void store.setGrant(id, workspace.id, "member").then(() => setValue(null));
      }}
      showMetaInTrigger={false}
      className="w-44"
    />
  );
}

function WorkspaceDetailPage({
  workspace,
  onClose,
}: {
  workspace: OrgWorkspace;
  onClose: () => void;
}) {
  const store = useOrg();
  const { picks } = store;
  const [renameOpen, setRenameOpen] = useState(false);
  const members = accessMembers(workspace, store.people, store.local);
  const youHaveAccess = store.local || Boolean(store.you.grants[workspace.id]);
  const variant = picks.access === "matrix" ? "inline" : picks.access;
  const peopleLine = `${members.length} ${members.length === 1 ? "person" : "people"}`;

  const aside = (
    <DetailAside label={`About ${workspace.name}`}>
      <DetailAsideItem label="Description" icon={<TextIcon />}>
        {workspace.description}
      </DetailAsideItem>
      <DetailAsideItem label="Your access" icon={<UserRoundIcon />}>
        <YourAccess workspace={workspace} />
      </DetailAsideItem>
      <DetailAsideItem label="Workspace ID" icon={<HashIcon />}>
        <CopyField value={workspace.id} label="workspace ID" truncate="middle" maxLength={20} />
      </DetailAsideItem>
    </DetailAside>
  );

  return (
    <DetailPage back={{ label: "Workspaces", onClick: onClose }} className="px-0 pt-0 max-sm:px-0">
      <DetailPageHeader
        leading={<LogoTile name={workspace.name} />}
        title={workspace.name}
        chips={<MetaChip variant="soft">Shared</MetaChip>}
        meta={[workspace.createdLabel, peopleLine]}
        actions={
          <>
            {youHaveAccess ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => toast(`Opening ${workspace.name}`)}
                className="pointer-coarse:h-11"
              >
                Open workspace
                <ArrowUpRightIcon aria-hidden="true" />
              </Button>
            ) : store.questions.q38 === "join" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => store.requestJoin(workspace)}
                className="pointer-coarse:h-11"
              >
                Join
              </Button>
            ) : null}
            {store.local ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`More actions for ${workspace.name}`}
                    className="text-fg-muted hover:text-fg pointer-coarse:size-11"
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                    <PencilIcon />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => store.requestDeleteWorkspace(workspace)}
                  >
                    <Trash2Icon />
                    Delete workspace…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      <DetailPageBody aside={aside}>
        {!youHaveAccess && store.questions.q38 === "join" ? (
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
            store.local
              ? undefined
              : `People come from ${organization.name}. Roles save right away.`
          }
          action={store.local ? undefined : <AddPeople workspace={workspace} />}
        >
          <div className="-mx-3">
            <AccessList<WorkspaceRole>
              variant={variant}
              label={`People with access to ${workspace.name}`}
              roles={WORKSPACE_ROLE_OPTIONS}
              members={members}
              readOnlyReason={
                store.local ? "Single-user mode: only you use this OpenGeni." : undefined
              }
              onRoleChange={(member, role) => store.setGrant(member.id, workspace.id, role)}
              onResetToRole={(member) =>
                store.setGrant(member.id, workspace.id, member.resetRole ?? "member")
              }
              onRemove={(member) => void store.setGrant(member.id, workspace.id, null)}
              onOpen={(member) => {
                onClose();
                store.openPerson(member.id);
              }}
              onResendInvite={(member) => {
                const person = store.people.find((each) => each.id === member.id);
                if (person) store.resendInvite(person);
              }}
              onRevokeInvite={(member) => {
                const person = store.people.find((each) => each.id === member.id);
                if (person) store.revokeInvite(person);
              }}
            />
          </div>
        </DetailSection>
      </DetailPageBody>
      <RenameWorkspaceDialog workspace={workspace} open={renameOpen} onOpenChange={setRenameOpen} />
    </DetailPage>
  );
}

/** The workspace's own page ("← Workspaces"). Remounts per workspace. */
export function WorkspaceDetail({
  workspace,
  onClose,
}: {
  workspace: OrgWorkspace;
  onClose: () => void;
}) {
  return <WorkspaceDetailPage key={workspace.id} workspace={workspace} onClose={onClose} />;
}
