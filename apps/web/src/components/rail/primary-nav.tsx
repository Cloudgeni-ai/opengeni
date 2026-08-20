import { useRouterState } from "@tanstack/react-router";
import { SquarePenIcon } from "lucide-react";

import { ForYouLink } from "@/components/rail/for-you-link";
import { useRail } from "@/components/rail/rail-context";
import { NewSessionLink } from "@/components/rail/session-list";
import { WorkspaceConfigLink } from "@/components/rail/workspace-config-link";
import { isConfigItemActive, PRIMARY_WORKSPACE_ITEMS } from "@/components/rail/workspace-nav-data";
import { NEW_SESSION_SHORTCUT, shortcutLabel } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

/** Primary product navigation, kept separate from workspace administration. */
export function PrimaryNav() {
  const rail = useRail();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const newSessionActive = pathname === `/workspaces/${rail.workspaceId}/sessions`;

  return (
    <div className={cn("mt-2 grid gap-0.5 px-2", rail.collapsed && "justify-center")}>
      <NewSessionLink
        aria-label={`New session · ${shortcutLabel(NEW_SESSION_SHORTCUT)}`}
        className={cn(
          "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted outline-none transition-colors pointer-coarse:h-10",
          "hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50",
          newSessionActive && "bg-surface-2 text-fg",
          rail.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity",
            newSessionActive ? "opacity-100" : "opacity-0",
          )}
        />
        <SquarePenIcon className="size-4 shrink-0" />
        {rail.collapsed ? null : <span className="min-w-0 truncate">New session</span>}
      </NewSessionLink>

      <ForYouLink embedded />

      {PRIMARY_WORKSPACE_ITEMS.map((item) => (
        <WorkspaceConfigLink
          key={item.to}
          item={item}
          workspaceId={rail.workspaceId}
          variant="rail"
          collapsed={rail.collapsed}
          active={isConfigItemActive(pathname, rail.workspaceId, item.to)}
          onNavigate={() => rail.setDrawerOpen(false)}
        />
      ))}
    </div>
  );
}
