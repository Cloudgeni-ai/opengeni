// Workspace configuration nav: the four config surfaces (Environments,
// Capabilities, Schedules, Documents) as individual items, then a slightly
// separated Settings (Workspace settings). Collapsed → centered icons with
// tooltips. Active route gets a left accent bar + subtle surface tint.
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  CalendarClockIcon,
  FileSearchIcon,
  LaptopIcon,
  PlugIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useRail } from "@/components/rail/rail-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type NavTarget =
  | "/workspaces/$workspaceId/environments"
  | "/workspaces/$workspaceId/machines"
  | "/workspaces/$workspaceId/capabilities"
  | "/workspaces/$workspaceId/schedules"
  | "/workspaces/$workspaceId/documents"
  | "/workspaces/$workspaceId/settings";

const CONFIG_ITEMS: Array<{ to: NavTarget; icon: LucideIcon; label: string }> = [
  { to: "/workspaces/$workspaceId/environments", icon: BoxIcon, label: "Environments" },
  { to: "/workspaces/$workspaceId/machines", icon: LaptopIcon, label: "Machines" },
  { to: "/workspaces/$workspaceId/capabilities", icon: PlugIcon, label: "Capabilities" },
  { to: "/workspaces/$workspaceId/schedules", icon: CalendarClockIcon, label: "Schedules" },
  { to: "/workspaces/$workspaceId/documents", icon: FileSearchIcon, label: "Documents" },
];

export function WorkspaceNav() {
  const rail = useRail();
  return (
    <nav aria-label="Workspace" className={cn("grid gap-0.5", rail.collapsed ? "px-2" : "px-2")}>
      {!rail.collapsed ? (
        <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
          Workspace
        </p>
      ) : null}
      {CONFIG_ITEMS.map((item) => (
        <RailNavItem
          key={item.to}
          to={item.to}
          workspaceId={rail.workspaceId}
          icon={<item.icon className="size-4" />}
          label={item.label}
          collapsed={rail.collapsed}
        />
      ))}
      <div className={cn("mt-1 border-t border-[color:var(--color-border)]/60 pt-1", rail.collapsed ? "mx-1" : "")}>
        <RailNavItem
          to="/workspaces/$workspaceId/settings"
          workspaceId={rail.workspaceId}
          icon={<SettingsIcon className="size-4" />}
          label="Settings"
          collapsed={rail.collapsed}
        />
      </div>
    </nav>
  );
}

export function RailNavItem(props: {
  to: NavTarget;
  workspaceId: string;
  icon: ReactNode;
  label: string;
  collapsed: boolean;
  /** Optional search params (Capabilities Packs subsection, etc.). */
  search?: Record<string, string>;
}) {
  const link = (
    <Link
      to={props.to}
      params={{ workspaceId: props.workspaceId }}
      {...(props.search ? { search: props.search } : {})}
      activeProps={{ "data-active": "true" }}
      aria-label={props.collapsed ? props.label : undefined}
      className={cn(
        "group relative flex h-8 items-center rounded-md text-sm font-medium text-[color:var(--color-fg-muted)] transition-colors",
        "hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
        "data-[active=true]:bg-[color:var(--color-surface-2)] data-[active=true]:text-[color:var(--color-fg)]",
        props.collapsed ? "w-8 justify-center" : "gap-2.5 px-2.5",
      )}
    >
      {/* Left accent bar on the active route. */}
      <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[color:var(--color-brand)] opacity-0 transition-opacity group-data-[active=true]:opacity-100" />
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
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  );
}
