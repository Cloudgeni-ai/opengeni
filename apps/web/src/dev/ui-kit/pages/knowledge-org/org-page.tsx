import { useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  BlocksIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CreditCardIcon,
  FingerprintIcon,
  LayoutGridIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareStackIcon,
  UserPlusIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { AccessList } from "@/components/ui/access-list";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { PageHeader } from "@/components/ui/page-header";
import { Section, SectionStack } from "@/components/ui/section";
import { SelectMenu } from "@/components/ui/select-menu";
import { SettingRow } from "@/components/ui/setting-row";
import { NavGroup, NavItem, SettingsNav } from "@/components/ui/settings-nav";
import { StatGroup, StatTile } from "@/components/ui/stat-tile";
import { Switch } from "@/components/ui/switch";

import {
  KIT_NOW,
  organization,
  workspaces as fixtureWorkspaces,
  type OrganizationRole,
  type WorkspaceRole,
} from "../../fixtures";
import { KitBlock } from "../../kit";
import { kitHref } from "../../view";
import { PicksLine, PreviewDataToggle, QuestionBar, QuestionToggle } from "./chrome";
import { AppFrame, ContentColumn, ViewFocus, type FrameLayout } from "./frame";
import {
  initialPeople,
  initialWorkspaces,
  LOCAL_USER,
  organizationRoleOptions,
  withArticle,
  workspaceRoleLabel,
  WORKSPACE_ROLE_OPTIONS,
  type OrgPerson,
  type OrgWorkspace,
} from "./org-data";
import {
  FineTunePage,
  InviteForm,
  NewWorkspacePage,
  OrgConfirmDialog,
  type OrgConfirm,
} from "./org-forms";
import { PeopleView, PersonDetail } from "./org-people";
import {
  OrgStoreContext,
  RECOMMENDED_ORG,
  useOrg,
  vocabulary,
  type OrgPageId,
  type OrgQuestions,
  type OrgStore,
} from "./org-store";
import { AccessMatrix, WorkspaceDetail, WorkspacesView, membersOf } from "./org-workspaces";
import { usePagePicks, wait, type PickedKey } from "./picks";

/* ----------------------------------------------------------------------------
   Organization settings (brief section 10, "Organization: people and
   workspaces"): People and Workspaces lists whose rows open their own pages,
   one access editor everywhere, and Invite people, New workspace and
   Fine-tune as pages. Only confirmations and Rename stay small dialogs.
   -------------------------------------------------------------------------- */

type PreviewState = "filled" | "just-you" | "loading";

interface NavEntry {
  id: OrgPageId;
  label: string;
  icon: LucideIcon;
  /** Omitted when it would only restate the page's rows (General). */
  description?: string;
}

const ORG_PICKS: readonly PickedKey[] = [
  "navigation",
  "page-header",
  "tabs-toolbar",
  "list-row",
  "detail-sheet",
  "access-list",
  "choice-cards",
  "form-dialog",
  "destructive-confirm",
  "status-badge",
  "section",
  "setting-row",
  "switch",
];

function navEntries(questions: OrgQuestions, peopleTitle: string, local: boolean): NavEntry[] {
  const all: Array<NavEntry | false> = [
    questions.q33 === "overview" && {
      id: "overview",
      label: "Overview",
      icon: LayoutGridIcon,
      description: `${organization.name} at a glance.`,
    },
    {
      id: "general",
      label: "General",
      icon: SlidersHorizontalIcon,
    },
    !local && {
      id: "people",
      label: peopleTitle,
      icon: UsersIcon,
      description: `Everyone in ${organization.name}, with one role each and a private Personal workspace.`,
    },
    {
      id: "workspaces",
      label: "Workspaces",
      icon: SquareStackIcon,
      description: `Shared workspaces in ${organization.name}. Everyone also has a private Personal workspace.`,
    },
    {
      id: "models",
      label: "Models",
      icon: SparklesIcon,
      description: "Model accounts shared with every workspace.",
    },
    {
      id: "integrations",
      label: "Integrations",
      icon: BlocksIcon,
      description: "Which integrations workspaces may connect.",
    },
    {
      id: "identity",
      label: "Organization identity",
      icon: FingerprintIcon,
      description: "Who you are and what you do, for every agent.",
    },
    {
      id: "billing",
      label: "Billing & usage",
      icon: CreditCardIcon,
      description: "Credits, plan and usage by workspace.",
    },
    {
      id: "developer",
      label: "Developer",
      icon: CodeIcon,
      description: "Organization API keys and the integration guide.",
    },
    {
      id: "security",
      label: "Security & data",
      icon: ShieldCheckIcon,
      description: "Private chats, how long data is kept, and recovery.",
    },
  ];
  return all.filter((entry): entry is NavEntry => Boolean(entry));
}

let invitedCount = 0;

export function OrgPagePreview() {
  const picks = usePagePicks();
  const [questions, setQuestions] = useState<OrgQuestions>(RECOMMENDED_ORG);
  const [previewState, setPreviewState] = useState<PreviewState>("filled");
  const [people, setPeople] = useState<OrgPerson[]>(initialPeople);
  const [workspaces, setWorkspaces] = useState<OrgWorkspace[]>(initialWorkspaces);
  const [page, setPage] = useState<OrgPageId>("people");
  const [mobileIndex, setMobileIndex] = useState(false);
  const [openPersonId, setOpenPersonId] = useState<string | null>(null);
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirm, setConfirm] = useState<OrgConfirm | null>(null);
  const [fineTune, setFineTune] = useState<{ person: OrgPerson; workspace: OrgWorkspace } | null>(
    null,
  );

  const local = questions.q40 === "local";
  const vocab = vocabulary(questions);
  const nav = navEntries(questions, vocab.peopleTitle, local);
  const activePage: OrgPageId = nav.some((entry) => entry.id === page) ? page : "workspaces";
  const entry = nav.find((each) => each.id === activePage)!;
  const you = local ? LOCAL_USER : (people.find((person) => person.isYou) ?? LOCAL_USER);

  const setQuestion = <K extends keyof OrgQuestions>(key: K, value: OrgQuestions[K]) =>
    setQuestions((current) => ({ ...current, [key]: value }));

  const updatePerson = (id: string, patch: (person: OrgPerson) => OrgPerson) =>
    setPeople((current) => current.map((person) => (person.id === id ? patch(person) : person)));

  const openPerson = (id: string | null) => {
    setOpenWorkspaceId(null);
    setInviteOpen(false);
    setNewWorkspaceOpen(false);
    setFineTune(null);
    setOpenPersonId(id);
    if (id) setPage("people");
  };
  const openWorkspace = (id: string | null) => {
    setOpenPersonId(null);
    setInviteOpen(false);
    setNewWorkspaceOpen(false);
    setFineTune(null);
    setOpenWorkspaceId(id);
    if (id) setPage("workspaces");
  };

  const suspend = (person: OrgPerson) => {
    const before = person;
    updatePerson(person.id, (current) => ({
      ...current,
      status: "suspended",
      statusLabel: vocab.suspendedLabel,
      grants: questions.q36 === "pause" ? current.grants : {},
    }));
    if (questions.q36 === "pause") {
      showUndoToast({
        title: `Paused ${person.name}'s access`,
        onUndo: () => updatePerson(person.id, () => before),
      });
    } else {
      toast(`Suspended ${person.name}. Their workspace access was removed.`);
    }
  };

  const store: OrgStore = {
    picks,
    questions,
    vocab,
    local,
    people: local ? [LOCAL_USER] : people,
    workspaces,
    you,
    openPersonId,
    openWorkspaceId,
    openPerson,
    openWorkspace,
    setOrganizationRole: async (person: OrgPerson, role: OrganizationRole) => {
      const before = person.organizationRole;
      await wait(600);
      updatePerson(person.id, (current) => ({ ...current, organizationRole: role }));
      const label = organizationRoleOptions(vocab.adminLabel).find(
        (each) => each.id === role,
      )!.label;
      showUndoToast({
        title: `${person.name} is now ${withArticle(label)}`,
        onUndo: () =>
          updatePerson(person.id, (current) => ({ ...current, organizationRole: before })),
      });
    },
    setGrant: async (personId: string, workspaceId: string, role: WorkspaceRole | null) => {
      const person = people.find((each) => each.id === personId);
      const workspace = workspaces.find((each) => each.id === workspaceId);
      if (!person || !workspace) return;
      const before = person.grants[workspaceId];
      await wait(500);
      const apply = (value: typeof before | null) =>
        updatePerson(personId, (current) => {
          const grants = { ...current.grants };
          if (value) grants[workspaceId] = value;
          else delete grants[workspaceId];
          return { ...current, grants };
        });
      apply(role);
      showUndoToast({
        title:
          role === null
            ? `${person.name} no longer has access to ${workspace.name}`
            : before
              ? `${person.name} is now ${withArticle(workspaceRoleLabel(role))} in ${workspace.name}`
              : `Added ${person.name} to ${workspace.name} as ${withArticle(workspaceRoleLabel(role))}`,
        onUndo: () => apply(before ?? null),
      });
    },
    requestSuspend: (person: OrgPerson) => {
      // Pausing keeps access, so it's reversible: the Undo pick skips the dialog.
      if (picks.destructive === "undo" && questions.q36 === "pause") suspend(person);
      else setConfirm({ kind: "suspend", person });
    },
    requestRemove: (person: OrgPerson) => setConfirm({ kind: "remove", person }),
    restoreAccess: (person: OrgPerson) => {
      updatePerson(person.id, (current) => ({
        ...current,
        status: "active",
        statusLabel: undefined,
      }));
      toast(
        questions.q36 === "pause"
          ? `Resumed ${person.name}'s access, with the same workspaces as before`
          : `Restored ${person.name}. Give workspace access again from their page.`,
      );
    },
    resendInvite: (person: OrgPerson) => {
      updatePerson(person.id, (current) => ({
        ...current,
        status: "invited",
        statusLabel: "Invited · expires in 7 days",
      }));
      toast(`Sent a new invitation to ${person.email ?? person.name}`);
    },
    revokeInvite: (person: OrgPerson) => {
      const index = people.findIndex((each) => each.id === person.id);
      setPeople((current) => current.filter((each) => each.id !== person.id));
      if (openPersonId === person.id) setOpenPersonId(null);
      showUndoToast({
        title: `Revoked the invitation to ${person.email ?? person.name}`,
        onUndo: () =>
          setPeople((current) => [...current.slice(0, index), person, ...current.slice(index)]),
      });
    },
    requestJoin: (workspace: OrgWorkspace) => setConfirm({ kind: "join", workspace }),
    requestDeleteWorkspace: (workspace: OrgWorkspace) =>
      setConfirm({ kind: "delete-workspace", workspace }),
    renameWorkspace: async (workspace: OrgWorkspace, name: string) => {
      await wait(500);
      setWorkspaces((current) =>
        current.map((each) => (each.id === workspace.id ? { ...each, name } : each)),
      );
      toast(`Renamed ${workspace.name} to ${name}`);
    },
    openInvite: () => {
      setOpenPersonId(null);
      setOpenWorkspaceId(null);
      setPage("people");
      setInviteOpen(true);
    },
    openFineTune: (person: OrgPerson, workspace: OrgWorkspace) =>
      setFineTune({ person, workspace }),
  };

  const invite = (
    invites: { email: string; role: OrganizationRole; grants: Record<string, WorkspaceRole> }[],
  ) => {
    const created: OrgPerson[] = invites.map((each) => {
      invitedCount += 1;
      return {
        id: `person-invite-${invitedCount}`,
        name: each.email,
        email: null,
        initials: each.email.slice(0, 2).toUpperCase(),
        kind: "person",
        organizationRole: each.role,
        status: "invited",
        statusLabel: "Invited · expires in 7 days",
        grants: { ...each.grants },
      };
    });
    setPeople((current) => [...current, ...created]);
    toast(
      created.length === 1 ? `Invited ${invites[0]!.email}` : `Invited ${created.length} people`,
    );
  };

  const openPersonRecord = store.people.find((person) => person.id === openPersonId) ?? null;
  const openWorkspaceRecord =
    workspaces.find((workspace) => workspace.id === openWorkspaceId) ?? null;
  const closeDetail = () => {
    setOpenPersonId(null);
    setOpenWorkspaceId(null);
    setFineTune(null);
  };

  const createWorkspace = (name: string, description: string) => {
    const created: OrgWorkspace = {
      id: `ws-new-${Date.now()}`,
      name,
      kind: "shared",
      typeLabel: `Shared · ${organization.name}`,
      description: description || "No description yet.",
      createdLabel: "Created today",
      peopleCount: 1,
      createdAt: KIT_NOW.toISOString(),
    };
    setWorkspaces((current) => [...current, created]);
    updatePerson(you.id, (current) => ({
      ...current,
      grants: { ...current.grants, [created.id]: "workspace_admin" },
    }));
    setNewWorkspaceOpen(false);
    toast(`Created ${name}. You're its workspace admin.`);
    openWorkspace(created.id);
  };

  const navigate = (id: OrgPageId) => {
    setPage(id);
    setMobileIndex(false);
    closeDetail();
    setInviteOpen(false);
    setNewWorkspaceOpen(false);
  };

  const headerAction =
    activePage === "people" ? (
      <Button
        type="button"
        onClick={store.openInvite}
        disabled={previewState === "loading"}
        className="pointer-coarse:h-11"
      >
        <UserPlusIcon aria-hidden="true" />
        {vocab.invite}
      </Button>
    ) : activePage === "workspaces" && !local ? (
      <Button
        type="button"
        onClick={() => {
          closeDetail();
          setNewWorkspaceOpen(true);
        }}
        disabled={previewState === "loading"}
        className="pointer-coarse:h-11"
      >
        <PlusIcon aria-hidden="true" />
        New workspace
      </Button>
    ) : null;

  const pageBody = (): ReactNode => {
    if (activePage === "people") {
      return <PeopleView state={previewState} />;
    }
    if (activePage === "workspaces") {
      return (
        <WorkspacesView
          state={previewState}
          matrix={picks.access === "matrix" && !local ? <AccessMatrix /> : undefined}
        />
      );
    }
    if (activePage === "general") return <GeneralBody onRename={() => setRenameOpen(true)} />;
    if (activePage === "security") return <SecurityBody />;
    if (activePage === "overview") return <OverviewBody />;
    return (
      <EmptyState
        variant="inline"
        title="Not part of this preview."
        description={
          activePage === "models"
            ? "Organization models share the workspace Models page and its account pages."
            : "This preview covers People, Workspaces, General and Security & data."
        }
        action={
          activePage === "models" ? (
            <a
              href={kitHref({ section: "page-models" })}
              className="text-sm font-medium text-brand underline-offset-4 hover:underline"
            >
              Open the Models preview
            </a>
          ) : undefined
        }
      />
    );
  };

  /* ------------------------------------------------------------ navigation */

  const navItem = (
    each: NavEntry,
    options: { icon?: boolean; size?: "default" | "comfortable"; chevron?: boolean } = {},
  ) => {
    const Icon = each.icon;
    return (
      <NavItem
        key={each.id}
        href={`#organization-${each.id}`}
        onClick={(event) => {
          event.preventDefault();
          navigate(each.id);
        }}
        icon={options.icon ? <Icon /> : undefined}
        label={each.label}
        active={activePage === each.id && !mobileIndex}
        size={options.size}
        trailingIcon={options.chevron ? <ChevronRightIcon /> : undefined}
        className={options.chevron ? "h-11" : undefined}
      />
    );
  };

  const navHeader = (
    <div className="min-w-0 px-2.5">
      <p className="text-xs leading-4.5 font-medium text-fg-subtle">Organization</p>
      <p className="truncate text-sm leading-5 font-semibold text-fg">{organization.name}</p>
    </div>
  );

  const workspaceLink = (size?: "default" | "comfortable") => (
    <NavGroup label="Workspace settings">
      <NavItem
        href="#workspace-settings"
        onClick={(event) => event.preventDefault()}
        icon={<ArrowLeftIcon />}
        label={fixtureWorkspaces[0]!.name}
        size={size}
      />
    </NavGroup>
  );

  const railNav =
    picks.navigation === "rail" ? (
      <SettingsNav
        variant="rail"
        aria-label="Organization settings"
        className="h-full"
        header={
          <div className="flex flex-col gap-3">
            <NavItem
              href="#back"
              onClick={(event) => event.preventDefault()}
              icon={<ChevronLeftIcon />}
              label="Back to chats"
              size="comfortable"
            />
            {navHeader}
          </div>
        }
        footer={workspaceLink("comfortable")}
      >
        <NavGroup>{nav.map((each) => navItem(each, { icon: true, size: "comfortable" }))}</NavGroup>
      </SettingsNav>
    ) : undefined;

  const pageHeader = (layout: FrameLayout) => {
    const Icon = entry.icon;
    const tabs =
      picks.navigation === "tabs" ? (
        <LineTabsNav aria-label="Organization settings" variant={picks.tabVariant}>
          {nav.map((each) => (
            <LineTabsLink
              key={each.id}
              href={`#organization-${each.id}`}
              active={activePage === each.id}
              onClick={(event) => {
                event.preventDefault();
                navigate(each.id);
              }}
            >
              {each.label}
            </LineTabsLink>
          ))}
        </LineTabsNav>
      ) : undefined;
    const context =
      picks.navigation === "tabs" ? (
        <span>Organization · {organization.name}</span>
      ) : layout === "narrow" && picks.navigation === "column" ? (
        <button
          type="button"
          onClick={() => setMobileIndex(true)}
          className="-ml-0.5 inline-flex items-center gap-0.5 rounded-[6px] transition-colors hover:text-fg pointer-coarse:min-h-11"
        >
          <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
          Organization
        </button>
      ) : undefined;
    return (
      <PageHeader
        variant={picks.header.variant}
        showIcon={picks.header.settingsIcon}
        icon={<Icon />}
        context={context}
        title={entry.label}
        description={entry.description}
        actions={headerAction}
        tabs={tabs}
      />
    );
  };

  const pageColumn = (layout: FrameLayout) => {
    // Form pages bring their own page padding; cancel the column's so the back
    // link lines up with the other pages.
    const formPage = (node: ReactNode) => (
      <div className="-mx-4 -mt-6 flex min-w-0 flex-col @[640px]/main:-mx-8">{node}</div>
    );
    if (fineTune) {
      return formPage(
        <FineTunePage
          person={fineTune.person}
          workspace={fineTune.workspace}
          onClose={() => setFineTune(null)}
        />,
      );
    }
    if (inviteOpen && activePage === "people") {
      return formPage(<InviteForm onClose={() => setInviteOpen(false)} onInvite={invite} />);
    }
    if (newWorkspaceOpen && activePage === "workspaces") {
      return formPage(
        <NewWorkspacePage onClose={() => setNewWorkspaceOpen(false)} onCreate={createWorkspace} />,
      );
    }
    if (openPersonRecord && activePage === "people") {
      return <PersonDetail person={openPersonRecord} onClose={closeDetail} />;
    }
    if (openWorkspaceRecord && activePage === "workspaces") {
      return <WorkspaceDetail workspace={openWorkspaceRecord} onClose={closeDetail} />;
    }
    return (
      <>
        {pageHeader(layout)}
        <div className="mt-6 min-w-0">{pageBody()}</div>
      </>
    );
  };

  const content = (layout: FrameLayout) => {
    if (layout === "narrow" && picks.navigation === "column" && mobileIndex) {
      return (
        <ContentColumn>
          <PageHeader
            title="Organization"
            context={organization.name}
            variant={picks.header.variant}
          />
          <nav aria-label="Organization settings" className="-mx-2.5 mt-4">
            <NavGroup>{nav.map((each) => navItem(each, { chevron: true }))}</NavGroup>
          </nav>
        </ContentColumn>
      );
    }
    if (picks.navigation === "column" && layout !== "narrow") {
      return (
        <ContentColumn>
          <div className="flex min-w-0 items-start gap-10">
            <SettingsNav
              aria-label="Organization settings"
              header={navHeader}
              footer={workspaceLink()}
              className="sticky top-6"
            >
              <NavGroup>{nav.map((each) => navItem(each))}</NavGroup>
            </SettingsNav>
            <div className="min-w-0 flex-1">{pageColumn(layout)}</div>
          </div>
        </ContentColumn>
      );
    }
    return <ContentColumn>{pageColumn(layout)}</ContentColumn>;
  };

  const viewKey = [
    activePage,
    mobileIndex ? "index" : "",
    openPersonId ?? "",
    openWorkspaceId ?? "",
    inviteOpen ? "invite" : "",
    newWorkspaceOpen ? "new-workspace" : "",
    fineTune ? `fine-tune:${fineTune.person.id}:${fineTune.workspace.id}` : "",
  ].join("|");

  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- rebuilt on every state change by design; the whole preview re-renders with it
    <OrgStoreContext.Provider value={store}>
      <div className="flex min-w-0 flex-col gap-8">
        <KitBlock
          title="Try it"
          description="Open a person and change a role or workspace access, pause someone and undo it, remove someone, invite a few addresses (try lena@acme.dev), open Workspaces and join Hardware lab. Everything is local to this preview."
        >
          <div className="flex min-w-0 flex-col gap-5">
            <QuestionBar
              total={8}
              changed={
                (Object.keys(RECOMMENDED_ORG) as Array<keyof OrgQuestions>).filter(
                  (key) => questions[key] !== RECOMMENDED_ORG[key],
                ).length
              }
              description="Bendik hasn't answered these yet. Flip one to see the other answer in the page."
            >
              <QuestionToggle
                id="Q33"
                question="People and Workspaces replace Overview"
                options={[
                  { value: "tables", label: "Yes" },
                  { value: "overview", label: "Keep Overview" },
                ]}
                value={questions.q33}
                recommended="tables"
                onChange={(value) => {
                  setQuestion("q33", value);
                  if (value === "overview") navigate("overview");
                }}
              />
              <QuestionToggle
                id="Q34"
                question="Roles only; Fine-tune leaves the main flows"
                options={[
                  { value: "removed", label: "Yes" },
                  { value: "kept", label: "Keep Fine-tune" },
                ]}
                value={questions.q34}
                recommended="removed"
                onChange={(value) => setQuestion("q34", value)}
              />
              <QuestionToggle
                id="Q35"
                question="People, Admin and Invite people (new words)"
                options={[
                  { value: "new", label: "New words" },
                  { value: "today", label: "Today's words" },
                ]}
                value={questions.q35}
                recommended="new"
                onChange={(value) => setQuestion("q35", value)}
              />
              <QuestionToggle
                id="Q36"
                question="Pausing keeps workspace access"
                options={[
                  { value: "pause", label: "Real pause" },
                  { value: "suspend", label: "Suspend removes it" },
                ]}
                value={questions.q36}
                recommended="pause"
                onChange={(value) => setQuestion("q36", value)}
              />
              <QuestionToggle
                id="Q37"
                question="Removed people can be invited again"
                options={[
                  { value: "allowed", label: "Yes" },
                  { value: "never", label: "Never" },
                ]}
                value={questions.q37}
                recommended="allowed"
                onChange={(value) => setQuestion("q37", value)}
              />
              <QuestionToggle
                id="Q38"
                question="Admins join a workspace to see its content"
                options={[
                  { value: "join", label: "Join first" },
                  { value: "automatic", label: "See everything" },
                ]}
                value={questions.q38}
                recommended="join"
                onChange={(value) => setQuestion("q38", value)}
              />
              <QuestionToggle
                id="Q39"
                question="Invitations pick a role per workspace"
                options={[
                  { value: "per-workspace", label: "Per workspace" },
                  { value: "member-only", label: "Member only" },
                ]}
                value={questions.q39}
                recommended="per-workspace"
                onChange={(value) => setQuestion("q39", value)}
              />
              <QuestionToggle
                id="Q40"
                question="Single-user mode hides People and shows you as Owner"
                options={[
                  { value: "organization", label: "Organization" },
                  { value: "local", label: "Single-user" },
                ]}
                value={questions.q40}
                recommended="organization"
                note={
                  questions.q40 === "local"
                    ? "Showing single-user mode, with the recommendation"
                    : "Switch to see single-user mode"
                }
                onChange={(value) => {
                  setQuestion("q40", value);
                  closeDetail();
                }}
              />
            </QuestionBar>
            <div className="flex min-w-0 flex-col gap-3 @4xl/kit-section:flex-row @4xl/kit-section:items-start @4xl/kit-section:justify-between @4xl/kit-section:gap-8">
              <PicksLine picks={picks} keys={ORG_PICKS} />
              <PreviewDataToggle
                options={[
                  { value: "filled", label: "People" },
                  { value: "just-you", label: "Just you" },
                  { value: "loading", label: "Loading" },
                ]}
                value={previewState}
                onChange={setPreviewState}
              />
            </div>
          </div>
        </KitBlock>

        <AppFrame
          label="Organization settings"
          active="settings"
          workspaceName={fixtureWorkspaces[0]!.name}
          knowledgeAttention={3}
          rail={railNav}
          mobileTitle="Organization"
        >
          {(layout) => <ViewFocus viewKey={viewKey}>{content(layout)}</ViewFocus>}
        </AppFrame>

        <OrgConfirmDialog
          confirm={confirm}
          onClose={() => setConfirm(null)}
          onSuspend={suspend}
          onRemove={(person) => {
            setPeople((current) => current.filter((each) => each.id !== person.id));
            closeDetail();
            toast(`Removed ${person.name} from ${organization.name}`);
          }}
          onDeleteWorkspace={(workspace) => {
            setWorkspaces((current) => current.filter((each) => each.id !== workspace.id));
            setPeople((current) =>
              current.map((person) => {
                const grants = { ...person.grants };
                delete grants[workspace.id];
                return { ...person, grants };
              }),
            );
            closeDetail();
            toast(`Deleted ${workspace.name}`);
          }}
          onJoin={(workspace) => {
            updatePerson(you.id, (current) => ({
              ...current,
              grants: { ...current.grants, [workspace.id]: "workspace_admin" },
            }));
            toast(`You joined ${workspace.name} as a workspace admin`);
          }}
        />
        <RenameOrganizationDialog open={renameOpen} onOpenChange={setRenameOpen} />
      </div>
    </OrgStoreContext.Provider>
  );
}

/* ----------------------------------------------------------------------------
   The smaller pages.
   -------------------------------------------------------------------------- */

/** Name (value + Rename) and Organization ID (value + copy); the page title names them. */
function GeneralBody({ onRename }: { onRename: () => void }) {
  const { picks, local } = useOrg();
  return (
    <SectionStack variant={picks.section}>
      <Section aria-label="Organization">
        <SettingRow
          variant={picks.settingRow}
          label="Name"
          description={
            <span className="mt-0.5 block text-sm leading-5 break-words text-fg">
              {local ? "Local" : organization.name}
            </span>
          }
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRename}
              className="pointer-coarse:h-11"
            >
              <PencilIcon aria-hidden="true" />
              Rename
            </Button>
          }
        />
        <SettingRow
          variant={picks.settingRow}
          label="Organization ID"
          description={
            <span className="mt-0.5 flex min-w-0">
              <CopyField value={organization.id} label="organization ID" truncate="middle" />
            </span>
          }
        />
      </Section>
    </SectionStack>
  );
}

function SecurityBody() {
  const { picks, local } = useOrg();
  const [onlyMe, setOnlyMe] = useState(true);
  const [pending, setPending] = useState(false);
  const [retention, setRetention] = useState("forever");
  return (
    <SectionStack variant={picks.section}>
      <Section title="Chats">
        <SettingRow
          variant={picks.settingRow}
          label="Only me chats"
          description="Let people start chats only they can see, in shared workspaces."
          control={
            <Switch
              variant={picks.switch.variant}
              showStateText={picks.switch.showStateText}
              checked={onlyMe}
              pending={pending}
              onCheckedChange={async (next) => {
                setPending(true);
                await wait(500);
                setOnlyMe(next);
                setPending(false);
                toast(
                  next ? "People can start Only me chats" : "Only me chats are off for new chats",
                );
              }}
            />
          }
        />
      </Section>
      <Section
        title="Retention"
        description="How long chats and files stay after their last activity."
      >
        <SettingRow
          variant={picks.settingRow}
          label="Keep chats and files"
          description={
            retention === "forever"
              ? "Nothing is deleted automatically."
              : `Deleted ${retention === "365" ? "a year" : "90 days"} after their last activity.`
          }
          controlWidth="select"
          control={
            <SelectMenu
              variant={picks.select}
              size="sm"
              value={retention}
              onValueChange={(value) => {
                setRetention(value);
                toast("Saved the retention policy");
              }}
              options={[
                { value: "forever", label: "Forever" },
                { value: "365", label: "1 year" },
                { value: "90", label: "90 days" },
              ]}
              className="w-full"
              searchPlaceholder="Search"
            />
          }
        />
      </Section>
      {local ? null : (
        <Section
          title={
            <span className="inline-flex items-center gap-2">
              Recovery <MetaChip variant="outline">Owners only</MetaChip>
            </span>
          }
          description={`If every owner loses access, a recovery code gets ${organization.name} back.`}
        >
          <SettingRow
            variant={picks.settingRow}
            label="Recovery codes"
            description="Not set up yet."
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => toast("Recovery setup opens here")}
                className="pointer-coarse:h-11"
              >
                Set up
              </Button>
            }
          />
        </Section>
      )}
    </SectionStack>
  );
}

/** Q33, the other answer: today's Overview, rebuilt with the new parts. */
function OverviewBody() {
  const store = useOrg();
  const [expanded, setExpanded] = useState<string | null>(null);
  const humans = store.people.filter((person) => person.kind === "person");
  const invited = humans.filter(
    (person) => person.status === "invited" || person.status === "invite_failed",
  );
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <StatGroup columns={3} label="Organization at a glance">
        <StatTile
          label="People"
          value={String(humans.length)}
          caption={`${invited.length} invited`}
        />
        <StatTile
          label="Shared workspaces"
          value={String(store.workspaces.length)}
          caption="Plus one Personal each"
        />
        <StatTile label="Your role" value="Owner" caption="Only owner" />
      </StatGroup>
      <Section
        title="Workspaces and access"
        description="Today's accordion: open a workspace to edit who has access."
      >
        <RowList label="Workspaces and access">
          {store.workspaces.map((workspace) => {
            const members = membersOf(workspace, store.people);
            const open = expanded === workspace.id;
            return (
              <ListRow
                key={workspace.id}
                leading={<LogoTile name={workspace.name} />}
                title={workspace.name}
                meta={[`${members.length} ${members.length === 1 ? "person" : "people"}`]}
                expanded={open}
                indicator="expand"
                onOpen={() => setExpanded(open ? null : workspace.id)}
                panel={
                  open ? (
                    <div className="mt-2 mb-3 rounded-[14px] border border-border bg-surface py-1">
                      <AccessList<WorkspaceRole>
                        label={`People with access to ${workspace.name}`}
                        roles={WORKSPACE_ROLE_OPTIONS}
                        canvas="surface"
                        members={members.map((person) => ({
                          id: person.id,
                          name: person.name,
                          email: person.email,
                          initials: person.initials,
                          kind: person.kind,
                          isYou: person.isYou,
                          isOwner: person.organizationRole === "owner",
                          role: person.grants[workspace.id] ?? null,
                          resetRole:
                            person.grants[workspace.id] === "custom" ? "member" : undefined,
                        }))}
                        onRoleChange={(member, role) =>
                          store.setGrant(member.id, workspace.id, role)
                        }
                        onRemove={(member) => void store.setGrant(member.id, workspace.id, null)}
                      />
                    </div>
                  ) : undefined
                }
              />
            );
          })}
        </RowList>
      </Section>
    </div>
  );
}

function RenameOrganizationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(organization.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setName(organization.name);
          setError(null);
        }
      }}
      size="sm"
      title="Rename organization"
      description="Everyone in the organization sees the new name right away."
      submitLabel="Rename"
      pendingLabel="Renaming…"
      onSubmit={async () => {
        if (!name.trim()) {
          setError("Name the organization.");
          return false;
        }
        await wait(600);
        toast(`Renamed to ${name.trim()}`);
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
