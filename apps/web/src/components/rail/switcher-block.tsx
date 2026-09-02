// The rail's top switcher: a muted Organization line over a prominent Workspace
// line. The org line is a menu only when the subject belongs to >1 org (a plain
// label otherwise); the workspace line is always a menu listing the current
// org's workspaces plus create / settings actions. Collapsed, the whole block
// reduces to a workspace-initial avatar that opens the same workspace menu.
import { Link } from "@tanstack/react-router";
import { BuildingIcon, CheckIcon, ChevronsUpDownIcon, SettingsIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { useRail } from "@/components/rail/rail-context";
import {
  activeOrganizationLabel,
  WorkspaceSwitcherMenu,
} from "@/components/rail/workspace-switcher";
import { organizationsForSubject, type OrgOption } from "@/lib/org";

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

  if (rail.collapsed) {
    return (
      <WorkspaceSwitcherMenu
        workspaceId={rail.workspaceId}
        collapsed
        align="start"
        onSelect={rail.openWorkspace}
      />
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

      <WorkspaceSwitcherMenu
        workspaceId={rail.workspaceId}
        collapsed={false}
        align="start"
        onSelect={rail.openWorkspace}
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
