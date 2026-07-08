// The session list — the rail's home. Reuses the same useWorkspaceSessions
// hook the old sessions index used, groups by recency (running pinned on top),
// and supports ArrowUp/Down + Enter keyboard navigation. Each row is a status
// dot + single-line truncated title + relative time (visible at rest). The
// active session (from the URL) is highlighted with an accent bar.
import { useWorkspaceSessions } from "@opengeni/react";
import { useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon, EllipsisIcon, MessagesSquareIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRail } from "@/components/rail/rail-context";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { SESSION_TITLE_MAX_LENGTH, useInlineRename } from "@/lib/session-rename";
import {
  buildRailForest,
  groupSessionsForRail,
  relativeTimeLabel,
  visibleForestRows,
  type SessionTreeNode,
} from "@/lib/sessions-group";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

type RenameFn = (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;

export function SessionList() {
  const rail = useRail();
  const context = useAppContext();
  // Poll so running sessions surface and move to the top without a manual
  // refresh; the previous index relied on a one-shot load.
  const { sessions, loading, error, refresh } = useWorkspaceSessions({ limit: 50, pollIntervalMs: 15_000 });

  const activeSessionId = useRouterState({
    select: (state): string | null => {
      const match = /\/sessions\/([^/]+)/.exec(state.location.pathname);
      return match?.[1] ?? null;
    },
  });

  // Lineage forest: spawned workers nest under their manager (parentSessionId),
  // running roots pinned. The keyboard navigation walks the VISIBLE rows given
  // the current expand state; the render nests them back into sections.
  const forest = useMemo(() => buildRailForest(sessions), [sessions]);

  // Which parents are expanded. Children start collapsed (the rail stays quiet);
  // the active session's ancestors auto-expand so a deep child is never hidden.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    const byId = new Set(sessions.map((session) => session.id));
    for (const session of sessions) {
      if (session.parentSessionId && byId.has(session.parentSessionId)) {
        map.set(session.id, session.parentSessionId);
      }
    }
    return map;
  }, [sessions]);
  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      let cursor = parentOf.get(activeSessionId);
      let added = false;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        if (!next.has(cursor)) {
          next.add(cursor);
          added = true;
        }
        cursor = parentOf.get(cursor);
      }
      return added ? next : current;
    });
  }, [activeSessionId, parentOf]);
  const toggleExpand = useCallback((sessionId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const visibleRows = useMemo(() => visibleForestRows(forest, expanded), [forest, expanded]);
  const flat = useMemo<Session[]>(() => visibleRows.map((row) => row.node.session), [visibleRows]);

  const listRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState<number>(-1);

  // Keep the keyboard focus index pinned to the active session when the route
  // changes (so ArrowDown continues from where the user is).
  useEffect(() => {
    const index = flat.findIndex((session) => session.id === activeSessionId);
    if (index >= 0) {
      setFocusIndex(index);
    }
  }, [activeSessionId, flat]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (flat.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusIndex((current) => Math.min(flat.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusIndex((current) => Math.max(0, current <= 0 ? 0 : current - 1));
    } else if (event.key === "Enter" && focusIndex >= 0 && focusIndex < flat.length) {
      event.preventDefault();
      const session = flat[focusIndex];
      if (session) {
        rail.openSession(session.id);
      }
    }
  }, [flat, focusIndex, rail]);

  // Scroll the keyboard-focused row into view.
  useEffect(() => {
    if (focusIndex < 0 || !listRef.current) {
      return;
    }
    const row = listRef.current.querySelector<HTMLElement>(`[data-session-index="${focusIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusIndex]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-1 pt-1">
        <span className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
          Sessions
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New session"
              onClick={rail.startNewSession}
              className="text-fg-muted hover:text-fg"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New session · c</TooltipContent>
        </Tooltip>
      </div>

      <div
        ref={listRef}
        role="list"
        aria-label="Sessions"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2 outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {loading && sessions.length === 0 ? (
          <SessionListSkeleton />
        ) : error && sessions.length === 0 ? (
          <div className="px-2 py-3 text-xs text-fg-subtle">
            Session history is unavailable.{" "}
            <button type="button" className="underline hover:text-fg" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : flat.length === 0 ? (
          <EmptySessions onStart={rail.startNewSession} />
        ) : (
          <>
            {forest.running.length > 0 ? (
              <SessionGroup
                label="Running"
                nodes={forest.running}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onSelect={rail.openSession}
                onRename={context.updateSessionTitle}
              />
            ) : null}
            {forest.grouped.map((bucket) => (
              <SessionGroup
                key={bucket.group}
                label={bucket.label}
                nodes={bucket.sessions}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onSelect={rail.openSession}
                onRename={context.updateSessionTitle}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SessionGroup(props: {
  label: string;
  nodes: SessionTreeNode[];
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
  onSelect: (sessionId: string) => void;
  onRename: RenameFn;
}) {
  return (
    <div className="mb-1.5 min-w-0">
      <p className="px-2 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
        {props.label}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-px">
        {props.nodes.map((node) => (
          <SessionTreeRow
            key={node.session.id}
            node={node}
            depth={0}
            flat={props.flat}
            activeSessionId={props.activeSessionId}
            focusIndex={props.focusIndex}
            expanded={props.expanded}
            onToggleExpand={props.onToggleExpand}
            onSelect={props.onSelect}
            onRename={props.onRename}
          />
        ))}
      </div>
    </div>
  );
}

/** True when the URL-active session lives anywhere inside this node's subtree. */
function subtreeContains(node: SessionTreeNode, id: string | null): boolean {
  if (!id) {
    return false;
  }
  return node.children.some((child) => child.session.id === id || subtreeContains(child, id));
}

/** A node plus, when expanded, its spawned children rendered one level deeper. */
function SessionTreeRow(props: {
  node: SessionTreeNode;
  depth: number;
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
  onSelect: (sessionId: string) => void;
  onRename: RenameFn;
}) {
  const { node } = props;
  const index = props.flat.indexOf(node.session);
  const childCount = node.children.length;
  const isExpanded = props.expanded.has(node.session.id);
  // Manual collapse always wins (auto-expand runs only on navigation) — but the
  // OPEN session must never vanish from the rail: a collapsed ancestor hiding
  // the URL-active session carries the active accent in its place, file-tree
  // style, so orientation survives any collapse state.
  const representsHiddenActive = !isExpanded && childCount > 0 && subtreeContains(node, props.activeSessionId);
  return (
    <>
      <SessionRow
        session={node.session}
        index={index}
        depth={props.depth}
        childCount={childCount}
        expanded={isExpanded}
        hasActiveDescendant={node.hasActiveDescendant}
        onToggleExpand={() => props.onToggleExpand(node.session.id)}
        active={node.session.id === props.activeSessionId || representsHiddenActive}
        focused={index >= 0 && index === props.focusIndex}
        onSelect={props.onSelect}
        onRename={props.onRename}
      />
      {childCount > 0 && isExpanded
        ? node.children.map((child) => (
            <SessionTreeRow
              key={child.session.id}
              node={child}
              depth={props.depth + 1}
              flat={props.flat}
              activeSessionId={props.activeSessionId}
              focusIndex={props.focusIndex}
              expanded={props.expanded}
              onToggleExpand={props.onToggleExpand}
              onSelect={props.onSelect}
              onRename={props.onRename}
            />
          ))
        : null}
    </>
  );
}

function SessionRow(props: {
  session: Session;
  index: number;
  /** Nesting depth; children indent one step per level. */
  depth: number;
  /** Spawned-child count; a chevron + badge appear when > 0. */
  childCount: number;
  expanded: boolean;
  /** A descendant is live — a collapsed parent shows a quiet activity dot. */
  hasActiveDescendant: boolean;
  onToggleExpand: () => void;
  active: boolean;
  focused: boolean;
  onSelect: (sessionId: string) => void;
  onRename: RenameFn;
}) {
  const title = props.session.title?.trim() || props.session.initialMessage?.trim() || "Untitled session";
  const rename = useInlineRename(props.session, props.onRename);
  const hasChildren = props.childCount > 0;
  // Indent nested rows; the leading affordance is a chevron for parents, else a
  // spacer of the same width — reserved at every depth (root included) so every
  // status dot sits in one column and the left edge is even whether a row is a
  // leaf or a parent.
  const indentStyle = props.depth > 0 ? { paddingLeft: props.depth * 14 } : undefined;

  const rowClassName = cn(
    "group relative flex h-8 w-full items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 text-left text-sm transition-colors pointer-coarse:h-10",
    "hover:bg-surface-2",
    props.active
      ? "bg-surface-3 font-medium text-fg"
      : "text-fg-muted",
    props.focused && !props.active ? "bg-surface-2/60" : "",
  );

  const lead = (
    <span className="flex shrink-0 items-center" style={indentStyle}>
      {hasChildren ? (
        <button
          type="button"
          aria-label={props.expanded ? "Collapse spawned sessions" : "Expand spawned sessions"}
          aria-expanded={props.expanded}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleExpand();
          }}
          className="inline-flex size-4 items-center justify-center rounded text-fg-subtle outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRightIcon className={cn("size-3 transition-transform", props.expanded && "rotate-90")} />
        </button>
      ) : (
        <span className="size-4" />
      )}
    </span>
  );

  // While renaming, the row body becomes an inline input. Keep it as a
  // listitem so the surrounding list semantics and the active accent bar hold.
  if (rename.editing) {
    return (
      <div role="listitem" data-session-index={props.index} className={rowClassName}>
        <ActiveAccent active={props.active} />
        {lead}
        <RailStatusDot status={props.session.status} />
        <input
          ref={rename.inputRef}
          value={rename.draft}
          onChange={(event) => rename.setDraft(event.target.value)}
          onBlur={() => void rename.commit()}
          onKeyDown={(event) => {
            // Keep keystrokes (incl. Arrow/Enter/Esc) inside the field, away
            // from the list's keyboard navigation.
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              void rename.commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              rename.cancel();
            }
          }}
          maxLength={SESSION_TITLE_MAX_LENGTH}
          aria-label="Session title"
          className="min-w-0 flex-1 truncate rounded-sm bg-transparent text-sm outline-none ring-1 ring-ring/40 focus-visible:ring-ring"
        />
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="listitem"
          data-session-index={props.index}
          onClick={() => props.onSelect(props.session.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onSelect(props.session.id);
            }
          }}
          tabIndex={-1}
          title={title}
          className={cn(rowClassName, "cursor-pointer")}
        >
          <ActiveAccent active={props.active} />
          {lead}
          <RailStatusDot status={props.session.status} />
          {/* min-w-0 + truncate: the title must always ellipsis, never butt the
              rail border. */}
          <span className="min-w-0 flex-1 truncate pr-1">{title}</span>
          {/* A collapsed parent with a live child shows a quiet pulsing dot so
              the activity isn't hidden with the subtree; the count badge sits
              beside it. Both stay visible on hover (the time yields instead). */}
          {hasChildren ? (
            <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums text-fg-subtle">
              {!props.expanded && props.hasActiveDescendant ? (
                <span className="relative inline-flex size-1.5 rounded-full bg-status-running">
                  <span className="absolute inset-0 animate-og-pulse rounded-full bg-status-running" />
                </span>
              ) : null}
              {props.childCount}
            </span>
          ) : null}
          {/* Relative time is visible at rest (the list is grouped by recency),
              and steps aside on hover/focus so the rename overflow can slot in.
              On coarse pointers there is no hover, so the time stays visible. */}
          <span className="shrink-0 text-2xs tabular-nums text-fg-subtle transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:group-hover:opacity-100">
            {relativeTimeLabel(props.session.updatedAt)}
          </span>
          <RowRenameMenu onRename={rename.startEditing} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onSelect={rename.startEditing}>
          <PencilIcon className="size-4" />
          Rename
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The active-session accent bar shared by the row's display and edit modes. */
function ActiveAccent({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand transition-opacity",
        active ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * The hover/focus rename affordance: a small overflow button revealed on row
 * hover (and always visible while keyboard-focused, for a11y) that opens a
 * minimal menu whose primary action is Rename. The button stops click
 * propagation so opening the menu never opens the session.
 */
function RowRenameMenu({ onRename }: { onRename: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Session actions"
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <EllipsisIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem
          onSelect={onRename}
          // The menu item lives inside the row; stop the synthetic click from
          // bubbling to the row's onSelect (open-session).
          onClick={(event) => event.stopPropagation()}
        >
          <PencilIcon className="size-4" />
          Rename
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Rail-local status dot with the app status tokens: running/queued pulse with
 * the running tone, requires-action pulses with the waiting tone, failures use
 * failed, and idle/terminal states fall back to cancelled.
 */
function RailStatusDot({ status }: { status: Session["status"] }) {
  const running = status === "running" || status === "queued";
  const needsAttention = status === "requires_action";
  const failed = status === "failed";
  const tone = running
    ? "bg-status-running"
    : needsAttention
      ? "bg-status-waiting"
      : failed
        ? "bg-status-failed"
        : "bg-status-cancelled";
  return (
    <span className={cn("relative inline-flex size-1.5 shrink-0 rounded-full", tone)}>
      {running || needsAttention ? (
        <span className={cn("absolute inset-0 animate-og-pulse rounded-full", tone)} />
      ) : null}
    </span>
  );
}

function EmptySessions({ onStart }: { onStart: () => void }) {
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
      <p className="text-xs text-fg-subtle">No sessions yet</p>
      <Button type="button" size="sm" onClick={onStart} className="mx-auto">
        <PlusIcon className="size-3.5" />
        Start your first session
      </Button>
    </div>
  );
}

/**
 * Collapsed-rail stand-in for the list: a Sessions icon carrying a count badge
 * of running sessions; clicking expands the rail to reveal the full list.
 */
export function CollapsedSessionsButton() {
  const rail = useRail();
  const { sessions, loading, error } = useWorkspaceSessions({ limit: 50, pollIntervalMs: 15_000 });
  const runningCount = useMemo(() => groupSessionsForRail(sessions).running.length, [sessions]);
  // The collapsed rail can't render the expanded list's loading/error copy, so
  // it mirrors those states: a failed load shows a failed-tone marker + tooltip
  // (expanding reveals the retry), a first load shows a gentle pulse.
  const failed = Boolean(error) && sessions.length === 0;
  const firstLoad = loading && sessions.length === 0;
  const tooltip = failed ? "Session history is unavailable" : "Sessions";
  return (
    <div className="flex flex-1 flex-col items-center gap-1 px-2 pt-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={failed ? "Sessions (history unavailable)" : `Sessions${runningCount > 0 ? ` (${runningCount} running)` : ""}`}
            onClick={() => rail.setCollapsed(false)}
            className="relative text-fg-muted hover:text-fg"
          >
            <MessagesSquareIcon className={cn("size-4", firstLoad && "motion-safe:animate-pulse")} />
            {failed ? (
              <span className="absolute -right-0.5 -top-0.5 flex size-2 rounded-full bg-status-failed" />
            ) : runningCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-brand-strong px-1 text-2xs font-semibold leading-tight text-brand-fg">
                {runningCount}
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New session"
            onClick={rail.startNewSession}
            className="text-fg-muted hover:text-fg"
          >
            <PlusIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">New session · c</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SessionListSkeleton() {
  return (
    <div className="grid gap-1 px-1 pt-2">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex h-8 items-center gap-2 px-1">
          <span className="size-1.5 shrink-0 rounded-full bg-surface-3" />
          <span className="h-3 flex-1 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
