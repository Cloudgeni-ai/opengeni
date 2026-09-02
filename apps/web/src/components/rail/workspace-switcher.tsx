import { CheckIcon, ChevronsUpDownIcon, PauseIcon, PlusIcon } from "lucide-react";
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { toast } from "sonner";

import { PersonalWorkspaceBadge } from "@/components/personal-workspace-badge";
import { WorkspaceNameDialog } from "@/components/rail/workspace-name-dialog";
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
import {
  organizationsForSubject,
  shortAccountId,
  workspacesInOrg,
  type OrgOption,
} from "@/lib/org";
import { isPersonalWorkspace, type ManagedSelfContext } from "@/lib/managed-self-context";
import { cn } from "@/lib/utils";
import { workspaceCreationAccountId } from "@/lib/workspaces";
import type { Workspace } from "@/types";

function workspaceInitial(workspace: Workspace | null): string {
  return (workspace?.name.trim()[0] ?? "W").toUpperCase();
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

/**
 * Route-neutral workspace selector. Callers own where a workspace selection
 * lands; the shared control owns the menu contents and create-workspace flow.
 */
export function WorkspaceSwitcherMenu(props: {
  workspaceId: string;
  collapsed: boolean;
  align: "start" | "end";
  onSelect: (workspaceId: string) => void;
  className?: string;
}) {
  const context = useAppContext();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === props.workspaceId) ?? null;
  const activeAccountId =
    activeWorkspace?.accountId ?? context.accessContext.defaultAccountId ?? null;
  const orgs = organizationsForSubject(context.accessContext, context.workspaces);
  const currentOrgLabel = activeOrganizationLabel(orgs, activeAccountId);
  const activeIsPersonal = isPersonalWorkspace(activeWorkspace, context.managedSelfContext);
  const createAccountId = workspaceCreationAccountId(
    context.accessContext,
    activeWorkspace?.accountId ?? null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitCreate() {
    const name = nameDraft.trim();
    if (!name) return;
    const acceptedTransition = context.captureWorkspaceInvocation(props.workspaceId);
    if (!acceptedTransition) return;
    setBusy(true);
    try {
      const created = await context.createWorkspace({
        name,
        ...(createAccountId ? { accountId: createAccountId } : {}),
      });
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
        canCreate={createAccountId !== null}
        onSelect={props.onSelect}
        onCreate={() => setCreateOpen(true)}
        managedSelfContext={context.managedSelfContext}
        align={props.align}
      >
        <WorkspaceSwitcherTrigger
          activeWorkspace={activeWorkspace}
          activeOrganizationLabel={currentOrgLabel}
          personal={activeIsPersonal}
          collapsed={props.collapsed}
          className={props.className}
        />
      </WorkspaceMenu>
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
    </>
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
