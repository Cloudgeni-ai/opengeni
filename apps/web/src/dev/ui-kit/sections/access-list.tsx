import { useId, useState } from "react";
import { toast } from "sonner";

import {
  AccessList,
  type AccessListProps,
  type AccessMember,
  type AccessScope,
} from "@/components/ui/access-list";
import { Button } from "@/components/ui/button";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailSection } from "@/components/ui/detail-sheet";
import { DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { MetaChip } from "@/components/ui/meta-chip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  RoleSelect,
  roleLabel,
  type RoleOption,
  type RoleValue,
} from "@/components/ui/role-select";
import {
  organizationRoles,
  people,
  personById,
  platformEngineeringAccess,
  workspaces,
  workspaceRoles,
  type AccessEntry,
  type OrganizationRole,
  type Person,
  type WorkspaceRole,
} from "../fixtures";
import {
  Alternative,
  Fork,
  KitBlock,
  KitCanvas,
  KitSection,
  StateCell,
  StatesGrid,
  UsageNotes,
} from "../kit";

/* ----------------------------------------------------------------------------
   Fixtures shaped for the primitive. Role definitions come from the server's
   role catalog fixture, never a local copy.
   -------------------------------------------------------------------------- */

const WORKSPACE = workspaces.find((workspace) => workspace.name === "Platform engineering")!;

const WORKSPACE_ROLES: RoleOption<WorkspaceRole>[] = workspaceRoles.map((role) => ({
  ...role,
  escalation:
    role.id === "workspace_admin"
      ? "They'll be able to change this workspace's settings, integrations and who has access."
      : undefined,
}));

const ORGANIZATION_ROLES: RoleOption<OrganizationRole>[] = organizationRoles.map((role) => ({
  ...role,
  escalation:
    role.id === "owner"
      ? "Owners have full control of Acme Robotics, including billing and recovery. Only another owner can undo this."
      : role.id === "admin"
        ? "Admins manage people, workspaces and shared connections across Acme Robotics."
        : undefined,
}));

function memberFrom(person: Person, role: RoleValue<WorkspaceRole>): AccessMember<WorkspaceRole> {
  const pending = person.status === "invited" || person.status === "invite_failed";
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    initials: person.initials,
    kind: person.kind,
    isYou: person.isYou,
    isOwner: person.organizationRole === "owner",
    status: pending ? person.status : undefined,
    statusLabel: pending ? person.statusLabel : undefined,
    role,
  };
}

function accessMember(entry: AccessEntry): AccessMember<WorkspaceRole> {
  return {
    ...memberFrom(personById(entry.personId), entry.role),
    resetRole: entry.resetToRole,
  };
}

/** Everyone with access to Platform engineering, plus Priya's pending invitation. */
const PLATFORM_ACCESS: AccessMember<WorkspaceRole>[] = [
  ...platformEngineeringAccess.map(accessMember),
  memberFrom(personById("person-priya"), "member"),
];

const SCOPES: AccessScope[] = workspaces.map((workspace) => ({
  id: workspace.id,
  label: workspace.name,
}));

/** People by workspaces, including the legacy custom grant. */
const MATRIX: AccessMember<WorkspaceRole>[] = people
  .filter((person) => person.status !== "suspended" || person.id === "person-tom")
  .map((person) => {
    const grants: Record<string, RoleValue<WorkspaceRole>> = {};
    for (const grant of person.workspaceAccess) grants[grant.workspaceId] = grant.role;
    const custom = platformEngineeringAccess.find(
      (entry) => entry.personId === person.id && entry.role === "custom",
    );
    if (custom) grants[WORKSPACE.id] = "custom";
    return { ...memberFrom(person, null), grants };
  });

const ORG_PEOPLE: AccessMember<OrganizationRole>[] = people
  .filter((person) => person.kind === "person" && person.status === "active")
  .map((person) => ({
    id: person.id,
    name: person.name,
    email: person.email,
    initials: person.initials,
    isYou: person.isYou,
    isOwner: person.organizationRole === "owner",
    tag: person.isOnlyOwner ? "Only owner" : undefined,
    role: person.organizationRole,
    roleLockedReason: person.isOnlyOwner
      ? "You're the only owner. Make someone else an owner first."
      : undefined,
  }));

/* ----------------------------------------------------------------------------
   Stateful demo: saves take a moment, then confirm with a toast and Undo.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "a viewer", "a workspace admin": roles read as nouns inside sentences. */
function asRole(role: WorkspaceRole): string {
  const label = roleLabel(WORKSPACE_ROLES, role).toLowerCase();
  return `${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`;
}

function useAccessDemo(initial: AccessMember<WorkspaceRole>[]) {
  const [members, setMembers] = useState(initial);

  const setRole = (id: string, role: RoleValue<WorkspaceRole>, scopeId?: string) =>
    setMembers((current) =>
      current.map((member) => {
        if (member.id !== id) return member;
        if (scopeId) return { ...member, grants: { ...member.grants, [scopeId]: role } };
        return { ...member, role };
      }),
    );

  const onRoleChange = async (
    member: AccessMember<WorkspaceRole>,
    role: WorkspaceRole | null,
    scopeId?: string,
  ) => {
    const before = scopeId ? (member.grants?.[scopeId] ?? null) : member.role;
    await wait(700);
    setRole(member.id, role, scopeId);
    // The page already names the workspace; only the matrix spans several.
    const where = scopeId ? SCOPES.find((scope) => scope.id === scopeId)?.label : WORKSPACE.name;
    const inScope = scopeId ? ` in ${where}` : "";
    showUndoToast({
      title:
        role === null
          ? `${member.name} no longer has access to ${where}`
          : `${member.name} is now ${asRole(role)}${inScope}`,
      onUndo: () => setRole(member.id, before, scopeId),
    });
  };

  // Removing access is reversible, so it runs at once and offers Undo (brief principle 9).
  const onRemove = (member: AccessMember<WorkspaceRole>) => {
    const index = members.findIndex((each) => each.id === member.id);
    setMembers((current) => current.filter((each) => each.id !== member.id));
    showUndoToast({
      title: `Removed ${member.name} from ${WORKSPACE.name}`,
      onUndo: () =>
        setMembers((current) => [...current.slice(0, index), member, ...current.slice(index)]),
    });
  };

  const onResetToRole = async (member: AccessMember<WorkspaceRole>) => {
    if (!member.resetRole) return;
    await wait(500);
    setRole(member.id, member.resetRole);
    toast(`${member.name} is back to ${asRole(member.resetRole)}`);
  };

  return {
    members,
    onRoleChange,
    onRemove,
    onResetToRole,
    onResendInvite: (member: AccessMember<WorkspaceRole>) =>
      toast(`Sent a new invitation to ${member.email}`),
    onRevokeInvite: onRemove,
  };
}

function InlineDemo() {
  const demo = useAccessDemo(PLATFORM_ACCESS);
  return (
    <AccessList
      label={`People with access to ${WORKSPACE.name}`}
      roles={WORKSPACE_ROLES}
      {...demo}
    />
  );
}

/** B: rows are quiet; the row opens the person's page, where the role changes. */
function TextDemo() {
  const demo = useAccessDemo(PLATFORM_ACCESS);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = demo.members.find((member) => member.id === openId) ?? null;
  const person = open ? personById(open.id) : null;
  const roleHeadingId = useId();
  const back = () => setOpenId(null);
  if (!open || !person) {
    return (
      <AccessList
        variant="text"
        label={`People with access to ${WORKSPACE.name}`}
        roles={WORKSPACE_ROLES}
        members={demo.members}
        onOpen={(member) => setOpenId(member.id)}
      />
    );
  }
  return (
    <DetailPage back={{ label: "Access", onClick: back }} className="px-0 pt-0 pb-0 max-sm:px-0">
      <DetailPageHeader
        leading={
          <Avatar size="lg">
            <AvatarFallback className="bg-surface-2 text-sm font-semibold text-fg-muted">
              {open.initials}
            </AvatarFallback>
          </Avatar>
        }
        title={open.name}
        chips={<MetaChip variant="soft">{roleLabel(WORKSPACE_ROLES, open.role)}</MetaChip>}
        meta={[open.kind === "service" ? "Service account" : open.email, person.joinedLabel]}
        actions={
          open.isYou || open.isOwner ? null : (
            <Button
              type="button"
              variant="outline"
              className="text-danger hover:text-danger pointer-coarse:h-11"
              onClick={() => {
                demo.onRemove(open);
                back();
              }}
            >
              Remove from workspace
            </Button>
          )
        }
      />
      <DetailPageBody>
        <DetailSection
          title={<span id={roleHeadingId}>Role in {WORKSPACE.name}</span>}
          description="Saves as soon as you pick one."
        >
          <RoleSelect
            variant="list"
            aria-labelledby={roleHeadingId}
            roles={WORKSPACE_ROLES}
            value={open.role}
            subjectName={open.name}
            disabledReason={
              open.isYou ? "You can't change your own role. Ask another admin." : undefined
            }
            onValueChange={(role) => demo.onRoleChange(open, role)}
          />
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}

function MatrixDemo() {
  const demo = useAccessDemo(MATRIX);
  return (
    <AccessList
      variant="matrix"
      label="Workspace access for everyone in Acme Robotics"
      roles={WORKSPACE_ROLES}
      scopes={SCOPES}
      noAccessLabel="No access"
      members={demo.members}
      onRoleChange={demo.onRoleChange}
    />
  );
}

/* ----------------------------------------------------------------------------
   The section.
   -------------------------------------------------------------------------- */

const onlyYou = PLATFORM_ACCESS.filter((member) => member.isYou);
const invites: AccessMember<WorkspaceRole>[] = [
  memberFrom(personById("person-priya"), "member"),
  memberFrom(personById("person-aiko"), "viewer"),
];
const custom = PLATFORM_ACCESS.filter((member) => member.role === "custom" || member.isYou);
const longText: AccessMember<WorkspaceRole>[] = [
  {
    id: "long-1",
    name: "Alexandra Konstantinopoulou-Hernández",
    email: "alexandra.konstantinopoulou-hernandez@robotics-research.acme.dev",
    initials: "AK",
    role: "workspace_admin",
  },
  {
    id: "long-2",
    name: "Nightly regression and flaky test triage bot",
    initials: "NR",
    kind: "service",
    role: "member",
  },
];

function StaticList({
  members,
  ...rest
}: Partial<AccessListProps<WorkspaceRole>> & {
  members: AccessMember<WorkspaceRole>[];
}) {
  return (
    <AccessList
      label={`People with access to ${WORKSPACE.name}`}
      roles={WORKSPACE_ROLES}
      members={members}
      onRoleChange={() => wait(900)}
      onRemove={() => undefined}
      onResetToRole={() => wait(600)}
      onResendInvite={() => undefined}
      onRevokeInvite={() => undefined}
      className="flex-1"
      {...rest}
    />
  );
}

function RoleSelectGallery() {
  const [value, setValue] = useState<RoleValue<WorkspaceRole>>("member");
  const [orgValue, setOrgValue] = useState<RoleValue<OrganizationRole>>("member");
  const labelId = useId();
  return (
    <div className="grid min-w-0 gap-6 @3xl/kit-section:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs leading-4.5 font-medium text-fg-muted">In a row (32px)</span>
          <RoleSelect
            roles={WORKSPACE_ROLES}
            value={value}
            subjectName="Jonas Berg"
            onValueChange={(role) => setValue(role)}
            className="w-[12.5rem]"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={labelId} className="text-sm font-medium text-fg">
            Organization role
          </label>
          <RoleSelect
            id={labelId}
            size="md"
            align="start"
            roles={ORGANIZATION_ROLES}
            value={orgValue}
            subjectName="Jonas Berg"
            onValueChange={(role) => setOrgValue(role)}
            className="w-full max-w-80"
          />
          <p className="text-xs leading-4.5 text-fg-subtle">
            In a form (36px). Picking Admin or Owner asks first.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs leading-4.5 font-medium text-fg-muted">Legacy custom grant</span>
          <RoleSelect
            roles={WORKSPACE_ROLES}
            value="custom"
            subjectName="Tom Eriksen"
            className="w-[12.5rem]"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs leading-4.5 font-medium text-fg-muted">
            Disabled with reason
          </span>
          <RoleSelect
            roles={WORKSPACE_ROLES}
            value="workspace_admin"
            subjectName="Bendik Hansen"
            disabledReason="You can't change your own role. Ask another admin."
            className="w-[12.5rem]"
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs leading-4.5 font-medium text-fg-muted">Cell (matrix)</span>
            <div className="w-40">
              <RoleSelect
                variant="cell"
                roles={WORKSPACE_ROLES}
                value={null}
                noAccessLabel="No access"
                align="start"
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs leading-4.5 font-medium text-fg-muted">Text (read-only)</span>
            <RoleSelect variant="text" roles={WORKSPACE_ROLES} value="viewer" />
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs leading-4.5 font-medium text-fg-muted">
          List (person sheet, invite dialog)
        </span>
        <RoleSelect
          variant="list"
          roles={WORKSPACE_ROLES}
          value={value}
          noAccessLabel="No access"
          subjectName="Jonas Berg"
          onValueChange={(role) => setValue(role)}
        />
      </div>
    </div>
  );
}

export default function AccessListSection() {
  return (
    <KitSection sectionKey="access-list">
      <Fork
        layout="stack"
        description={
          <>
            We recommend A: the same rows, verbs and role definitions in all four places. Every
            version shows who has access to {WORKSPACE.name}, with Priya's pending invitation and
            Tom's legacy custom grant.
          </>
        }
      >
        <Alternative id="a">
          <InlineDemo />
        </Alternative>
        <Alternative id="b">
          <TextDemo />
        </Alternative>
        <Alternative id="c">
          <MatrixDemo />
        </Alternative>
      </Fork>

      <StatesGrid
        columns={2}
        description="The recommended inline rows. Roles save as soon as they're picked, with a toast and Undo."
      >
        <StateCell
          label="Saving"
          align="stretch"
          note="The select keeps the new role and shows a spinner until the server answers."
        >
          <StaticList members={PLATFORM_ACCESS.slice(1, 3)} savingIds={["person-maria"]} />
        </StateCell>
        <StateCell label="Read-only" align="stretch">
          <StaticList
            members={PLATFORM_ACCESS.slice(0, 3)}
            readOnlyReason="Only workspace admins can change access. You're a Member here."
          />
        </StateCell>
        <StateCell
          label="Only owner"
          align="stretch"
          note="Organization roles in the person list use the same rows."
        >
          <AccessList
            label="People in Acme Robotics"
            roles={ORGANIZATION_ROLES}
            members={ORG_PEOPLE}
            removeLabel="Remove from organization"
            onRoleChange={() => wait(700)}
            onRemove={() => undefined}
          />
        </StateCell>
        <StateCell
          label="Pending invitations"
          align="stretch"
          note="Invitations are rows too, with Resend and Revoke."
        >
          <StaticList members={invites} />
        </StateCell>
        <StateCell
          label="Custom (set via API)"
          align="stretch"
          note="Legacy hand-picked permissions are shown as they are, with Reset to role."
        >
          <StaticList members={custom} />
        </StateCell>
        <StateCell label="Only you" align="stretch">
          <StaticList
            members={onlyYou}
            emptyMessage="Only you have access. Add people from Acme Robotics to share this workspace."
          />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <StaticList members={[]} loading loadingRows={3} />
        </StateCell>
        <StateCell label="Error" align="stretch">
          <StaticList
            members={[]}
            error={{
              message: `Couldn't load who has access to ${WORKSPACE.name}.`,
              detail: "Check your connection and try again.",
              onRetry: () => undefined,
            }}
          />
        </StateCell>
        <StateCell label="Long text" align="stretch">
          <StaticList members={longText} />
        </StateCell>
        <StateCell label="Mobile 390" width="mobile" align="stretch">
          <StaticList members={PLATFORM_ACCESS} />
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Role select"
        description="The role control inside every access row, the person sheet and the invite dialog. Descriptions come from the server's role catalog."
      >
        <KitCanvas canvas="surface">
          <RoleSelectGallery />
        </KitCanvas>
      </KitBlock>

      <UsageNotes
        use={[
          "Editing who can use a workspace: the Access page, the person sheet, the workspace sheet and the invite dialog",
          "Giving one person one role from the server's role catalog, saved immediately with Undo",
        ]}
        avoid={[
          "Choosing people to add (use a people combobox, then show them here)",
          "Fine-grained permissions (custom grants stay read-only, with Reset to role)",
          "Lists where nobody can change access (use plain rows)",
        ]}
      >
        Vocabulary: organization roles are Owner, Admin and Member; workspace roles are Viewer,
        Member and Workspace admin. "Add people" is for existing members; "Invite people" is for new
        email addresses.
      </UsageNotes>
    </KitSection>
  );
}
