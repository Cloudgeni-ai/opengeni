// Workspace config hub: one Settings anchor on the desktop rail that opens an
// upward menu of grouped destinations (Overview / Runtime / Knowledge /
// Automation / Admin). Mobile Workspace tab keeps the same groups as an inline
// list. Active route marks the Settings control and the matching menu item.
//
// Native <details> (not Radix DropdownMenu): the densified hub otherwise pulls
// Popper into an entriesAware share-chunk with the session graph and crashes
// lazy /settings (`createPopperScope is not a function`).
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronUpIcon, SettingsIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

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
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!node.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <details ref={detailsRef} className="group/workspace-menu relative">
      <summary
        aria-label={props.collapsed ? "Workspace" : undefined}
        title={props.collapsed ? "Workspace — configure runtime, knowledge, and admin" : undefined}
        data-active={props.active ? "true" : undefined}
        className={cn(
          "group relative flex h-8 w-full cursor-pointer list-none items-center rounded-md text-sm font-medium text-fg-muted transition-colors pointer-coarse:h-10 [&::-webkit-details-marker]:hidden",
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
            <ChevronUpIcon className="size-3.5 shrink-0 rotate-180 text-fg-subtle transition-transform group-open/workspace-menu:rotate-0" />
          </>
        ) : null}
      </summary>
      <div
        className={cn(
          "absolute bottom-full z-50 mb-1.5 max-h-[min(24rem,70vh)] w-64 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-md",
          props.collapsed ? "left-0" : "left-0",
        )}
      >
        {props.groups.map((group, index) => (
          <div key={group.id}>
            {index > 0 ? <div className="my-1 h-px bg-border" /> : null}
            <p className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active = isConfigItemActive(props.pathname, props.workspaceId, item.to);
              const Icon = WORKSPACE_CONFIG_ICONS[item.icon];
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  params={{ workspaceId: props.workspaceId }}
                  data-active={active ? "true" : undefined}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
                    "hover:bg-accent hover:text-accent-foreground",
                    active ? "bg-accent text-accent-foreground" : "text-fg",
                  )}
                  onClick={() => {
                    if (detailsRef.current) detailsRef.current.open = false;
                  }}
                >
                  <Icon className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </details>
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
  return (
    <Link
      to={props.to}
      params={{ workspaceId: props.workspaceId }}
      {...(props.search ? { search: props.search } : {})}
      {...(props.active === undefined
        ? { activeProps: { "data-active": "true" as const } }
        : { "data-active": props.active ? ("true" as const) : undefined })}
      aria-label={props.collapsed ? props.label : undefined}
      title={
        props.collapsed
          ? [props.label, props.description].filter(Boolean).join(" — ")
          : (props.description ?? undefined)
      }
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
}
