import { useRouterState } from "@tanstack/react-router";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { navEntryKey, useHiddenNavEntries } from "./hidden-nav-entries";
import {
  arrangeNav,
  moveNavEntry,
  NAV_GROUP_KEY,
  stepNavEntry,
  type NavArrangement,
} from "./nav-order";
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";
import { RailNewSessionLink } from "@opengeni/react/app/components/rail/rail-sections";
import { userErrorText } from "@opengeni/react/ui/api-error";
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
  entries,
}: {
  className?: string;
  pending?: boolean;
  scheduleAttention?: boolean;
  /** Entries placed among the shortcuts in the person's order: "New session" and Inbox. */
  entries?: Readonly<Record<string, React.ReactNode>>;
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
  const order = useNavOrder(rail.workspaceId);
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
  // The person's order: the extra entries first, as the rail always had them,
  // then the shortcuts and the group.
  const items = new Map<string, WorkspaceConfigItem>();
  for (const item of [...front, ...group.items]) items.set(navEntryKey(navItemKey(item)), item);
  const extraKeys = Object.keys(entries ?? {});
  const arrangement = order.arrange({
    top: [...extraKeys, ...front.map((item) => navEntryKey(navItemKey(item))), NAV_GROUP_KEY],
    group: group.items.map((item) => navEntryKey(navItemKey(item))),
  });
  const visible = (key: string) =>
    key in (entries ?? {}) || (items.has(key) && shown(items.get(key)!));
  const grouped = arrangement.group.filter(visible);
  const surfacedKeys = grouped.filter((key) => {
    const item = items.get(key);
    return (
      !!item && (active(item) || needsReview(item) || needsAttention(item) || recordingHere(item))
    );
  });
  // The group opens and closes only when asked. Closed, it still shows the
  // page you are on and anything waiting for you, so nothing is folded away.
  const groupOpen = groupExpanded;
  const canMove = order.canChange && !rail.collapsed;
  // What the rail shows right now, so a keyboard move always moves past
  // something you can see.
  const onScreen = (key: string) =>
    key === NAV_GROUP_KEY
      ? grouped.length > 0
      : arrangement.group.includes(key)
        ? groupOpen
          ? visible(key)
          : surfacedKeys.includes(key)
        : // A hidden Inbox shows only while something waits there; step past it.
          visible(key) && !(key === "inbox" && hiddenEntries.inbox);
  const [moved, setMoved] = useState("");
  const labelOf = (key: string) =>
    key === NAV_GROUP_KEY
      ? group.label
      : (items.get(key)?.label ?? EXTRA_ENTRY_LABELS[key] ?? key.replace(/_/g, " "));
  const step = (key: string, direction: -1 | 1) => {
    const next = stepNavEntry(arrangement, key, direction, groupOpen, onScreen);
    if (!next) return;
    order.save(next);
    // A changed text each time, so the same move twice is announced twice.
    const text = `Moved ${labelOf(key)} ${direction < 0 ? "up" : "down"}.`;
    setMoved((current) => (current === text ? `${text}\u200b` : text));
  };
  const entry = (key: string) => {
    const content = entries?.[key] ?? (items.has(key) ? link(items.get(key)!) : null);
    if (!content) return null;
    return (
      <NavDragRow
        key={key}
        entryKey={key}
        canMove={canMove}
        onDrop={(dragged, at) => order.save(moveNavEntry(arrangement, dragged, key, at))}
        onStep={(direction) => step(key, direction)}
      >
        {content}
      </NavDragRow>
    );
  };
  const groupBlock =
    grouped.length === 0 ? null : rail.collapsed ? (
      // The icon rail has no room for a group: its pages keep their icons.
      <Fragment key={NAV_GROUP_KEY}>{grouped.map(entry)}</Fragment>
    ) : (
      <Fragment key={NAV_GROUP_KEY}>
        <NavDragRow
          entryKey={NAV_GROUP_KEY}
          canMove={canMove}
          group
          onDrop={(dragged, at) =>
            order.save(moveNavEntry(arrangement, dragged, NAV_GROUP_KEY, at))
          }
          onStep={(direction) => step(NAV_GROUP_KEY, direction)}
        >
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
        </NavDragRow>
        {groupOpen || surfacedKeys.length > 0 ? (
          <div className="grid gap-0.5 pl-3">{(groupOpen ? grouped : surfacedKeys).map(entry)}</div>
        ) : null}
      </Fragment>
    );

  return (
    <div className={cn("grid gap-0.5", className)}>
      {arrangement.top.map((key) =>
        key === NAV_GROUP_KEY ? groupBlock : visible(key) ? entry(key) : null,
      )}
      {unlistedRecording.map(link)}
      {canMove ? (
        <span aria-live="polite" className="sr-only">
          {moved}
        </span>
      ) : null}
    </div>
  );
}

const EXTRA_ENTRY_LABELS: Readonly<Record<string, string>> = {
  new_session: "New session",
  inbox: "Inbox",
};

const NAV_DRAG_TYPE = "application/x-opengeni-rail-entry";

/**
 * One built-in rail entry the person can drag to another place (onto the
 * group's name to put it inside), or move with Alt+ArrowUp and Alt+ArrowDown.
 */
function NavDragRow({
  entryKey,
  canMove,
  group,
  onDrop,
  onStep,
  children,
}: {
  entryKey: string;
  canMove: boolean;
  /** The group's name: the middle of it drops into the group. */
  group?: boolean;
  onDrop: (dragged: string, at: "before" | "after" | "into") => void;
  onStep: (direction: -1 | 1) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState<"before" | "after" | "into" | null>(null);
  if (!canMove) return <>{children}</>;
  const zone = (event: React.DragEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - box.top) / Math.max(box.height, 1);
    if (group && y > 0.25 && y < 0.75) return "into" as const;
    return y < 0.5 ? ("before" as const) : ("after" as const);
  };
  const accepts = (event: React.DragEvent<HTMLDivElement>) =>
    event.dataTransfer.types.includes(NAV_DRAG_TYPE);
  return (
    <div
      className="relative"
      data-nav-entry={entryKey}
      draggable
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.setData(NAV_DRAG_TYPE, entryKey);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(zone(event));
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(null);
        const dragged = event.dataTransfer.getData(NAV_DRAG_TYPE);
        if (dragged) onDrop(dragged, zone(event));
      }}
      onKeyDown={(event) => {
        if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const focused = event.currentTarget;
        onStep(event.key === "ArrowUp" ? -1 : 1);
        // Keep the moved entry focused once it renders in its new place.
        requestAnimationFrame(() =>
          focused.ownerDocument
            .querySelector<HTMLElement>(
              `[data-nav-entry="${entryKey}"] a, [data-nav-entry="${entryKey}"] button`,
            )
            ?.focus(),
        );
      }}
      data-drop={over ?? undefined}
    >
      {over === "before" || over === "after" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-brand",
            over === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      {over === "into" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-md ring-2 ring-brand"
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * The person's own order of the rail's entries: the saved one (or the
 * default's), and while a change saves, that change, so a drop shows at once.
 */
function useNavOrder(workspaceId: string) {
  const { layout, options, update } = useSidebarLayout(workspaceId);
  const [pending, setPending] = useState<NavArrangement | null>(null);
  const savedOrder = options?.navOrder ?? null;
  const savedGroup = options?.navSetup ?? null;
  return {
    canChange: layout?.personal.available === true,
    arrange: (defaults: NavArrangement) =>
      arrangeNav(defaults, pending?.top ?? savedOrder, pending?.group ?? savedGroup),
    save: (next: NavArrangement | null) => {
      if (!next) return;
      setPending(next);
      void update({
        scope: "personal",
        changes: [{ op: "options", navOrder: next.top, navSetup: next.group }],
      })
        .catch((error: unknown) =>
          toast.error("Couldn't change the sidebar", { description: userErrorText(error) }),
        )
        .finally(() => setPending((current) => (current === next ? null : current)));
    },
  };
}

/**
 * The web app's primary navigation: "New session", the inbox and the
 * workspace shortcuts in the person's order, kept separate from workspace
 * administration.
 */
export function PrimaryNavExtras() {
  const rail = useRail();
  const pendingKnowledge = useKnowledgeReviewIndicator(rail.workspaceId);
  const schedulesNeedAttention = useScheduledTaskAttentionIndicator(rail.workspaceId);
  const hiddenEntries = useHiddenNavEntries(rail.workspaceId);
  const entries = {
    new_session: <RailNewSessionLink />,
    inbox: <InboxLink hiddenUnlessNeeded={hiddenEntries.inbox} />,
  };
  // A few entries up front and the rest under Setup, so no short-screen fold.
  return rail.isMobile ? (
    <>
      {entries.new_session}
      {entries.inbox}
    </>
  ) : (
    <WorkspaceShortcutLinks
      pending={pendingKnowledge}
      scheduleAttention={schedulesNeedAttention}
      entries={entries}
    />
  );
}
