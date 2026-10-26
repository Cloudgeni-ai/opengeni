import { useRouterState } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useKnowledgeReviewIndicator } from "./use-knowledge-review-indicator";
import { useScheduledTaskAttentionIndicator } from "./use-scheduled-task-attention";
import { useMeetingRecorderState } from "@opengeni/react/meetings";
import { InboxLink } from "@/components/rail/inbox-link";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { WorkspaceConfigLink } from "@/components/rail/workspace-config-link";
import {
  isConfigItemActive,
  PRIMARY_WORKSPACE_ITEMS,
  primaryWorkspaceItems,
} from "@/components/rail/workspace-nav-data";
import { useAgentProfilesEnabled } from "@opengeni/react/app/lib/agent-profiles";
import { Button } from "@opengeni/react/ui/button";
import { cn } from "@opengeni/react/app/lib/utils";

const WORKSPACE_SHORTCUTS_EXPANDED_KEY = "opengeni.rail.nav";

function initialWorkspaceShortcutsExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SHORTCUTS_EXPANDED_KEY);
    return raw === "true";
  } catch {
    return true;
  }
}

export function WorkspaceShortcutLinks({
  className,
  pending,
  scheduleAttention,
}: {
  className?: string;
  pending?: boolean;
  scheduleAttention?: boolean;
}) {
  const rail = useRail();
  const fetchedPending = useKnowledgeReviewIndicator(rail.workspaceId, pending === undefined);
  const pendingKnowledge = pending ?? fetchedPending;
  const fetchedAttention = useScheduledTaskAttentionIndicator(
    rail.workspaceId,
    scheduleAttention === undefined,
  );
  const schedulesNeedAttention = scheduleAttention ?? fetchedAttention;
  const recorderState = useMeetingRecorderState();
  const recording = recorderState === "recording" || recorderState === "paused";
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = primaryWorkspaceItems({ agentProfiles: useAgentProfilesEnabled() });

  return (
    <div className={cn("grid gap-0.5", className)}>
      {items.map((item) => (
        <WorkspaceConfigLink
          key={item.to}
          item={item}
          needsReview={item.to === "/workspaces/$workspaceId/state" && pendingKnowledge}
          needsAttention={
            item.to === "/workspaces/$workspaceId/automations" && schedulesNeedAttention
          }
          recording={item.to === "/workspaces/$workspaceId/meetings" && recording}
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

/**
 * The web app's primary navigation after the shared "New session" link: the
 * inbox and the workspace shortcuts, kept separate from workspace administration.
 */
export function PrimaryNavExtras() {
  const rail = useRail();
  const pendingKnowledge = useKnowledgeReviewIndicator(rail.workspaceId);
  const schedulesNeedAttention = useScheduledTaskAttentionIndicator(rail.workspaceId);
  const recorderState = useMeetingRecorderState();
  const recordingMeeting = recorderState === "recording" || recorderState === "paused";
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeWorkspaceItem = PRIMARY_WORKSPACE_ITEMS.find((item) =>
    isConfigItemActive(pathname, rail.workspaceId, item.to),
  );
  const activeWorkspaceSection = activeWorkspaceItem?.label;
  const [shortcutsExpanded, setShortcutsExpandedState] = useState(
    initialWorkspaceShortcutsExpanded,
  );
  const [shortViewport, setShortViewport] = useState(
    () => typeof window !== "undefined" && window.innerHeight < 720,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-height: 719px)");
    const update = () => setShortViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const showShortcuts = !shortViewport || shortcutsExpanded;
  const setShortcutsExpanded = (next: boolean) => {
    setShortcutsExpandedState(next);
    try {
      window.localStorage.setItem(WORKSPACE_SHORTCUTS_EXPANDED_KEY, String(next));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  };

  return (
    <>
      <InboxLink />

      {rail.isMobile ? null : rail.collapsed ? (
        <WorkspaceShortcutLinks
          pending={pendingKnowledge}
          scheduleAttention={schedulesNeedAttention}
        />
      ) : (
        <div className="grid gap-0.5">
          {showShortcuts ? (
            <>
              <WorkspaceShortcutLinks
                pending={pendingKnowledge}
                scheduleAttention={schedulesNeedAttention}
              />
              {shortViewport ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded="true"
                  onClick={() => setShortcutsExpanded(false)}
                  className="h-6 w-full justify-start gap-1.5 px-2.5 text-2xs font-normal text-fg-muted hover:text-fg"
                >
                  <ChevronDownIcon aria-hidden="true" className="size-3 rotate-180" />
                  Less
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {pendingKnowledge ? (
                <WorkspaceConfigLink
                  item={
                    PRIMARY_WORKSPACE_ITEMS.find(
                      (item) => item.to === "/workspaces/$workspaceId/state",
                    )!
                  }
                  workspaceId={rail.workspaceId}
                  variant="rail"
                  needsReview
                  active={isConfigItemActive(
                    pathname,
                    rail.workspaceId,
                    "/workspaces/$workspaceId/state",
                  )}
                  onNavigate={() => rail.setDrawerOpen(false)}
                />
              ) : null}
              {schedulesNeedAttention ? (
                <WorkspaceConfigLink
                  item={
                    PRIMARY_WORKSPACE_ITEMS.find(
                      (item) => item.to === "/workspaces/$workspaceId/automations",
                    )!
                  }
                  workspaceId={rail.workspaceId}
                  variant="rail"
                  needsAttention
                  active={isConfigItemActive(
                    pathname,
                    rail.workspaceId,
                    "/workspaces/$workspaceId/automations",
                  )}
                  onNavigate={() => rail.setDrawerOpen(false)}
                />
              ) : null}
              {recordingMeeting ? (
                <WorkspaceConfigLink
                  item={
                    PRIMARY_WORKSPACE_ITEMS.find(
                      (item) => item.to === "/workspaces/$workspaceId/meetings",
                    )!
                  }
                  workspaceId={rail.workspaceId}
                  variant="rail"
                  recording
                  active={isConfigItemActive(
                    pathname,
                    rail.workspaceId,
                    "/workspaces/$workspaceId/meetings",
                  )}
                  onNavigate={() => rail.setDrawerOpen(false)}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded="false"
                aria-label={
                  activeWorkspaceSection
                    ? `More, current section ${activeWorkspaceSection}`
                    : undefined
                }
                data-active={activeWorkspaceSection ? "true" : undefined}
                onClick={() => setShortcutsExpanded(true)}
                className={cn(
                  "group relative w-full justify-start gap-2.5 px-2.5 font-normal text-fg-label pointer-coarse:h-10",
                  activeWorkspaceSection && "bg-selection text-fg hover:bg-selection",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity",
                    activeWorkspaceSection ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-left">More</span>
                <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}
