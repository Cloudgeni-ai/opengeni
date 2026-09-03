import type { WorkspaceArtifactListResponse } from "@opengeni/sdk";
import { Link, useRouterState } from "@tanstack/react-router";
import { Globe2Icon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { request } from "@/api";
import { useRail } from "@/components/rail/rail-context";
import { useAppContext } from "@/context";
import {
  collectRecentActiveSites,
  getSiteNavigationSnapshot,
  latestSiteMutationSequence,
  subscribeSiteNavigation,
} from "@/lib/site-navigation";
import { cn } from "@/lib/utils";

const RECENT_SITE_DISPLAY_LIMIT = 6;

/** Bounded active Site shortcuts nested beneath the primary Sites destination. */
export function RecentSitesNav() {
  const rail = useRail();
  const context = useAppContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const feed = useSyncExternalStore(
    context.sessionEventFeedStore.subscribe,
    context.sessionEventFeedStore.getSnapshot,
    context.sessionEventFeedStore.getSnapshot,
  );
  const refreshSequence = useMemo(
    () => latestSiteMutationSequence(feed?.events ?? []),
    [feed?.events],
  );
  const navigationRefresh = useSyncExternalStore(
    subscribeSiteNavigation,
    getSiteNavigationSnapshot,
    getSiteNavigationSnapshot,
  );
  const [loaded, setLoaded] = useState<{
    workspaceId: string;
    artifacts: Awaited<ReturnType<typeof collectRecentActiveSites>>;
  } | null>(null);

  useEffect(() => {
    if (rail.collapsed) return;
    let current = true;
    void collectRecentActiveSites(async (cursor) => {
      const query = new URLSearchParams({
        limit: String(RECENT_SITE_DISPLAY_LIMIT),
        status: "active",
      });
      if (cursor) query.set("cursor", cursor);
      return await request<WorkspaceArtifactListResponse>(
        `/v1/workspaces/${encodeURIComponent(rail.workspaceId)}/published-artifacts?${query.toString()}`,
      );
    }, RECENT_SITE_DISPLAY_LIMIT)
      .then((artifacts) => {
        if (!current) return;
        setLoaded({
          workspaceId: rail.workspaceId,
          artifacts,
        });
      })
      .catch(() => {
        if (current) setLoaded({ workspaceId: rail.workspaceId, artifacts: [] });
      });
    return () => {
      current = false;
    };
  }, [feed?.sessionId, navigationRefresh, rail.collapsed, rail.workspaceId, refreshSequence]);

  if (rail.collapsed || loaded?.workspaceId !== rail.workspaceId || loaded.artifacts.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Recent Sites" className="ml-6 grid gap-0.5 border-l border-border/70 pl-2">
      {loaded.artifacts.map((artifact) => {
        const path = `/workspaces/${rail.workspaceId}/artifacts/${artifact.id}`;
        return (
          <Link
            key={artifact.id}
            to="/workspaces/$workspaceId/artifacts/$artifactId"
            params={{ workspaceId: rail.workspaceId, artifactId: artifact.id }}
            title={artifact.description || artifact.title}
            aria-current={pathname === path ? "page" : undefined}
            onClick={() => rail.setDrawerOpen(false)}
            className={cn(
              "group flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-xs text-fg-subtle outline-none transition-colors pointer-coarse:h-10",
              "hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50",
              pathname === path && "bg-surface-2 text-fg",
            )}
          >
            <Globe2Icon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{artifact.title}</span>
          </Link>
        );
      })}
    </nav>
  );
}
