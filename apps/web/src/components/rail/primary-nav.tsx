import { useRouterState } from "@tanstack/react-router";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { useHiddenNavEntries } from "./hidden-nav-entries";
import { useKnowledgeReviewIndicator } from "./use-knowledge-review-indicator";
import { useScheduledTaskAttentionIndicator } from "./use-scheduled-task-attention";
import { useMeetingRecorderState } from "@opengeni/react/meetings";
import { InboxLink } from "@/components/rail/inbox-link";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { WorkspaceConfigLink } from "@/components/rail/workspace-config-link";
import {
  groupedWorkspaceItems,
  isNavItemActive,
  navItemKey,
  PRIMARY_WORKSPACE_ITEMS,
  primaryWorkspaceItems,
  type WorkspaceConfigItem,
} from "@/components/rail/workspace-nav-data";
import { useSimplifiedInterface } from "@opengeni/react/app/lib/simplified-interface";
import { Button } from "@opengeni/react/ui/button";
import { cn } from "@opengeni/react/app/lib/utils";

/** Whether the rail's group is open, kept per interface: "Advanced" and "Setup". */
const GROUP_EXPANDED_KEYS = {
  simplified: "opengeni.rail.advanced",
  full: "opengeni.rail.setup",
} as const;

function initialGroupExpanded(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

const MEETINGS = "/workspaces/$workspaceId/meetings";

/** The current page, as the rail's entries tell theirs apart (Apps is Artifacts' Apps tab). */
function useNavLocation(): { pathname: string; kind: string | undefined } {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const kind = useRouterState({
    select: (state) => {
      const value = (state.location.search as { kind?: unknown } | undefined)?.kind;
      return typeof value === "string" ? value : undefined;
    },
  });
  return { pathname, kind };
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
  const location = useNavLocation();
  const { simplified } = useSimplifiedInterface();
  const hiddenEntries = useHiddenNavEntries(rail.workspaceId);
  const front = primaryWorkspaceItems(simplified);
  const group = groupedWorkspaceItems(simplified);
  const groupKey = GROUP_EXPANDED_KEYS[simplified ? "simplified" : "full"];
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>({});
  const groupExpanded = expandedByKey[groupKey] ?? initialGroupExpanded(groupKey);
  const setGroupExpanded = (next: boolean) => {
    setExpandedByKey((current) => ({ ...current, [groupKey]: next }));
    try {
      window.localStorage.setItem(groupKey, String(next));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  };
  const active = (item: WorkspaceConfigItem) => isNavItemActive(location, rail.workspaceId, item);
  const needsReview = (item: WorkspaceConfigItem) =>
    item.to === "/workspaces/$workspaceId/state" && pendingKnowledge;
  const needsAttention = (item: WorkspaceConfigItem) =>
    item.to === "/workspaces/$workspaceId/automations" && schedulesNeedAttention;
  const recordingHere = (item: WorkspaceConfigItem) => recording && item.to === MEETINGS;
  // An entry this person hid still shows while it's the page they're on or
  // something waits for them there.
  const shown = (item: WorkspaceConfigItem) =>
    !hiddenEntries.targets.has(navItemKey(item)) ||
    active(item) ||
    needsReview(item) ||
    needsAttention(item) ||
    recordingHere(item);
  const grouped = group.items.filter(shown);
  // A meeting being recorded keeps its link even where the interface leaves
  // Meetings out, so the recording can always be reached and stopped.
  const unlistedRecording =
    recording && ![...front, ...group.items].some((item) => item.to === MEETINGS)
      ? PRIMARY_WORKSPACE_ITEMS.filter((item) => item.to === MEETINGS)
      : [];
  const link = (item: WorkspaceConfigItem) => (
    <WorkspaceConfigLink
      key={navItemKey(item)}
      item={item}
      needsReview={needsReview(item)}
      needsAttention={needsAttention(item)}
      recording={recordingHere(item)}
      workspaceId={rail.workspaceId}
      variant="rail"
      collapsed={rail.collapsed}
      active={active(item)}
      onNavigate={() => rail.setDrawerOpen(false)}
    />
  );
  // The group opens and closes only when asked. Closed, it still shows the
  // page you are on and anything waiting for you, so nothing is folded away.
  const groupOpen = groupExpanded;
  const surfaced = grouped.filter(
    (item) => active(item) || needsReview(item) || needsAttention(item) || recordingHere(item),
  );

  return (
    <div className={cn("grid gap-0.5", className)}>
      {[...front.filter(shown), ...unlistedRecording].map(link)}
      {grouped.length === 0 ? null : rail.collapsed ? (
        // The icon rail has no room for a group: its pages keep their icons.
        grouped.map(link)
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={groupOpen}
            onClick={() => setGroupExpanded(!groupOpen)}
            className="h-8 w-full justify-start gap-2.5 rounded-md px-2.5 font-normal text-fg-label hover:text-fg pointer-coarse:h-10"
          >
            <SlidersHorizontalIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0 transition-transform", groupOpen && "rotate-180")}
            />
          </Button>
          {groupOpen || surfaced.length > 0 ? (
            <div className="grid gap-0.5 pl-3">{(groupOpen ? grouped : surfaced).map(link)}</div>
          ) : null}
        </>
      )}
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
  const hiddenEntries = useHiddenNavEntries(rail.workspaceId);
  // A few entries up front and the rest under Setup, so no short-screen fold.
  return (
    <>
      <InboxLink hiddenUnlessNeeded={hiddenEntries.inbox} />
      {rail.isMobile ? null : (
        <WorkspaceShortcutLinks
          pending={pendingKnowledge}
          scheduleAttention={schedulesNeedAttention}
        />
      )}
    </>
  );
}
