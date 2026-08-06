// Renders a workspace-config destination (icon + label + link). Used by the
// rail Workspace menu and the settings Browse strip.
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
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

import type {
  WorkspaceConfigIcon,
  WorkspaceConfigItem,
} from "@/components/rail/workspace-nav-data";
import { cn } from "@/lib/utils";

const WORKSPACE_CONFIG_ICONS = {
  gauge: GaugeIcon,
  box: BoxIcon,
  "server-cog": ServerCogIcon,
  laptop: LaptopIcon,
  "file-search": FileSearchIcon,
  "brain-circuit": BrainCircuitIcon,
  map: MapIcon,
  plug: PlugIcon,
  "calendar-clock": CalendarClockIcon,
  "panels-top-left": PanelsTopLeftIcon,
  settings: SettingsIcon,
} as const satisfies Record<WorkspaceConfigIcon, LucideIcon>;

export function WorkspaceConfigGlyph(props: { icon: WorkspaceConfigIcon; className?: string }) {
  const Icon = WORKSPACE_CONFIG_ICONS[props.icon];
  return <Icon className={props.className} />;
}

export function WorkspaceConfigLink(props: {
  item: WorkspaceConfigItem;
  workspaceId: string;
  /** Compact hub strip vs denser menu/rail rows. */
  variant: "browse" | "menu" | "rail";
  active?: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { item, workspaceId, variant, active, collapsed, onNavigate } = props;

  if (variant === "rail") {
    return (
      <Link
        to={item.to}
        params={{ workspaceId }}
        {...(active === undefined
          ? { activeProps: { "data-active": "true" as const } }
          : { "data-active": active ? ("true" as const) : undefined })}
        aria-label={collapsed ? item.label : undefined}
        title={
          collapsed ? [item.label, item.description].filter(Boolean).join(" — ") : item.description
        }
        className={cn(
          "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted transition-colors pointer-coarse:h-10",
          "hover:bg-surface-2 hover:text-fg",
          "data-[active=true]:bg-surface-2 data-[active=true]:text-fg",
          collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
        )}
        onClick={onNavigate}
      >
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100" />
        <WorkspaceConfigGlyph icon={item.icon} className="size-4 shrink-0" />
        {!collapsed ? <span className="min-w-0 truncate">{item.label}</span> : null}
      </Link>
    );
  }

  if (variant === "menu") {
    return (
      <Link
        to={item.to}
        params={{ workspaceId }}
        data-active={active ? "true" : undefined}
        title={item.description}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
          "hover:bg-accent hover:text-accent-foreground",
          active ? "bg-accent text-accent-foreground" : "text-fg",
        )}
        onClick={onNavigate}
      >
        <WorkspaceConfigGlyph icon={item.icon} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </Link>
    );
  }

  return (
    <Link
      to={item.to}
      params={{ workspaceId }}
      title={item.description}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
      onClick={onNavigate}
    >
      <WorkspaceConfigGlyph icon={item.icon} className="size-3.5 shrink-0 text-brand" />
      {item.label}
    </Link>
  );
}
