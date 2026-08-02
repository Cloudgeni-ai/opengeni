// Workspace config hub: one Settings anchor on the desktop rail that opens an
// upward menu of grouped destinations (Overview / Runtime / Knowledge /
// Automation / Admin). Mobile Workspace tab keeps the same groups as an inline
// list. Active route marks the Settings control and the matching menu item.
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronUpIcon, SettingsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useRail } from "@/components/rail/rail-context";
import {
  filterWorkspaceConfigGroups,
  isConfigItemActive,
  isWorkspaceConfigPath,
  WORKSPACE_CONFIG_GROUPS,
  type WorkspaceConfigGroup,
  type WorkspaceConfigTarget,
} from "@/components/rail/workspace-nav-data";
import { WORKSPACE_CONFIG_ICONS } from "@/components/rail/workspace-nav-icons";
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
import { hasWorkspacePermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export type {
  WorkspaceConfigGroup,
  WorkspaceConfigItem,
  WorkspaceConfigTarget,
} from "@/components/rail/workspace-nav-data";
export {
  filterWorkspaceConfigGroups,
  isWorkspaceConfigPath,
  WORKSPACE_BROWSE_ITEMS,
  WORKSPACE_CONFIG_GROUPS,
} from "@/components/rail/workspace-nav-data";

export function WorkspaceNav() {
  const rail = useRail();
  const context = useAppContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const canReadInsights = hasWorkspacePermission(
    context.accessContext,
    rail.workspaceId,
    "workspace:admin",
  );
  const groups = filterWorkspaceConfigGroups(WORKSPACE_CONFIG_GROUPS, canReadInsights);
  const settingsActive = isWorkspaceConfigPath(pathname, rail.workspaceId);

  // Mobile already has a Workspace tab — show the groups inline there.
  if (rail.isMobile) {
    return (
      <nav aria-label="Workspace" className="grid gap-2 px-2">
        {groups.map((group) => (
          <div key={group.id} className="grid gap-0.5">
            <p className="px-2 pb-0.5 pt-1 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = WORKSPACE_CONFIG_ICONS[item.icon];
              return (
                <RailNavItem
                  key={item.to}
                  to={item.to}
                  workspaceId={rail.workspaceId}
                  icon={<Icon className="size-4" />}
                  label={item.label}
                  description={item.description}
                  collapsed={false}
                  active={isConfigItemActive(pathname, rail.workspaceId, item.to)}
                />
              );
            })}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Workspace" className="grid gap-0.5 px-2">
      <WorkspaceSettingsMenu
        workspaceId={rail.workspaceId}
        groups={groups}
        pathname={pathname}
        collapsed={rail.collapsed}
        active={settingsActive}
      />
    </nav>
  );
}

function WorkspaceSettingsMenu(props: {
  workspaceId: string;
  groups: WorkspaceConfigGroup[];
  pathname: string;
  collapsed: boolean;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = (
    <button
      type="button"
      aria-label={props.collapsed ? "Workspace" : undefined}
      aria-expanded={open}
      data-active={props.active ? "true" : undefined}
      className={cn(
        "group relative flex h-8 w-full items-center rounded-md text-sm font-medium text-fg-muted transition-colors pointer-coarse:h-10",
        "hover:bg-surface-2 hover:text-fg",
        "data-[active=true]:bg-surface-2 data-[active=true]:text-fg",
        props.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
      )}
    >
      <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100" />
      <SettingsIcon className="size-4 shrink-0" />
      {!props.collapsed ? (
        <>
          <span className="min-w-0 flex-1 truncate text-left">Workspace</span>
          <ChevronUpIcon
            className={cn(
              "size-3.5 shrink-0 text-fg-subtle transition-transform",
              open ? "rotate-0" : "rotate-180",
            )}
          />
        </>
      ) : null}
    </button>
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {props.collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-52">
            <p className="font-medium">Workspace</p>
            <p className="text-fg-subtle">Configure runtime, knowledge, and admin</p>
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        side="top"
        align={props.collapsed ? "start" : "start"}
        sideOffset={6}
        className="w-64"
      >
        {props.groups.map((group, index) => (
          <DropdownMenuGroup key={group.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              {group.label}
            </DropdownMenuLabel>
            {group.items.map((item) => {
              const active = isConfigItemActive(props.pathname, props.workspaceId, item.to);
              const Icon = WORKSPACE_CONFIG_ICONS[item.icon];
              return (
                <DropdownMenuItem key={item.to} asChild>
                  <Link
                    to={item.to}
                    params={{ workspaceId: props.workspaceId }}
                    data-active={active ? "true" : undefined}
                    className={cn(
                      "flex cursor-pointer items-center gap-2",
                      active ? "bg-accent text-accent-foreground" : "",
                    )}
                    onClick={() => setOpen(false)}
                  >
                    <Icon className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RailNavItem(props: {
  to: WorkspaceConfigTarget;
  workspaceId: string;
  icon: ReactNode;
  label: string;
  /** One-line orientation for an opaque label — surfaced in the tooltip. */
  description?: string;
  collapsed: boolean;
  /** Optional search params (Capabilities Packs subsection, etc.). */
  search?: Record<string, string>;
  /** When set, overrides Link activeProps for explicit active highlighting. */
  active?: boolean;
}) {
  const link = (
    <Link
      to={props.to}
      params={{ workspaceId: props.workspaceId }}
      {...(props.search ? { search: props.search } : {})}
      {...(props.active === undefined
        ? { activeProps: { "data-active": "true" as const } }
        : { "data-active": props.active ? ("true" as const) : undefined })}
      aria-label={props.collapsed ? props.label : undefined}
      title={props.description && !props.collapsed ? props.description : undefined}
      className={cn(
        "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted transition-colors pointer-coarse:h-10",
        "hover:bg-surface-2 hover:text-fg",
        "data-[active=true]:bg-surface-2 data-[active=true]:text-fg",
        props.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
      )}
    >
      <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100" />
      <span className="shrink-0">{props.icon}</span>
      {!props.collapsed ? <span className="min-w-0 truncate">{props.label}</span> : null}
    </Link>
  );

  if (!props.collapsed) {
    return link;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-52">
        <p className="font-medium">{props.label}</p>
        {props.description ? <p className="text-fg-subtle">{props.description}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}
