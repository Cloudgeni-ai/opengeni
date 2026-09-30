import { Link } from "@tanstack/react-router";
import { Building2Icon, LockIcon, PauseIcon, PlusIcon } from "lucide-react";
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { toast } from "sonner";

import { WorkspaceNameDialog } from "@/components/rail/workspace-name-dialog";
import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import {
  organizationLandingWorkspaceId,
  organizationsForSubject,
  shortAccountId,
  workspacesInOrg,
  type OrgOption,
} from "@/lib/org";
import { isPersonalWorkspace, type ManagedSelfContext } from "@/lib/managed-self-context";
import { hasAccountPermission } from "@/lib/permissions";
import { currentPageReturnTo, returnToSearch, type ReturnTo } from "@/lib/return-to";
import { cn } from "@/lib/utils";
import { administersOrganization } from "@/lib/workspaces";
import {
  organizationWorkspacePreferenceStorageId,
  readLastWorkspaceIdsByOrganization,
} from "@/lib/workspace-navigation-preference";
import type { Workspace } from "@/types";

/** The switcher menu's width; surface and rows are the one menu spec (menu-styles.ts). */
export const SWITCHER_MENU_CLASS = "w-72 max-w-[calc(100vw-2rem)]";

function workspaceInitial(workspace: Workspace | null): string {
  return (workspace?.name.trim()[0] ?? "W").toUpperCase();
}

/**
 * A workspace's tile: its initial, or a lock for a Personal workspace, whose
 * chats only its owner can see. The tile says it quietly, so names keep the
 * width a chip would take.
 */
function WorkspaceGlyph({
  workspace,
  personal,
}: {
  workspace: Workspace | null;
  personal: boolean;
}) {
  return personal ? (
    <LockIcon aria-hidden="true" className="size-3.5" />
  ) : (
    <>{workspaceInitial(workspace)}</>
  );
}

export function activeOrganizationLabel(orgs: OrgOption[], activeAccountId: string | null): string {
  if (!activeAccountId) {
    return "Organization";
  }
  return (
    orgs.find((organization) => organization.accountId === activeAccountId)?.label ??
    `Org ${shortAccountId(activeAccountId)}`
  );
}

/** The organization tile: a building, so an organization never reads as a workspace. */
export function OrganizationTile({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-fg-muted",
        className,
      )}
    >
      <Building2Icon className="size-3" />
    </span>
  );
}

/**
 * Whether this person can create workspaces in the organization: the same rule
 * that shows Organization settings > Workspaces, where workspaces are created.
 */
export function useCanCreateWorkspaceIn(accountId: string | null): boolean {
  const context = useAppContext();
  return administersOrganization({
    accessContext: context.accessContext,
    clientConfig: context.clientConfig,
    accountId,
  });
}

/** The last workspace used in each organization, for switching back to it. */
export function useRememberedWorkspaceIds(): Record<string, string> {
  const context = useAppContext();
  return readLastWorkspaceIdsByOrganization(
    organizationWorkspacePreferenceStorageId(context.accessContext.subjectId),
  );
}

/**
 * "New workspace in Acme", by name, for a session that may create workspaces
 * but not administer the organization (a configured deployment key or token).
 * Everyone else creates on Organization settings > Workspaces, the one create
 * flow, so the picker stays a list of places to go.
 */
function CreateWorkspaceHereMenuItem(props: { organizationLabel: string; onCreate: () => void }) {
  return (
    <DropdownMenuItem onSelect={props.onCreate}>
      <PlusIcon />
      <span
        className="min-w-0 flex-1 truncate"
        title={`New workspace in ${props.organizationLabel}`}
      >
        New workspace in {props.organizationLabel}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * "New workspace": the quick path to the one create flow, the organization's
 * New workspace page. Shown only to people who can create there; its back link
 * returns to the page the picker was opened on.
 */
function CreateWorkspaceLinkMenuItem(props: {
  workspaceId: string;
  returnTo?: ReturnTo | undefined;
}) {
  return (
    <DropdownMenuItem asChild>
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId: props.workspaceId }}
        search={{
          section: "workspaces",
          view: "new-workspace",
          ...returnToSearch(props.returnTo),
        }}
      >
        <PlusIcon />
        <span className="min-w-0 flex-1 truncate">New workspace</span>
      </Link>
    </DropdownMenuItem>
  );
}

/** The workspaces of one organization, the current one checked. */
export function WorkspaceMenuItems(props: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  managedSelfContext: ManagedSelfContext | null;
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <>
      {props.workspaces.map((workspace) => (
        <DropdownMenuItem
          key={workspace.id}
          aria-current={workspace.id === props.activeWorkspaceId ? "page" : undefined}
          onSelect={() => {
            if (workspace.id !== props.activeWorkspaceId) props.onSelect(workspace.id);
          }}
        >
          <WorkspaceMenuItemContent
            workspace={workspace}
            activeWorkspaceId={props.activeWorkspaceId}
            managedSelfContext={props.managedSelfContext}
          />
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * The workspace picker at the top of the main rail. It shows the workspace and
 * its organization, lists that organization's workspaces, and, when the person
 * belongs to more than one organization, the others to switch to. Switching
 * organization opens a workspace there. People who can create workspaces get a
 * quiet "New workspace" row that opens the organization's create page; new
 * organizations and organization settings live in the account menu and the
 * settings rail. Callers own where a workspace selection lands.
 */
export function WorkspaceSwitcherMenu(props: {
  workspaceId: string;
  collapsed: boolean;
  align: "start" | "end";
  onSelect: (workspaceId: string) => void;
  className?: string;
  compact?: boolean;
}) {
  const context = useAppContext();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === props.workspaceId) ?? null;
  const activeAccountId =
    activeWorkspace?.accountId ?? context.accessContext.defaultAccountId ?? null;
  const orgs = organizationsForSubject(context.accessContext, context.workspaces);
  const currentOrgLabel = activeOrganizationLabel(orgs, activeAccountId);
  const activeIsPersonal = isPersonalWorkspace(activeWorkspace, context.managedSelfContext);
  const administers = useCanCreateWorkspaceIn(activeAccountId);
  const rememberedWorkspaceIds = useRememberedWorkspaceIds();
  // Owners and admins create on the organization's New workspace page. A
  // session that holds workspace:create without administering the
  // organization (a configured deployment key or token) can't reach that page,
  // so it creates by name here, in the current organization only.
  const createHereAccountId =
    !administers &&
    activeAccountId &&
    hasAccountPermission(context.accessContext, activeAccountId, "workspace:create")
      ? activeAccountId
      : null;
  const [createOpen, setCreateOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitCreate() {
    const name = nameDraft.trim();
    if (!name || busy || !createHereAccountId) return;
    const acceptedTransition = context.captureWorkspaceInvocation(props.workspaceId);
    if (!acceptedTransition) return;
    setBusy(true);
    try {
      const created = await context.createWorkspace({ name, accountId: createHereAccountId });
      if (!created) return;
      if (!context.ownsWorkspaceInvocation(props.workspaceId, acceptedTransition)) return;
      toast.success(`Workspace ${created.name} created`);
      setCreateOpen(false);
      setNameDraft("");
      props.onSelect(created.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <WorkspaceMenu
        collapsed={props.collapsed}
        orgs={orgs}
        workspaces={context.workspaces}
        activeWorkspaceId={props.workspaceId}
        activeAccountId={activeAccountId}
        onCreateHere={createHereAccountId ? () => setCreateOpen(true) : undefined}
        canCreate={administers}
        createReturnTo={currentPageReturnTo(activeWorkspace?.name ?? "Back")}
        rememberedWorkspaceIds={rememberedWorkspaceIds}
        onSelect={props.onSelect}
        managedSelfContext={context.managedSelfContext}
        align={props.align}
      >
        <WorkspaceSwitcherTrigger
          activeWorkspace={activeWorkspace}
          activeOrganizationLabel={currentOrgLabel}
          personal={activeIsPersonal}
          compact={props.compact}
          collapsed={props.collapsed}
          className={props.className}
        />
      </WorkspaceMenu>
      {createHereAccountId ? (
        <WorkspaceNameDialog
          mode={createOpen ? "create" : null}
          name={nameDraft}
          busy={busy}
          onNameChange={setNameDraft}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) setNameDraft("");
          }}
          onSubmit={() => void submitCreate()}
        />
      ) : null}
    </>
  );
}

type WorkspaceSwitcherTriggerProps = {
  compact?: boolean;
  activeWorkspace: Workspace | null;
  activeOrganizationLabel: string;
  personal: boolean;
  collapsed: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

export const WorkspaceSwitcherTrigger = forwardRef<
  HTMLButtonElement,
  WorkspaceSwitcherTriggerProps
>(function WorkspaceSwitcherTrigger(
  {
    activeWorkspace,
    activeOrganizationLabel: organizationLabel,
    personal,
    compact,
    collapsed,
    className,
    ...buttonProps
  },
  ref,
) {
  const workspaceLabel = activeWorkspace?.name ?? (collapsed ? "switch workspace" : "none");
  const accessibleLabel = `${personal ? "Personal workspace, private to you" : "Workspace"}: ${workspaceLabel}, in ${organizationLabel}. Switch workspace or organization`;

  if (collapsed) {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        aria-label={accessibleLabel}
        className={cn(
          "mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface-2/60 text-sm font-semibold text-fg transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none",
          className,
        )}
      >
        <WorkspaceGlyph workspace={activeWorkspace} personal={personal} />
      </button>
    );
  }

  return (
    <ScopeSwitcherTrigger
      {...buttonProps}
      ref={ref}
      aria-label={accessibleLabel}
      className={className}
      compact={compact}
      label={activeWorkspace?.name ?? "Select workspace"}
      meta={personal ? `Private · ${organizationLabel}` : organizationLabel}
      icon={<WorkspaceGlyph workspace={activeWorkspace} personal={personal} />}
    />
  );
});

export function WorkspaceMenu(props: {
  collapsed: boolean;
  orgs: OrgOption[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activeAccountId: string | null;
  /** Create by name in the current organization; see CreateWorkspaceHereMenuItem. */
  onCreateHere?: (() => void) | undefined;
  /** Show the "New workspace" link to the organization's create page. */
  canCreate?: boolean;
  /** Where that page's back link returns. */
  createReturnTo?: ReturnTo | undefined;
  /** The last workspace used in each organization. */
  rememberedWorkspaceIds?: Record<string, string>;
  onSelect: (workspaceId: string) => void;
  managedSelfContext: ManagedSelfContext | null;
  align: "start" | "end";
  children: ReactNode;
}) {
  const currentOrg =
    props.orgs.find((org) => org.accountId === props.activeAccountId) ??
    (props.activeAccountId
      ? {
          accountId: props.activeAccountId,
          label: activeOrganizationLabel(props.orgs, props.activeAccountId),
          canManage: false,
        }
      : null);
  const currentWorkspaces = currentOrg
    ? workspacesInOrg(props.workspaces, currentOrg.accountId)
    : [];
  const otherOrgs = props.orgs
    .filter((org) => org.accountId !== props.activeAccountId)
    .map((org) => ({
      org,
      landing: organizationLandingWorkspaceId(
        props.workspaces,
        org.accountId,
        props.rememberedWorkspaceIds?.[org.accountId],
      ),
    }))
    .filter(({ landing }) => landing !== null);
  const trigger = <DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>;
  return (
    <DropdownMenu>
      {props.collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{trigger}</span>
          </TooltipTrigger>
          <TooltipContent side="right">Switch workspace</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent
        align={props.align}
        className={SWITCHER_MENU_CLASS}
        side={props.collapsed ? "right" : "bottom"}
      >
        {currentOrg ? (
          <DropdownMenuGroup aria-label={`Workspaces in ${currentOrg.label}`}>
            <DropdownMenuLabel className="flex min-w-0 items-center gap-2.5 pt-1.5 pb-1.5">
              <OrganizationTile className="size-7 rounded-md [&_svg]:size-3.5" />
              <span className="grid min-w-0">
                <span
                  className="truncate text-sm leading-5 font-medium text-fg"
                  title={currentOrg.label}
                >
                  {currentOrg.label}
                </span>
                <span className="text-xs leading-4.5 font-normal text-fg-muted">Organization</span>
              </span>
            </DropdownMenuLabel>
            <WorkspaceMenuItems
              workspaces={currentWorkspaces}
              activeWorkspaceId={props.activeWorkspaceId}
              managedSelfContext={props.managedSelfContext}
              onSelect={props.onSelect}
            />
            {props.canCreate ? (
              <CreateWorkspaceLinkMenuItem
                workspaceId={props.activeWorkspaceId}
                returnTo={props.createReturnTo}
              />
            ) : props.onCreateHere ? (
              <CreateWorkspaceHereMenuItem
                organizationLabel={currentOrg.label}
                onCreate={props.onCreateHere}
              />
            ) : null}
          </DropdownMenuGroup>
        ) : null}
        {otherOrgs.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-label="Switch organization">
              <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
              {otherOrgs.map(({ org, landing }) => (
                <DropdownMenuItem
                  key={org.accountId}
                  onSelect={() => {
                    if (landing) props.onSelect(landing);
                  }}
                >
                  <OrganizationTile />
                  <span className="min-w-0 flex-1 truncate" title={org.label}>
                    {org.label}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceMenuItemContent(props: {
  workspace: Workspace;
  activeWorkspaceId: string;
  managedSelfContext: ManagedSelfContext | null;
}) {
  const personal = isPersonalWorkspace(props.workspace, props.managedSelfContext);
  const paused = props.workspace.inferenceControl.state === "paused";
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-2xs font-semibold text-fg-muted [&_svg]:size-3"
      >
        <WorkspaceGlyph workspace={props.workspace} personal={personal} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {props.workspace.name}
        {personal ? (
          <span className="sr-only">, your Personal workspace, private to you</span>
        ) : null}
      </span>
      {paused ? (
        <>
          <PauseIcon aria-hidden="true" className="size-3.5 fill-current text-status-waiting" />
          <span className="sr-only"> Paused</span>
        </>
      ) : null}
      <DropdownMenuCheck checked={props.workspace.id === props.activeWorkspaceId} />
    </>
  );
}
