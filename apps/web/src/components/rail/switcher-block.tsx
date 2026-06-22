// The rail's top switcher: a muted Organization line over a prominent Workspace
// line. The org line is a menu only when the subject belongs to >1 org (a plain
// label otherwise); the workspace line is always a menu listing the current
// org's workspaces plus create / settings actions. Collapsed, the whole block
// reduces to a workspace-initial avatar that opens the same workspace menu.
import { Link } from "@tanstack/react-router";
import { BuildingIcon, CheckIcon, ChevronsUpDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

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
import { useRail } from "@/components/rail/rail-context";
import { organizationsForSubject, orgLabel, workspacesInOrg } from "@/lib/org";
import { workspaceCreationAccountId } from "@/lib/workspaces";
import type { Workspace } from "@/types";

function workspaceInitial(workspace: Workspace | null): string {
  return (workspace?.name.trim()[0] ?? "W").toUpperCase();
}

export function SwitcherBlock() {
  const context = useAppContext();
  const rail = useRail();
  const activeWorkspace = context.workspaces.find((workspace) => workspace.id === rail.workspaceId) ?? null;
  const activeAccountId = activeWorkspace?.accountId ?? context.accessContext.defaultAccountId ?? null;

  const orgs = organizationsForSubject(context.accessContext, context.workspaces);
  const currentOrgLabel = activeAccountId ? orgLabel(activeAccountId, context.accessContext.accountGrants) : "Organization";
  const orgWorkspaces = activeAccountId ? workspacesInOrg(context.workspaces, activeAccountId) : context.workspaces;

  const createAccountId = workspaceCreationAccountId(context.accessContext, activeWorkspace?.accountId ?? null);

  const [dialog, setDialog] = useState<"create" | "rename" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  function openDialog(mode: "create" | "rename") {
    setNameDraft(mode === "rename" ? activeWorkspace?.name ?? "" : "");
    setDialog(mode);
  }

  async function submitDialog() {
    const name = nameDraft.trim();
    if (!name || !dialog) {
      return;
    }
    setBusy(true);
    try {
      if (dialog === "create") {
        const created = await context.createWorkspace({ name, ...(createAccountId ? { accountId: createAccountId } : {}) });
        if (!created) {
          return;
        }
        toast.success(`Workspace ${created.name} created`);
        rail.openWorkspace(created.id);
      } else {
        const renamed = await context.renameWorkspace(rail.workspaceId, name);
        if (!renamed) {
          return;
        }
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
          workspaces={orgWorkspaces}
          activeWorkspaceId={rail.workspaceId}
          canCreate={createAccountId !== null}
          onSelect={rail.openWorkspace}
          onCreate={() => openDialog("create")}
          align="start"
        >
          <button
            type="button"
            aria-label={`Workspace: ${activeWorkspace?.name ?? "switch workspace"}`}
            className="mx-auto flex size-9 items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60 text-sm font-semibold text-[color:var(--color-fg)] transition-colors hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)] focus-visible:outline-none"
          >
            {workspaceInitial(activeWorkspace)}
          </button>
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
    <div className="grid gap-1.5 px-3 pt-1">
      <OrgLine orgs={orgs} currentLabel={currentOrgLabel} activeAccountId={activeAccountId} />

      <WorkspaceMenu
        workspaces={orgWorkspaces}
        activeWorkspaceId={rail.workspaceId}
        canCreate={createAccountId !== null}
        onSelect={rail.openWorkspace}
        onCreate={() => openDialog("create")}
        align="start"
      >
        <button
          type="button"
          className="group flex w-full items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/50 px-2 py-1.5 text-left transition-colors hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)] focus-visible:outline-none"
        >
          <Avatar size="sm" className="rounded-md">
            <AvatarFallback className="rounded-md bg-[color:var(--color-brand-strong)]/25 text-[11px] font-semibold text-[color:var(--color-brand)]">
              {workspaceInitial(activeWorkspace)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={activeWorkspace?.name}>
            {activeWorkspace?.name ?? "Select workspace"}
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-[color:var(--color-fg-subtle)]" />
        </button>
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

function OrgLine(props: {
  orgs: ReturnType<typeof organizationsForSubject>;
  currentLabel: string;
  activeAccountId: string | null;
}) {
  const rail = useRail();
  // The org *name* renders in normal case (it's a name, not a section caption).
  // Exactly one org: a static muted label, no useless switcher.
  if (props.orgs.length <= 1) {
    return (
      <span className="flex min-w-0 items-center gap-1 px-0.5 text-[11px] font-medium text-[color:var(--color-fg-subtle)]" title={props.currentLabel}>
        <BuildingIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{props.currentLabel}</span>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch organization"
          className="flex min-w-0 items-center gap-1 rounded px-0.5 py-0.5 text-[11px] font-medium text-[color:var(--color-fg-subtle)] transition-colors hover:text-[color:var(--color-fg-muted)] focus-visible:outline-none"
        >
          <BuildingIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{props.currentLabel}</span>
          <ChevronsUpDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="text-[color:var(--color-fg-subtle)]">Organizations</DropdownMenuLabel>
        {props.orgs.map((org) => (
          <DropdownMenuItem
            key={org.accountId}
            onSelect={() => {
              if (org.accountId !== props.activeAccountId) {
                rail.openOrg(org.accountId);
              }
            }}
          >
            <span className="flex size-5 items-center justify-center rounded bg-[color:var(--color-surface-3)] text-[10px] font-semibold">
              {org.label.replace(/^Org\s+/, "").slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">{org.label}</span>
            {org.accountId === props.activeAccountId ? <CheckIcon className="size-4 text-[color:var(--color-brand)]" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/workspaces/$workspaceId/organization" params={{ workspaceId: rail.workspaceId }}>
            <SettingsIcon className="size-4" />
            Organization settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceMenu(props: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  canCreate: boolean;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  align: "start" | "end";
  children: ReactNode;
}) {
  const rail = useRail();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>
        </TooltipTrigger>
        {rail.collapsed ? <TooltipContent side="right">Switch workspace</TooltipContent> : null}
      </Tooltip>
      <DropdownMenuContent align={props.align} className="min-w-60" side={rail.collapsed ? "right" : "bottom"}>
        <DropdownMenuLabel className="text-[color:var(--color-fg-subtle)]">Workspaces</DropdownMenuLabel>
        {props.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => props.onSelect(workspace.id)}
          >
            <span className="flex size-5 items-center justify-center rounded bg-[color:var(--color-surface-3)] text-[10px] font-semibold">
              {workspaceInitial(workspace)}
            </span>
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            {workspace.id === props.activeWorkspaceId ? <CheckIcon className="size-4 text-[color:var(--color-brand)]" /> : null}
          </DropdownMenuItem>
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
        <DropdownMenuItem asChild>
          <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId: props.activeWorkspaceId }}>
            <SettingsIcon className="size-4" />
            Workspace settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
