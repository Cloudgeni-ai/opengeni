// One predictable entry to the workspace management shell. Operational
// destinations live in that shell as clearly marked workspace-page links.
import { Link, useRouterState } from "@tanstack/react-router";
import { SlidersHorizontalIcon } from "lucide-react";

import { useRail } from "@/components/rail/rail-context";
import { isWorkspaceConfigPath } from "@/components/rail/workspace-nav-data";
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
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = isWorkspaceConfigPath(pathname, rail.workspaceId);

  return (
    <nav
      aria-label="Settings"
      className={cn("grid gap-0.5 px-2", rail.collapsed && "justify-center")}
    >
      <Link
        to="/workspaces/$workspaceId/settings"
        params={{ workspaceId: rail.workspaceId }}
        search={{ section: "general" }}
        aria-current={active ? "page" : undefined}
        title={rail.collapsed ? "Settings" : undefined}
        onClick={() => rail.setDrawerOpen(false)}
        className={cn(
          "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted outline-none transition-colors pointer-coarse:h-10",
          "hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50",
          active && "bg-surface-2 text-fg",
          rail.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity",
            active ? "opacity-100" : "opacity-0",
          )}
        />
        <SlidersHorizontalIcon className="size-4 shrink-0" />
        {rail.collapsed ? null : <span className="min-w-0 truncate">Settings</span>}
      </Link>
    </nav>
  );
}
