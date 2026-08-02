// Workspace config hub: one Settings anchor on the desktop rail that opens an
// upward menu of grouped destinations (Overview / Runtime / Knowledge /
// Automation / Admin). Mobile Workspace tab keeps the same groups as an inline
// list. Active route marks the Settings control and the matching menu item.
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BoxIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  ChevronUpIcon,
  FileSearchIcon,
  GaugeIcon,
  LaptopIcon,
  MapIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  ServerCogIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useRail } from "@/components/rail/rail-context";
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

export type WorkspaceConfigTarget =
  | "/workspaces/$workspaceId/insights"
  | "/workspaces/$workspaceId/variable-sets"
  | "/workspaces/$workspaceId/rigs"
  | "/workspaces/$workspaceId/machines"
  | "/workspaces/$workspaceId/capabilities"
  | "/workspaces/$workspaceId/schedules"
  | "/workspaces/$workspaceId/documents"
  | "/workspaces/$workspaceId/memory"
  | "/workspaces/$workspaceId/state"
  | "/workspaces/$workspaceId/artifacts"
  | "/workspaces/$workspaceId/settings";

export type WorkspaceConfigItem = {
  to: WorkspaceConfigTarget;
  icon: LucideIcon;
  label: string;
  description: string;
  /** When true, only include for subjects with workspace:admin. */
  requiresAdmin?: boolean;
};

export type WorkspaceConfigGroup = {
  id: string;
  label: string;
  items: WorkspaceConfigItem[];
};

export const WORKSPACE_CONFIG_GROUPS: WorkspaceConfigGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        to: "/workspaces/$workspaceId/insights",
        icon: GaugeIcon,
        label: "Insights",
        description: "Spend, blockers, automation, and outcomes",
        requiresAdmin: true,
      },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    items: [
      {
        to: "/workspaces/$workspaceId/variable-sets",
        icon: BoxIcon,
        label: "Variable sets",
        description: "Secret variableSets for sandboxes",
      },
      {
        to: "/workspaces/$workspaceId/rigs",
        icon: ServerCogIcon,
        label: "Rigs",
        description: "Versioned sandbox machine definitions",
      },
      {
        to: "/workspaces/$workspaceId/machines",
        icon: LaptopIcon,
        label: "Machines",
        description: "Your own connected computers",
      },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    items: [
      {
        to: "/workspaces/$workspaceId/documents",
        icon: FileSearchIcon,
        label: "Documents",
        description: "Indexed knowledge for agents",
      },
      {
        to: "/workspaces/$workspaceId/memory",
        icon: BrainCircuitIcon,
        label: "Memory",
        description: "Durable facts agents carry across sessions",
      },
      {
        to: "/workspaces/$workspaceId/state",
        icon: MapIcon,
        label: "Workspace State",
        description: "Read-only policy and knowledge inventory",
      },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      {
        to: "/workspaces/$workspaceId/capabilities",
        icon: PlugIcon,
        label: "Capabilities",
        description: "Packs, MCP servers, and tools",
      },
      {
        to: "/workspaces/$workspaceId/schedules",
        icon: CalendarClockIcon,
        label: "Schedules",
        description: "Run agents on a schedule",
      },
      {
        to: "/workspaces/$workspaceId/artifacts",
        icon: PanelsTopLeftIcon,
        label: "Artifacts",
        description: "Live pages and tools built with Geni",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      {
        to: "/workspaces/$workspaceId/settings",
        icon: SettingsIcon,
        label: "General, members & keys",
        description: "Name, API keys, members, and Codex subscriptions",
      },
    ],
  },
];

/** Destinations shown in the Browse workspace strip (excludes the settings page itself). */
export const WORKSPACE_BROWSE_ITEMS: WorkspaceConfigItem[] = WORKSPACE_CONFIG_GROUPS.flatMap(
  (group) => group.items,
).filter((item) => item.to !== "/workspaces/$workspaceId/settings");

export function filterWorkspaceConfigGroups(
  groups: WorkspaceConfigGroup[],
  canReadInsights: boolean,
): WorkspaceConfigGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.requiresAdmin || canReadInsights),
    }))
    .filter((group) => group.items.length > 0);
}

function configPathSuffix(to: WorkspaceConfigTarget): string {
  const parts = to.split("/");
  return parts[parts.length - 1] ?? "";
}

export function isWorkspaceConfigPath(pathname: string, workspaceId: string): boolean {
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length).split("/")[0] ?? "";
  return WORKSPACE_CONFIG_GROUPS.some((group) =>
    group.items.some((item) => configPathSuffix(item.to) === rest),
  );
}

function isConfigItemActive(
  pathname: string,
  workspaceId: string,
  to: WorkspaceConfigTarget,
): boolean {
  return pathname === `/workspaces/${workspaceId}/${configPathSuffix(to)}`;
}

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
            {group.items.map((item) => (
              <RailNavItem
                key={item.to}
                to={item.to}
                workspaceId={rail.workspaceId}
                icon={<item.icon className="size-4" />}
                label={item.label}
                description={item.description}
                collapsed={false}
                active={isConfigItemActive(pathname, rail.workspaceId, item.to)}
              />
            ))}
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
                    <item.icon className="size-4" />
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
