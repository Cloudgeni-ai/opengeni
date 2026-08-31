// "For you" rail entry linking the priority feed from the primary rail nav.
// priority feed, with a quiet mono count of items blocked on a human. The
// count polls gently and reuses the same root-page query shape as the rail so
// the server can serve both from one snapshot family.
import { useWorkspaceSessions } from "@opengeni/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { SendIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useRail } from "@/components/rail/rail-context";
import { rootNeedsYou } from "@/lib/needs-you";
import { workspacePriorityPath } from "@/lib/routes";
import { subscribeToSessionListChanges } from "@/lib/session-list-invalidation";
import { cn } from "@/lib/utils";

export function ForYouLink(props: { embedded?: boolean }) {
  const rail = useRail();
  const { sessions, refresh } = useWorkspaceSessions({
    limit: 50,
    parentSessionId: null,
    pollIntervalMs: 60_000,
  });
  useEffect(
    () =>
      subscribeToSessionListChanges((invalidation) => {
        if (invalidation.workspaceId === rail.workspaceId) void refresh();
      }),
    [rail.workspaceId, refresh],
  );
  // rootNeedsYou is the same leaf predicate buildPriorityFeed classifies its
  // blocked+broken tiers with, so the badge and the page cannot drift. The
  // full feed lib stays un-imported here on purpose (bundle clustering).
  const needsYou = useMemo(() => sessions.filter(rootNeedsYou).length, [sessions]);
  const active = useRouterState({
    select: (state) => state.location.pathname === workspacePriorityPath(rail.workspaceId),
  });

  const link = (
    <Link
      to="/workspaces/$workspaceId/priority"
      params={{ workspaceId: rail.workspaceId }}
      data-active={active ? "true" : undefined}
      aria-label={needsYou > 0 ? `For you. ${needsYou} need you.` : "For you"}
      className={cn(
        "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted transition-colors pointer-coarse:h-10",
        "hover:bg-surface-2 hover:text-fg",
        "data-[active=true]:bg-surface-2 data-[active=true]:text-fg",
        rail.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100"
      />
      <SendIcon className="size-4 shrink-0" />
      {rail.collapsed ? null : (
        <>
          <span className="min-w-0 truncate">For you</span>
          {needsYou > 0 ? (
            <span className="ml-auto font-mono text-2xs tabular-nums text-fg-subtle group-data-[active=true]:text-brand">
              {needsYou}
            </span>
          ) : null}
        </>
      )}
    </Link>
  );

  if (props.embedded) return link;
  return (
    <nav aria-label="For you" className={cn("mt-2 grid px-2", rail.collapsed && "justify-center")}>
      {link}
    </nav>
  );
}
