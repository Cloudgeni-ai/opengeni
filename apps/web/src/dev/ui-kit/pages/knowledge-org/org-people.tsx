import { useId, useState } from "react";
import {
  BotIcon,
  CalendarIcon,
  CopyIcon,
  LockIcon,
  MailIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  UserMinusIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { InlineHelp } from "@/components/ui/inline-help";
import { LineTabs, LineTabsList, LineTabsTrigger } from "@/components/ui/line-tabs";
import {
  ListRow,
  ListRowSkeleton,
  RowList,
  type RowListColumn,
  type RowListSort,
} from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RoleSelect } from "@/components/ui/role-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Toolbar,
  ToolbarFilterMenu,
  ToolbarGroup,
  ToolbarSearch,
  ToolbarSummary,
  type ToolbarFilterValue,
} from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

import { organization, type WorkspaceRole } from "../../fixtures";
import {
  firstName,
  organizationRoleOptions,
  workspaceRoleLabel,
  WORKSPACE_ROLE_OPTIONS,
  type Grant,
  type OrgPerson,
  type OrgWorkspace,
} from "./org-data";
import { personStatusKey, useOrg, type OrgQuestions } from "./org-store";

/* ----------------------------------------------------------------------------
   People: one list for everyone in the organization, invitations included,
   and the person's own page where role and workspace access change.
   -------------------------------------------------------------------------- */

export function PersonAvatar({
  person,
  size = "default",
}: {
  person: OrgPerson;
  size?: "default" | "lg";
}) {
  if (person.kind === "service") {
    return <LogoTile size={size === "lg" ? "lg" : "md"} icon={<BotIcon />} />;
  }
  const pending = person.status === "invited" || person.status === "invite_failed";
  return (
    <Avatar size={size === "lg" ? "lg" : "default"} aria-hidden="true">
      <AvatarFallback
        className={cn(
          "font-semibold",
          size === "lg" ? "text-sm" : "text-xs",
          pending
            ? "border border-dashed border-border-strong bg-transparent text-fg-subtle"
            : "bg-surface-2 text-fg-muted",
        )}
      >
        {person.initials}
      </AvatarFallback>
    </Avatar>
  );
}

function statusLabel(
  person: OrgPerson,
  questions: OrgQuestions,
  suspendedLabel: string,
): string | null {
  const key = personStatusKey(person, questions);
  if (key === "suspended" || key === "paused") return suspendedLabel;
  if (key === "invited" || key === "invite_failed") return person.statusLabel ?? null;
  return null;
}

export function PersonStatus({
  person,
  variant,
}: {
  person: OrgPerson;
  variant: "dot" | "outline" | "tinted";
}) {
  const { questions, vocab } = useOrg();
  const key = personStatusKey(person, questions);
  const label = statusLabel(person, questions, vocab.suspendedLabel);
  if (!key || !label) return null;
  return (
    <StatusBadge variant={variant} status={key}>
      {label}
    </StatusBadge>
  );
}

/** Shared workspaces with a role, sorted by how much the role allows. */
export function grantsOf(person: OrgPerson, workspaces: OrgWorkspace[]) {
  const rank: Record<Grant, number> = { workspace_admin: 0, member: 1, custom: 2, viewer: 3 };
  return workspaces
    .filter((workspace) => person.grants[workspace.id])
    .map((workspace) => ({ workspace, role: person.grants[workspace.id]! }))
    .sort((a, b) => rank[a.role] - rank[b.role]);
}

/** "Design preview · Workspace admin" and a "+2" button that lists the rest. */
function WorkspaceChips({ person }: { person: OrgPerson }) {
  const { workspaces } = useOrg();
  const grants = grantsOf(person, workspaces);
  const [first, ...rest] = grants;
  if (!first) {
    return (
      <span className="text-fg-subtle">{person.kind === "service" ? "None" : "No workspaces"}</span>
    );
  }
  return (
    <span className="relative z-10 flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">
        <span className="text-fg">{first.workspace.name}</span>
        <span className="text-fg-subtle"> · {workspaceRoleLabel(first.role)}</span>
      </span>
      {rest.length > 0 ? (
        <PopoverPrimitive.Root>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label={`Show all ${grants.length} workspaces for ${person.name}`}
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
                {firstName(person)}'s workspaces
              </p>
              <ul className="flex flex-col">
                {grants.map((grant) => (
                  <li
                    key={grant.workspace.id}
                    className="flex min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2"
                  >
                    <LogoTile size="sm" name={grant.workspace.name} />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {grant.workspace.name}
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {workspaceRoleLabel(grant.role)}
                    </span>
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

function RoleCell({ person }: { person: OrgPerson }) {
  const { vocab } = useOrg();
  const label =
    person.kind === "service"
      ? "Service"
      : person.organizationRole === "admin"
        ? vocab.adminLabel
        : person.organizationRole === "owner"
          ? "Owner"
          : "Member";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <span className="truncate text-fg">{label}</span>
      {person.isOnlyOwner ? (
        <span className="text-xs whitespace-nowrap text-fg-subtle">Only owner</span>
      ) : null}
    </span>
  );
}

export function PersonMenuItems({
  person,
  onPage = false,
}: {
  person: OrgPerson;
  /** On the person's own page: leave out "Change role and access". */
  onPage?: boolean;
}) {
  const store = useOrg();
  const key = personStatusKey(person, store.questions);
  if (person.kind === "service") {
    return (
      <DropdownMenuItem onSelect={() => toast("Service accounts are managed in Developer")}>
        <SlidersHorizontalIcon />
        Manage in Developer
      </DropdownMenuItem>
    );
  }
  if (key === "invited" || key === "invite_failed") {
    return (
      <>
        <DropdownMenuItem onSelect={() => store.resendInvite(person)}>
          <MailIcon />
          Resend invitation
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toast("Copied the invitation link")}>
          <CopyIcon />
          Copy invitation link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => store.revokeInvite(person)}>
          <XIcon />
          Revoke invitation
        </DropdownMenuItem>
      </>
    );
  }
  if (key === "suspended" || key === "paused") {
    return (
      <>
        <DropdownMenuItem onSelect={() => store.restoreAccess(person)}>
          <PlayIcon />
          {store.vocab.restoreLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => store.requestRemove(person)}>
          <UserMinusIcon />
          Remove from organization…
        </DropdownMenuItem>
      </>
    );
  }
  return (
    <>
      {onPage ? null : (
        <>
          <DropdownMenuItem onSelect={() => store.openPerson(person.id)}>
            <UserRoundIcon />
            Change role and access
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onSelect={() => store.requestSuspend(person)}>
        <PauseIcon />
        {store.vocab.suspendMenu}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={() => store.requestRemove(person)}>
        <UserMinusIcon />
        Remove from organization…
      </DropdownMenuItem>
    </>
  );
}

/* ----------------------------------------------------------------------------
   The list.
   -------------------------------------------------------------------------- */

type PeopleFilter = "all" | "invited" | "suspended";

// The values explain themselves ("Owner", "Design preview · Member"); tables show headers.
const COLUMNS: RowListColumn[] = [
  { id: "role", label: "Role", width: 128, sortable: true, hideLabel: true },
  { id: "workspaces", label: "Workspaces", width: 248, hideLabel: true },
];

const ROLE_RANK = { owner: 0, admin: 1, member: 2 } as const;

export function PeopleView({ state }: { state: "filled" | "just-you" | "loading" }) {
  const store = useOrg();
  const { picks, vocab, questions } = store;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [menuFilters, setMenuFilters] = useState<ToolbarFilterValue>({});
  const [sort, setSort] = useState<RowListSort>({ column: "name", direction: "asc" });
  const loading = state === "loading";
  const all = state === "just-you" ? store.people.filter((person) => person.isYou) : store.people;
  const humans = all.filter((person) => person.kind === "person");
  const services = all.filter((person) => person.kind === "service");
  const isInvite = (person: OrgPerson) =>
    person.status === "invited" || person.status === "invite_failed";
  const counts = {
    all: humans.length,
    invited: humans.filter(isInvite).length,
    suspended: humans.filter((person) => person.status === "suspended").length,
  };

  const statusFilter: PeopleFilter =
    picks.tabs === "filter-menu"
      ? ((menuFilters.status?.[0] as PeopleFilter | undefined) ?? "all")
      : filter;
  const roleFilter = menuFilters.role ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const matches = (person: OrgPerson) =>
    !needle || `${person.name} ${person.email ?? ""}`.toLocaleLowerCase().includes(needle);

  const direction = sort.direction === "asc" ? 1 : -1;
  const shown = humans
    .filter((person) => {
      if (statusFilter === "invited" && !isInvite(person)) return false;
      if (statusFilter === "suspended" && person.status !== "suspended") return false;
      if (roleFilter.length > 0 && !roleFilter.includes(person.organizationRole)) return false;
      return matches(person);
    })
    .sort((a, b) => {
      if (a.isYou) return -1;
      if (b.isYou) return 1;
      if (sort.column === "role") {
        const diff = ROLE_RANK[a.organizationRole] - ROLE_RANK[b.organizationRole];
        if (diff !== 0) return diff * direction;
      }
      return a.name.localeCompare(b.name) * (sort.column === "name" ? direction : 1);
    });
  const shownServices =
    statusFilter === "all" && roleFilter.length === 0 ? services.filter(matches) : [];

  const columns = picks.list === "catalog" ? undefined : COLUMNS;

  const row = (person: OrgPerson) => {
    const open = store.openPersonId === person.id;
    const status = <PersonStatus person={person} variant={picks.status.row} />;
    const catalog = picks.list === "catalog";
    return (
      <ListRow
        key={person.id}
        leading={<PersonAvatar person={person} />}
        title={person.name}
        titleAddon={person.isYou ? <MetaChip variant="outline">You</MetaChip> : undefined}
        description={person.kind === "service" ? "Service account" : person.email}
        meta={[
          catalog ? <RoleCell key="role" person={person} /> : null,
          personStatusKey(person, questions) ? status : null,
        ].filter(Boolean)}
        cells={
          catalog
            ? undefined
            : { role: <RoleCell person={person} />, workspaces: <WorkspaceChips person={person} /> }
        }
        selected={open}
        onOpen={() => store.openPerson(person.id)}
        menu={person.isYou ? undefined : <PersonMenuItems person={person} />}
        indicator={person.isYou ? "open" : undefined}
      />
    );
  };

  const filterControl =
    picks.tabs === "underline" ? (
      <SegmentedControl<PeopleFilter>
        aria-label="Show"
        variant={picks.segmented}
        options={[
          { value: "all", label: "All", count: counts.all },
          { value: "invited", label: "Invited", count: counts.invited },
          { value: "suspended", label: vocab.suspendedLabel, count: counts.suspended },
        ]}
        value={filter}
        onValueChange={setFilter}
        disabled={loading}
      />
    ) : picks.tabs === "pill" ? (
      <LineTabs value={filter} onValueChange={(value) => setFilter(value as PeopleFilter)}>
        <LineTabsList variant="pill" aria-label="Show" barClassName="border-b-0 pb-0">
          <LineTabsTrigger value="all" count={counts.all}>
            All
          </LineTabsTrigger>
          <LineTabsTrigger value="invited" count={counts.invited}>
            Invited
          </LineTabsTrigger>
          <LineTabsTrigger value="suspended" count={counts.suspended}>
            {vocab.suspendedLabel}
          </LineTabsTrigger>
        </LineTabsList>
      </LineTabs>
    ) : (
      <ToolbarFilterMenu
        groups={[
          {
            id: "status",
            label: "Status",
            options: [
              { id: "invited", label: "Invited", count: counts.invited },
              { id: "suspended", label: vocab.suspendedLabel, count: counts.suspended },
            ],
          },
          {
            id: "role",
            label: "Role",
            options: [
              { id: "owner", label: "Owner" },
              { id: "admin", label: vocab.adminLabel },
              { id: "member", label: "Member" },
            ],
          },
        ]}
        value={menuFilters}
        onValueChange={(next) => {
          // Status is one choice: keep the newest.
          const status = next.status ?? [];
          setMenuFilters({ ...next, status: status.slice(-1) });
        }}
        disabled={loading}
      />
    );

  const listBody = loading ? (
    <RowList variant={picks.list} columns={columns} label={`People in ${organization.name}`} busy>
      <ListRowSkeleton count={5} />
    </RowList>
  ) : shown.length === 0 && shownServices.length === 0 ? (
    <EmptyState
      variant="inline"
      title={needle ? `No one matches "${query.trim()}".` : "No one here yet."}
      action={
        <EmptyStateLink
          onClick={() => {
            setQuery("");
            setFilter("all");
            setMenuFilters({});
          }}
        >
          {needle ? "Clear search" : "Show everyone"}
        </EmptyStateLink>
      }
    />
  ) : (
    <div className="flex min-w-0 flex-col gap-6">
      <RowList
        variant={picks.list}
        columns={columns}
        label={`People in ${organization.name}`}
        nameLabel="Person"
        nameSortable
        sort={sort}
        onSortChange={setSort}
      >
        {shown.map(row)}
      </RowList>
      {state === "just-you" ? (
        <EmptyState
          variant="inline"
          title="Only you so far."
          description="Invite people to share workspaces with them."
          action={<EmptyStateLink onClick={store.openInvite}>{vocab.invite}</EmptyStateLink>}
        />
      ) : null}
      {shownServices.length > 0 ? (
        <section aria-label="Service accounts" className="min-w-0">
          <p className="px-3 pb-1.5 text-xs leading-4.5 font-medium text-fg-subtle">
            Service accounts
          </p>
          <RowList
            variant={picks.list}
            columns={columns}
            label="Service accounts"
            nameLabel="Service account"
          >
            {shownServices.map(row)}
          </RowList>
        </section>
      ) : null}
    </div>
  );

  const filtered = needle || statusFilter !== "all" || roleFilter.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Toolbar>
        <ToolbarSearch
          value={query}
          onValueChange={setQuery}
          placeholder="Search people"
          disabled={loading}
        />
        <ToolbarGroup align={picks.tabs === "filter-menu" ? "end" : "start"}>
          {filterControl}
        </ToolbarGroup>
      </Toolbar>
      {filtered && !loading ? (
        <ToolbarSummary>
          {shown.length} of {counts.all} people
        </ToolbarSummary>
      ) : null}
      {listBody}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The person: role, workspace access, Personal workspace, and the ways out.
   -------------------------------------------------------------------------- */

function WorkspaceAccessRows({ person }: { person: OrgPerson }) {
  const store = useOrg();
  const [saving, setSaving] = useState<string | null>(null);
  const locked =
    person.kind === "service"
      ? "Service accounts get access from their API key, in Developer."
      : store.local
        ? "Single-user mode: you have access to every workspace."
        : person.isYou
          ? "You can't change your own access. Another owner or admin can."
          : undefined;
  return (
    <ul
      aria-label={`${store.vocab.workspaceAccess} for ${person.name}`}
      className="-mx-3 flex min-w-0 flex-col divide-y divide-border"
    >
      {store.workspaces.map((workspace) => {
        const grant = person.grants[workspace.id] ?? null;
        return (
          <li
            key={workspace.id}
            className="grid min-h-14 min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2.5 @[440px]/detail:grid-cols-[2rem_minmax(0,1fr)_auto]"
          >
            <LogoTile size="md" name={workspace.name} />
            <div className="min-w-0">
              <p className="truncate text-sm leading-5 font-medium text-fg">{workspace.name}</p>
              <p className="truncate text-xs leading-4.5 text-fg-muted">{workspace.description}</p>
            </div>
            <div className="col-start-2 flex min-w-0 items-center gap-1 @[440px]/detail:col-start-3">
              <RoleSelect<WorkspaceRole>
                roles={WORKSPACE_ROLE_OPTIONS}
                value={grant}
                noAccessLabel="No access"
                subjectName={person.name}
                aria-label={`${person.name} in ${workspace.name}`}
                disabledReason={locked}
                pending={saving === workspace.id}
                onValueChange={async (role) => {
                  setSaving(workspace.id);
                  try {
                    await store.setGrant(person.id, workspace.id, role);
                  } finally {
                    setSaving(null);
                  }
                }}
                className="w-[11.5rem]"
              />
              {store.questions.q34 === "kept" && grant && !locked ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`More for ${workspace.name}`}
                      className="grid size-8 place-items-center rounded-[10px] text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg pointer-coarse:size-11"
                    >
                      <MoreHorizontalIcon aria-hidden="true" className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem onSelect={() => store.openFineTune(person, workspace)}>
                      <SlidersHorizontalIcon />
                      Fine-tune permissions…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PersonDetailPage({ person, onClose }: { person: OrgPerson; onClose: () => void }) {
  const store = useOrg();
  const { picks, vocab, questions } = store;
  const roleHeadingId = useId();
  const key = personStatusKey(person, questions);
  const invite = key === "invited" || key === "invite_failed";
  const suspended = key === "suspended" || key === "paused";
  const roles = organizationRoleOptions(vocab.adminLabel);
  const roleLabel = roles.find((role) => role.id === person.organizationRole)?.label;
  const roleLocked = person.isOnlyOwner
    ? `${person.isYou ? "You're" : `${firstName(person)} is`} the only owner. Make someone else an owner first.`
    : person.isYou
      ? "You can't change your own role. Ask another owner."
      : person.kind === "service"
        ? "Service accounts are always members."
        : store.local
          ? "Single-user mode has one owner: you."
          : undefined;

  const primary = suspended ? (
    <Button
      type="button"
      onClick={() => store.restoreAccess(person)}
      className="pointer-coarse:h-11"
    >
      {vocab.restoreLabel}
    </Button>
  ) : invite ? (
    <Button
      type="button"
      variant="outline"
      onClick={() => store.resendInvite(person)}
      className="pointer-coarse:h-11"
    >
      <MailIcon aria-hidden="true" />
      Resend invitation
    </Button>
  ) : null;

  const menu = person.isYou ? null : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`More actions for ${person.name}`}
          className="text-fg-muted hover:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <PersonMenuItems person={person} onPage />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const aside = (
    <DetailAside label={`About ${person.name}`}>
      {person.joinedLabel ? (
        <DetailAsideItem label="Joined" icon={<CalendarIcon />}>
          {person.joinedLabel}
        </DetailAsideItem>
      ) : null}
      {person.kind === "service" ? (
        <>
          <DetailAsideItem label="Used by" icon={<BotIcon />}>
            CI pipeline API key
          </DetailAsideItem>
          <DetailAsideItem label="Managed in" icon={<SlidersHorizontalIcon />}>
            Developer
          </DetailAsideItem>
        </>
      ) : (
        <DetailAsideItem label="Personal workspace" icon={<LockIcon />}>
          Private to {person.isYou ? "you" : firstName(person)}. Nobody else can open it, including
          owners and admins.
        </DetailAsideItem>
      )}
    </DetailAside>
  );

  return (
    <DetailPage
      back={{ label: vocab.peopleTitle, onClick: onClose }}
      className="px-0 pt-0 max-sm:px-0"
    >
      <DetailPageHeader
        leading={<PersonAvatar person={person} size="lg" />}
        title={person.name}
        chips={
          <>
            {person.isYou ? <MetaChip variant="outline">You</MetaChip> : null}
            <PersonStatus person={person} variant={picks.status.header} />
          </>
        }
        meta={[
          person.kind === "service" ? "Service account" : person.email,
          roleLabel,
          person.joinedLabel,
        ]}
        actions={
          primary || menu ? (
            <>
              {primary}
              {menu}
            </>
          ) : undefined
        }
      />
      <DetailPageBody aside={aside}>
        {key === "invite_failed" ? (
          <DetailSection>
            <Notice
              tone="failed"
              title="The invitation email bounced"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => store.resendInvite(person)}
                >
                  Resend
                </Button>
              }
              actionLayout="responsive"
            >
              Check that {person.email} is right, then send it again.
            </Notice>
          </DetailSection>
        ) : null}
        {suspended ? (
          <DetailSection>
            <InlineHelp icon>
              {questions.q36 === "pause"
                ? `${firstName(person)} can't sign in. Their workspace access is kept for when you resume it.`
                : `${firstName(person)} can't sign in, and their workspace access was removed.`}
            </InlineHelp>
          </DetailSection>
        ) : null}
        <DetailSection
          title={<span id={roleHeadingId}>Organization role</span>}
          description={
            invite ? "What they can do once they join." : "Saves as soon as you pick one."
          }
        >
          <RoleSelect
            variant="list"
            aria-labelledby={roleHeadingId}
            roles={roles}
            value={person.organizationRole}
            subjectName={person.name}
            disabledReason={roleLocked}
            onValueChange={(role) => (role ? store.setOrganizationRole(person, role) : undefined)}
          />
        </DetailSection>
        <DetailSection
          title={vocab.workspaceAccess}
          description={
            invite
              ? "Where they can work once they join. Saves right away."
              : "One role per shared workspace. Saves right away."
          }
        >
          <WorkspaceAccessRows person={person} />
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}

/** The person's own page ("← People"). Remounts per person. */
export function PersonDetail({ person, onClose }: { person: OrgPerson; onClose: () => void }) {
  return <PersonDetailPage key={person.id} person={person} onClose={onClose} />;
}
