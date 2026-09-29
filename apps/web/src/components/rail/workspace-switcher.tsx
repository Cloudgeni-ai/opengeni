import { Link } from "@tanstack/react-router";
import {
  Building2Icon,
  CheckIcon,
  PauseIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { ScopeSwitcherTrigger } from "@/components/ui/scope-switcher-trigger";
import {
  DropdownMenu,
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
import { currentPageReturnTo, returnToSearch, type ReturnTo } from "@/lib/return-to";
import { cn } from "@/lib/utils";
import { administersOrganization } from "@/lib/workspaces";
import {
  organizationWorkspacePreferenceStorageId,
  readLastWorkspaceIdsByOrganization,
} from "@/lib/workspace-navigation-preference";
import type { Workspace } from "@/types";

/** Menus in the switchers: 16px radius, shadow-md, 14/500 rows. */
export const SWITCHER_MENU_CLASS = "w-72 max-w-[calc(100vw-2rem)] rounded-[16px] p-1.5";
export const SWITCHER_MENU_ITEM_CLASS = "min-h-8 pointer-coarse:min-h-11";
export const SWITCHER_MENU_LABEL_CLASS =
  "px-2 pt-1.5 pb-1 text-xs leading-4.5 font-medium text-fg-subtle";

function workspaceInitial(workspace: Workspace | null): string {
  return (workspace?.name.trim()[0] ?? "W").toUpperCase();
}

/**
 * A workspace's tile: its initial, or a person for a Personal workspace. The
 * tile says "personal" quietly, so names keep the width a chip would take.
 */
function WorkspaceGlyph({
  workspace,
  personal,
}: {
  workspace: Workspace | null;
  personal: boolean;
}) {
  return personal ? (
    <UserIcon aria-hidden="true" className="size-3.5" />
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
        "flex size-5 shrink-0 items-center justify-center rounded bg-surface-3 text-fg-muted",
        className,
      )}
    >
      <Building2Icon className="size-3.5" />
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
 * "New workspace in Acme": the create action always names the organization it
 * creates in, and opens that organization's New workspace page (the one create
 * flow, also reached from Organization settings > Workspaces). Its back link
 * returns here. Without permission there, it says so instead.
 */
export function CreateWorkspaceMenuItem(props: {
  organizationLabel: string;
  canCreate: boolean;
  /** A workspace of that organization, to open its organization settings through. */
  workspaceId: string;
  /** Where the page's back link returns: the page the menu was opened on. */
  returnTo?: ReturnTo | undefined;
}) {
  if (!props.canCreate) {
    return (
      // Readable, not faded: the reason is the point of showing it.
      <DropdownMenuItem
        disabled
        className={cn(SWITCHER_MENU_ITEM_CLASS, "items-start data-[disabled]:opacity-100")}
      >
        <PlusIcon className="mt-0.5 size-4 text-fg-subtle" />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-fg-subtle">
            New workspace in {props.organizationLabel}
          </span>
          <span className="text-xs leading-4.5 text-fg-muted">
            Only owners and admins can create workspaces here.
          </span>
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem asChild className={SWITCHER_MENU_ITEM_CLASS}>
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId: props.workspaceId }}
        search={{
          section: "workspaces",
          view: "new-workspace",
          ...returnToSearch(props.returnTo),
        }}
      >
        <PlusIcon className="size-4" />
        <span
          className="min-w-0 flex-1 truncate"
          title={`New workspace in ${props.organizationLabel}`}
        >
          New workspace in {props.organizationLabel}
        </span>
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
          className={SWITCHER_MENU_ITEM_CLASS}
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
 * its organization, lists that organization's workspaces with a create action
 * that names the organization, links to organization settings, and lists the
 * other organizations to switch to. Switching organization opens a workspace
 * there. Callers own where a workspace selection lands.
 */
export function WorkspaceSwitcherMenu(props: {
  workspaceId: string;
  collapsed: boolean;
  align: "start" | "end";
  onSelect: (workspaceId: string) => void;
  onCreateOrganization?: () => void;
  className?: string;
  compact?: boolean;
  /** What New workspace's back link says; defaults to the workspace name. */
  createReturnLabel?: string;
}) {
  const context = useAppContext();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === props.workspaceId) ?? null;
  const activeAccountId =
    activeWorkspace?.accountId ?? context.accessContext.defaultAccountId ?? null;
  const orgs = organizationsForSubject(context.accessContext, context.workspaces);
  const currentOrgLabel = activeOrganizationLabel(orgs, activeAccountId);
  const activeIsPersonal = isPersonalWorkspace(activeWorkspace, context.managedSelfContext);
  const canCreate = useCanCreateWorkspaceIn(activeAccountId);
  const rememberedWorkspaceIds = useRememberedWorkspaceIds();

  return (
    <>
      <WorkspaceMenu
        collapsed={props.collapsed}
        orgs={orgs}
        workspaces={context.workspaces}
        activeWorkspaceId={props.workspaceId}
        activeAccountId={activeAccountId}
        canCreate={canCreate}
        createReturnTo={currentPageReturnTo(
          props.createReturnLabel ?? activeWorkspace?.name ?? "Back",
        )}
        rememberedWorkspaceIds={rememberedWorkspaceIds}
        onSelect={props.onSelect}
        onCreateOrganization={props.onCreateOrganization}
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
  const accessibleLabel = `${personal ? "Personal workspace" : "Workspace"}: ${workspaceLabel}, in ${organizationLabel}. Switch workspace or organization`;

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
      meta={personal ? `Personal · ${organizationLabel}` : organizationLabel}
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
  canCreate: boolean;
  /** Where New workspace's back link returns. */
  createReturnTo?: ReturnTo | undefined;
  /** The last workspace used in each organization. */
  rememberedWorkspaceIds?: Record<string, string>;
  onSelect: (workspaceId: string) => void;
  onCreateOrganization?: () => void;
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
            <DropdownMenuLabel className="flex min-w-0 items-center gap-2 px-2 pt-1.5 pb-2">
              <OrganizationTile className="size-7 rounded-md" />
              <span className="grid min-w-0">
                <span
                  className="truncate text-sm leading-5 font-semibold text-fg"
                  title={currentOrg.label}
                >
                  {currentOrg.label}
                </span>
                <span className="text-xs leading-4.5 font-normal text-fg-subtle">Organization</span>
              </span>
            </DropdownMenuLabel>
            <WorkspaceMenuItems
              workspaces={currentWorkspaces}
              activeWorkspaceId={props.activeWorkspaceId}
              managedSelfContext={props.managedSelfContext}
              onSelect={props.onSelect}
            />
            <CreateWorkspaceMenuItem
              organizationLabel={currentOrg.label}
              canCreate={props.canCreate}
              workspaceId={props.activeWorkspaceId}
              returnTo={props.createReturnTo}
            />
          </DropdownMenuGroup>
        ) : null}
        {currentOrg ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className={SWITCHER_MENU_ITEM_CLASS}>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId: props.activeWorkspaceId }}
              >
                <SettingsIcon className="size-4" />
                Organization settings
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
        {otherOrgs.length > 0 || props.onCreateOrganization ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-label="Switch organization">
              {otherOrgs.length > 0 ? (
                <DropdownMenuLabel className={SWITCHER_MENU_LABEL_CLASS}>
                  Switch organization
                </DropdownMenuLabel>
              ) : null}
              {otherOrgs.map(({ org, landing }) => (
                <DropdownMenuItem
                  key={org.accountId}
                  className={SWITCHER_MENU_ITEM_CLASS}
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
              {props.onCreateOrganization ? (
                <DropdownMenuItem
                  className={SWITCHER_MENU_ITEM_CLASS}
                  onSelect={(event) => {
                    event.preventDefault();
                    props.onCreateOrganization?.();
                  }}
                >
                  <PlusIcon className="size-4" />
                  New organization
                </DropdownMenuItem>
              ) : null}
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
        className="flex size-5 items-center justify-center rounded bg-surface-3 text-2xs font-semibold"
      >
        <WorkspaceGlyph workspace={props.workspace} personal={personal} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {props.workspace.name}
        {personal ? <span className="sr-only">, your Personal workspace</span> : null}
      </span>
      {paused ? (
        <>
          <PauseIcon aria-hidden="true" className="size-3.5 fill-current text-status-waiting" />
          <span className="sr-only"> Paused</span>
        </>
      ) : null}
      {props.workspace.id === props.activeWorkspaceId ? (
        <CheckIcon aria-hidden="true" className="size-4 text-brand" />
      ) : null}
    </>
  );
}
