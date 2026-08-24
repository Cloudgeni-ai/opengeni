// The rail's top switcher: a muted Organization line over a prominent Workspace
// line. The org line is a menu only when the subject belongs to >1 org (a plain
// label otherwise); the workspace line is always a menu listing the current
// org's workspaces plus create / settings actions. Collapsed, the whole block
// reduces to a workspace-initial avatar that opens the same workspace menu.
import { Link } from "@tanstack/react-router";
import {
  BuildingIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  PauseIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { toast } from "sonner";

import { WorkspaceNameDialog } from "@/components/rail/workspace-name-dialog";
import { PersonalWorkspaceBadge } from "@/components/personal-workspace-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { useRail } from "@/components/rail/rail-context";
import {
  organizationsForSubject,
  shortAccountId,
  workspacesInOrg,
  type OrgOption,
} from "@/lib/org";
import { isPersonalWorkspace, type ManagedSelfContext } from "@/lib/managed-self-context";
import { workspaceCreationAccountId } from "@/lib/workspaces";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/types";

function workspaceInitial(workspace: Workspace | null): string {
  return (workspace?.name.trim()[0] ?? "W").toUpperCase();
}

function activeOrganizationLabel(orgs: OrgOption[], activeAccountId: string | null): string {
  if (!activeAccountId) {
    return "Organization";
  }
  return (
    orgs.find((organization) => organization.accountId === activeAccountId)?.label ??
    `Org ${shortAccountId(activeAccountId)}`
  );
}

export const WORKSPACE_SWITCHER_GRID_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 px-3 pt-1";

export function SwitcherBlock() {
  const context = useAppContext();
  const rail = useRail();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === rail.workspaceId) ?? null;
  const activeAccountId =
    activeWorkspace?.accountId ?? context.accessContext.defaultAccountId ?? null;

  const orgs = organizationsForSubject(context.accessContext, context.workspaces);
  const currentOrgLabel = activeOrganizationLabel(orgs, activeAccountId);
  const activeIsPersonal = isPersonalWorkspace(activeWorkspace, context.managedSelfContext);

  const createAccountId = workspaceCreationAccountId(
    context.accessContext,
    activeWorkspace?.accountId ?? null,
  );

  const [dialog, setDialog] = useState<"create" | "rename" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  function openDialog(mode: "create" | "rename") {
    setNameDraft(mode === "rename" ? (activeWorkspace?.name ?? "") : "");
    setDialog(mode);
  }

  async function submitDialog() {
    const name = nameDraft.trim();
    if (!name || !dialog) {
      return;
    }
    const acceptedTransition = context.captureWorkspaceInvocation(rail.workspaceId);
    if (!acceptedTransition) return;
    setBusy(true);
    try {
      if (dialog === "create") {
        const created = await context.createWorkspace({
          name,
          ...(createAccountId ? { accountId: createAccountId } : {}),
        });
        if (!created) {
          return;
        }
        if (!context.ownsWorkspaceInvocation(rail.workspaceId, acceptedTransition)) return;
        toast.success(`Workspace ${created.name} created`);
        rail.openWorkspace(created.id);
      } else {
        const renamed = await context.renameWorkspace(rail.workspaceId, name);
        if (!renamed) {
          return;
        }
        if (!context.ownsWorkspaceInvocation(rail.workspaceId, acceptedTransition)) return;
        toast.success("Workspace renamed");
      }
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  if (rail.collapsed) {
    return (
      <>
        <WorkspaceMenu
          collapsed={rail.collapsed}
          orgs={orgs}
          workspaces={context.workspaces}
          activeWorkspaceId={rail.workspaceId}
          canCreate={createAccountId !== null}
          onSelect={rail.openWorkspace}
          onCreate={() => openDialog("create")}
          managedSelfContext={context.managedSelfContext}
          align="start"
        >
          <WorkspaceSwitcherTrigger
            activeWorkspace={activeWorkspace}
            activeOrganizationLabel={currentOrgLabel}
            personal={activeIsPersonal}
            collapsed
          />
        </WorkspaceMenu>
        <WorkspaceNameDialog
          mode={dialog}
          name={nameDraft}
          busy={busy}
          onNameChange={setNameDraft}
          onOpenChange={(open) => !open && setDialog(null)}
          onSubmit={() => void submitDialog()}
        />
      </>
    );
  }

  return (
    <div className={WORKSPACE_SWITCHER_GRID_CLASS}>
      <OrganizationSwitcherLine
        orgs={orgs}
        currentLabel={currentOrgLabel}
        activeAccountId={activeAccountId}
        onSelect={rail.openOrg}
        workspaceId={rail.workspaceId}
      />

      <WorkspaceMenu
        collapsed={rail.collapsed}
        orgs={orgs}
        workspaces={context.workspaces}
        activeWorkspaceId={rail.workspaceId}
        canCreate={createAccountId !== null}
        onSelect={rail.openWorkspace}
        onCreate={() => openDialog("create")}
        managedSelfContext={context.managedSelfContext}
        align="start"
      >
        <WorkspaceSwitcherTrigger
          activeWorkspace={activeWorkspace}
          activeOrganizationLabel={currentOrgLabel}
          personal={activeIsPersonal}
          collapsed={false}
        />
      </WorkspaceMenu>

      <WorkspaceNameDialog
        mode={dialog}
        name={nameDraft}
        busy={busy}
        onNameChange={setNameDraft}
        onOpenChange={(open) => !open && setDialog(null)}
        onSubmit={() => void submitDialog()}
      />
    </div>
  );
}

export function OrganizationSwitcherLine(props: {
  orgs: OrgOption[];
  currentLabel: string;
  activeAccountId: string | null;
  onSelect: (accountId: string) => void;
  workspaceId: string | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${props.currentLabel}. Organization menu`}
          className="flex min-w-0 items-center gap-1 rounded px-0.5 py-0.5 text-2xs font-medium text-fg-subtle transition-colors hover:text-fg-muted focus-visible:outline-none"
        >
          <BuildingIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{props.currentLabel}</span>
          <ChevronsUpDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {props.orgs.length > 1 ? (
          <>
            <DropdownMenuLabel className="text-fg-subtle">Organizations</DropdownMenuLabel>
            {props.orgs.map((org) => (
              <DropdownMenuItem
                key={org.accountId}
                aria-current={org.accountId === props.activeAccountId ? "true" : undefined}
                onSelect={() => {
                  if (org.accountId !== props.activeAccountId) {
                    props.onSelect(org.accountId);
                  }
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-5 items-center justify-center rounded bg-surface-3 text-2xs font-semibold"
                >
                  {org.label
                    .replace(/^Org\s+/, "")
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{org.label}</span>
                {org.accountId === props.activeAccountId ? (
                  <CheckIcon aria-hidden="true" className="size-4 text-brand" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <DropdownMenuLabel className="text-fg-subtle">{props.currentLabel}</DropdownMenuLabel>
        )}
        {props.workspaceId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId: props.workspaceId }}
              >
                <SettingsIcon className="size-4" />
                Organization settings
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type WorkspaceSwitcherTriggerProps = {
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
    collapsed,
    className,
    ...buttonProps
  },
  ref,
) {
  const workspaceLabel = activeWorkspace?.name ?? (collapsed ? "switch workspace" : "none");
  const accessibleLabel = `${organizationLabel}. ${
    personal ? "Personal workspace" : "Workspace"
  }: ${workspaceLabel}. Switch workspace`;

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
        {workspaceInitial(activeWorkspace)}
      </button>
    );
  }

  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={accessibleLabel}
      className={cn(
        "group flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-surface-2/50 px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none",
        className,
      )}
    >
      <Avatar size="sm" className="rounded-md">
        <AvatarFallback className="rounded-md bg-brand-strong/25 text-2xs font-semibold text-brand">
          {workspaceInitial(activeWorkspace)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={activeWorkspace?.name}>
        {activeWorkspace?.name ?? "Select workspace"}
      </span>
      {personal ? <PersonalWorkspaceBadge decorative /> : null}
      <ChevronsUpDownIcon className="size-3.5 shrink-0 text-fg-subtle" />
    </button>
  );
});

export function WorkspaceMenu(props: {
  collapsed: boolean;
  orgs: OrgOption[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  canCreate: boolean;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  managedSelfContext: ManagedSelfContext | null;
  align: "start" | "end";
  children: ReactNode;
}) {
  const grouped = props.orgs.map((org) => ({
    org,
    workspaces: workspacesInOrg(props.workspaces, org.accountId),
  }));
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
        className="min-w-60"
        side={props.collapsed ? "right" : "bottom"}
      >
        {grouped.map(({ org, workspaces }, index) => (
          <div key={org.accountId}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-fg-subtle">
              {props.orgs.length > 1 ? org.label : "Workspaces"}
            </DropdownMenuLabel>
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                aria-current={workspace.id === props.activeWorkspaceId ? "page" : undefined}
                onSelect={() => props.onSelect(workspace.id)}
              >
                <WorkspaceMenuItemContent
                  workspace={workspace}
                  activeWorkspaceId={props.activeWorkspaceId}
                  managedSelfContext={props.managedSelfContext}
                />
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        {props.canCreate ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              props.onCreate();
            }}
          >
            <PlusIcon className="size-4" />
            New workspace…
          </DropdownMenuItem>
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
        {workspaceInitial(props.workspace)}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.workspace.name}</span>
      {personal ? <PersonalWorkspaceBadge /> : null}
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
