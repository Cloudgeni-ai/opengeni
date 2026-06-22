// The session list — the rail's home. Reuses the same useWorkspaceSessions
// hook the old sessions index used, groups by recency (running pinned on top),
// and supports ArrowUp/Down + Enter keyboard navigation. Each row is a status
// dot + single-line truncated title + hover-revealed relative time. The active
// session (from the URL) is highlighted with an accent bar.
import { useWorkspaceSessions } from "@opengeni/react";
import { useRouterState } from "@tanstack/react-router";
import { MessagesSquareIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRail } from "@/components/rail/rail-context";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { groupSessionsForRail, relativeTimeLabel } from "@/lib/sessions-group";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

export function SessionList() {
  const rail = useRail();
  // Poll so running sessions surface and move to the top without a manual
  // refresh; the previous index relied on a one-shot load.
  const { sessions, loading, error, refresh } = useWorkspaceSessions({ limit: 50, pollIntervalMs: 15_000 });

  const activeSessionId = useRouterState({
    select: (state): string | null => {
      const match = /\/sessions\/([^/]+)/.exec(state.location.pathname);
      return match?.[1] ?? null;
    },
  });

  // Flattened, ordered list (running first, then recency groups) — the keyboard
  // navigation index walks this; the render groups it back into sections.
  const { running, grouped } = useMemo(() => groupSessionsForRail(sessions), [sessions]);
  const flat = useMemo<Session[]>(
    () => [...running, ...grouped.flatMap((bucket) => bucket.sessions)],
    [running, grouped],
  );

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
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
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
              className="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
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
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--color-ring)]/40"
      >
        {loading && sessions.length === 0 ? (
          <SessionListSkeleton />
        ) : error && sessions.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[color:var(--color-fg-subtle)]">
            Session history is unavailable.{" "}
            <button type="button" className="underline hover:text-[color:var(--color-fg)]" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : flat.length === 0 ? (
          <EmptySessions onStart={rail.startNewSession} />
        ) : (
          <>
            {running.length > 0 ? (
              <SessionGroup
                label="Running"
                sessions={running}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                onSelect={rail.openSession}
                running
              />
            ) : null}
            {grouped.map((bucket) => (
              <SessionGroup
                key={bucket.group}
                label={bucket.label}
                sessions={bucket.sessions}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                onSelect={rail.openSession}
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
  sessions: Session[];
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  onSelect: (sessionId: string) => void;
  running?: boolean;
}) {
  return (
    <div className="mb-1.5 min-w-0">
      <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
        {props.label}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-px">
        {props.sessions.map((session) => {
          const index = props.flat.indexOf(session);
          return (
            <SessionRow
              key={session.id}
              session={session}
              index={index}
              active={session.id === props.activeSessionId}
              focused={index === props.focusIndex}
              onSelect={props.onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}

function SessionRow(props: {
  session: Session;
  index: number;
  active: boolean;
  focused: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const title = props.session.initialMessage?.trim() || "Untitled session";
  return (
    <button
      type="button"
      role="listitem"
      data-session-index={props.index}
      onClick={() => props.onSelect(props.session.id)}
      title={title}
      className={cn(
        "group relative flex h-8 w-full items-center gap-2 rounded-md py-1 pl-2.5 pr-3 text-left text-sm transition-colors",
        "hover:bg-[color:var(--color-surface-2)]",
        props.active
          ? "bg-[color:var(--color-surface-3)] font-medium text-[color:var(--color-fg)]"
          : "text-[color:var(--color-fg-muted)]",
        props.focused && !props.active ? "bg-[color:var(--color-surface-2)]/60" : "",
      )}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[color:var(--color-brand)] transition-opacity",
          props.active ? "opacity-100" : "opacity-0",
        )}
      />
      <RailStatusDot status={props.session.status} />
      {/* min-w-0 + truncate: the title must always ellipsis, never butt the rail
          border. The pr-1 keeps a gap before the hover time / right edge. */}
      <span className="min-w-0 flex-1 truncate pr-1">{title}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-[color:var(--color-fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100">
        {relativeTimeLabel(props.session.updatedAt)}
      </span>
    </button>
  );
}

/**
 * Rail-local status dot with the rail's intent semantics: RUNNING reads as a
 * positive, active state (brand blue) with a breathing pulse; FAILED is danger
 * red; everything idle/terminal is a calm muted gray. This deliberately differs
 * from the shared package badge (whose running hue is amber) so a running
 * session in the list never reads as an error.
 */
function RailStatusDot({ status }: { status: Session["status"] }) {
  const running = status === "running" || status === "queued";
  const needsAttention = status === "requires_action";
  const failed = status === "failed";
  const color = running
    ? "var(--color-brand)"
    : needsAttention
      ? "var(--color-status-running)" // app's amber "attention" hue
      : failed
        ? "var(--color-status-failed)"
        : "var(--color-fg-subtle)";
  return (
    <span className="relative inline-flex size-1.5 shrink-0 rounded-full" style={{ backgroundColor: `color-mix(in oklch, ${color} 92%, transparent)` }}>
      {running || needsAttention ? (
        <span className="absolute inset-0 animate-og-pulse rounded-full" style={{ backgroundColor: color }} />
      ) : null}
    </span>
  );
}

function EmptySessions({ onStart }: { onStart: () => void }) {
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-4 text-center">
      <p className="text-xs text-[color:var(--color-fg-subtle)]">No sessions yet</p>
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
  const { sessions } = useWorkspaceSessions({ limit: 50, pollIntervalMs: 15_000 });
  const runningCount = useMemo(() => groupSessionsForRail(sessions).running.length, [sessions]);
  return (
    <div className="flex flex-1 flex-col items-center gap-1 px-2 pt-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Sessions${runningCount > 0 ? ` (${runningCount} running)` : ""}`}
            onClick={() => rail.setCollapsed(false)}
            className="relative text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
          >
            <MessagesSquareIcon className="size-4" />
            {runningCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-[color:var(--color-brand-strong)] px-1 text-[9px] font-semibold leading-tight text-[color:var(--color-brand-fg)]">
                {runningCount}
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Sessions</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New session"
            onClick={rail.startNewSession}
            className="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
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
          <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--color-surface-3)]" />
          <span className="h-3 flex-1 animate-pulse rounded bg-[color:var(--color-surface-2)]" />
        </div>
      ))}
    </div>
  );
}
