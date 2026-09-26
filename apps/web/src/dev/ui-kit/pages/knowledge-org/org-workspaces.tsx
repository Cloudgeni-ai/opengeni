import { useState, type ReactNode } from "react";
import { ArrowUpRightIcon, LockKeyholeIcon, PencilIcon, UserPlusIcon } from "lucide-react";
import { toast } from "sonner";

import { AccessList, type AccessMember } from "@/components/ui/access-list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailBody,
  DetailFact,
  DetailFacts,
  DetailFooter,
  DetailHeader,
  DetailInline,
  DetailPage,
  DetailSection,
} from "@/components/ui/detail-sheet";
import { TextInput } from "@/components/ui/field";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
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
   (content-blind admins join explicitly, Q38). The workspace sheet edits
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
  renderInlineDetail,
  matrix,
}: {
  state: "filled" | "just-you" | "loading";
  renderInlineDetail: (workspace: OrgWorkspace) => ReactNode;
  /** Pick C of the access list: people by workspaces under the list. */
  matrix?: ReactNode;
}) {
  const store = useOrg();
  const { picks } = store;
  const inline = picks.detail === "inline" && picks.list !== "table";
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
              onOpen={() => store.openWorkspace(open && inline ? null : workspace.id)}
              expanded={inline ? open : undefined}
              panel={inline && open ? renderInlineDetail(workspace) : undefined}
              indicator={inline ? "expand" : "open"}
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

function RenameFact({ workspace }: { workspace: OrgWorkspace }) {
  const store = useOrg();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!editing) {
    return (
      <DetailFact
        label="Name"
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setName(workspace.name);
              setError(null);
              setEditing(true);
            }}
            className="text-fg-muted pointer-coarse:h-11"
          >
            <PencilIcon aria-hidden="true" />
            Rename
          </Button>
        }
      >
        {workspace.name}
      </DetailFact>
    );
  }
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name the workspace.");
      return;
    }
    if (
      store.workspaces.some(
        (each) =>
          each.id !== workspace.id && each.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
      )
    ) {
      setError(`There's already a workspace called ${trimmed}.`);
      return;
    }
    setSaving(true);
    try {
      await store.renameWorkspace(workspace, trimmed);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <DetailFact label="Name">
      <form
        className="flex min-w-0 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextInput
          value={name}
          aria-label="Workspace name"
          aria-invalid={error ? true : undefined}
          autoFocus
          suppressAutofill
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setEditing(false);
            }
          }}
        />
        {error ? (
          <p role="alert" className="text-xs leading-4.5 text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(false)}
            className="pointer-coarse:h-11"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={saving || name.trim() === workspace.name}
            className="pointer-coarse:h-11"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </DetailFact>
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

function WorkspaceDetailParts({
  workspace,
  onClose,
}: {
  workspace: OrgWorkspace;
  onClose: () => void;
}) {
  const store = useOrg();
  const { picks } = store;
  const members = accessMembers(workspace, store.people, store.local);
  const youHaveAccess = store.local || Boolean(store.you.grants[workspace.id]);
  const variant = picks.access === "matrix" ? "inline" : picks.access;
  return (
    <>
      <DetailHeader
        leading={<LogoTile name={workspace.name} />}
        title={workspace.name}
        subtitle={`Shared · ${workspace.createdLabel} · ${members.length} ${members.length === 1 ? "person" : "people"}`}
      />
      <DetailBody>
        {!youHaveAccess && store.questions.q38 === "join" ? (
          <DetailSection>
            <Notice
              tone="muted"
              icon={<LockKeyholeIcon className="size-4" />}
              title="You can manage who has access, but not open it"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => store.requestJoin(workspace)}
                >
                  Join
                </Button>
              }
              actionLayout="responsive"
            >
              Join to see its chats and files. Its workspace admins will see that you joined.
            </Notice>
          </DetailSection>
        ) : null}
        <DetailSection title="Details">
          <DetailFacts>
            <RenameFact workspace={workspace} />
            <DetailFact label="Description">{workspace.description}</DetailFact>
            <DetailFact label="Workspace ID">
              <CopyField
                value={workspace.id}
                label="workspace ID"
                truncate="middle"
                maxLength={20}
              />
            </DetailFact>
          </DetailFacts>
        </DetailSection>
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
              canvas="surface"
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
      </DetailBody>
      <DetailFooter
        start={
          store.local ? null : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => store.requestDeleteWorkspace(workspace)}
              className="-ml-3 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
            >
              Delete workspace…
            </Button>
          )
        }
      >
        {youHaveAccess ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => toast(`Opening ${workspace.name}`)}
            className="pointer-coarse:h-11"
          >
            Open workspace
            <ArrowUpRightIcon aria-hidden="true" />
          </Button>
        ) : null}
        {picks.detail === "sheet" ? (
          <Button type="button" variant="outline" onClick={onClose} className="pointer-coarse:h-11">
            Done
          </Button>
        ) : null}
      </DetailFooter>
    </>
  );
}

export function WorkspaceDetail({
  workspace,
  presentation,
  onClose,
}: {
  workspace: OrgWorkspace;
  presentation: "sheet" | "page" | "inline";
  onClose: () => void;
}) {
  const parts = <WorkspaceDetailParts key={workspace.id} workspace={workspace} onClose={onClose} />;
  if (presentation === "page") {
    return (
      <DetailPage
        back={{ label: "Workspaces", onClick: onClose }}
        className="px-0 pt-0 max-sm:px-0"
      >
        {parts}
      </DetailPage>
    );
  }
  if (presentation === "inline") return <DetailInline className="mt-2 mb-3">{parts}</DetailInline>;
  return parts;
}
