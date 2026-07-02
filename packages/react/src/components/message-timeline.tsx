import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckIcon,
  PauseIcon,
  PencilLineIcon,
  PlayIcon,
  TargetIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { formatRelativeTime, truncate } from "../lib/format";
import { Markdown } from "./markdown";
import {
  ActivityRail,
  buildTimeline,
  defaultToolRegistry,
  groupTimeline,
  LightboxProvider,
  type ActivityItem,
  type AgentMessageItem,
  type GoalItem,
  type NoticeItem,
  type TimelineGroup,
  type TimelineItem,
  type ToolRegistry,
  type UserMessageItem,
  TurnSummary,
} from "../timeline";
import { SESSION_STATUS_META, StatusDot } from "./session-status";
import { EntranceAnimationProvider, useEntranceAnimation } from "../timeline/entrance";

export type MessageTimelineProps = {
  /** Raw session events (projected internally) … */
  events?: SessionEvent[] | undefined;
  /** … or pre-projected items (e.g. from `useSessionEvents().timeline`). */
  items?: TimelineItem[] | undefined;
  /** Current session status; drives the live "working" indicator. */
  status?: SessionStatus | null | undefined;
  /** Plug a markdown renderer for message bodies (e.g. streamdown). */
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
  /** Drill into a spawned worker session. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /**
   * The tool-renderer registry that resolves how each tool call is drawn.
   * Defaults to {@link defaultToolRegistry}; pass a registry from
   * `createDefaultToolRegistry({ entries })` to add custom tool renderers.
   */
  toolRegistry?: ToolRegistry | undefined;
  /** Follow new events when pinned to the bottom. Defaults to true. */
  autoFollow?: boolean | undefined;
  /** Older durable history exists above the current window (see useSessionEvents). */
  hasOlder?: boolean | undefined;
  /** An older window is being fetched; shows the quiet top shimmer. */
  loadingOlder?: boolean | undefined;
  /** Called when the reader nears the top and older history should backfill. */
  onLoadOlder?: (() => void) | undefined;
  emptyState?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * The session timeline: chat messages with streaming deltas, collapsed
 * activity clusters (reasoning, tool calls, sandbox work), spawned-worker
 * cards, goal markers, and status transitions. Owns stick-to-bottom scrolling
 * with a "jump to latest" affordance when the reader scrolls back.
 */
export function MessageTimeline({
  events,
  items,
  status,
  renderMessageText,
  onOpenSession,
  toolRegistry = defaultToolRegistry,
  autoFollow = true,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  emptyState,
  className,
}: MessageTimelineProps) {
  const resolvedItems = useMemo(() => items ?? buildTimeline(events ?? []), [items, events]);
  const groups = useMemo(() => groupTimeline(resolvedItems), [resolvedItems]);
  const firstGroupKey = groups[0] ? timelineGroupKey(groups[0]) : null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const previousBulkFirstKeyRef = useRef<string | null | undefined>(undefined);
  const [pinned, setPinned] = useState(true);
  const [bulkActive, setBulkActive] = useState(true);
  // Content stays invisible until its first bottom-anchored frame, so a flash
  // of the window's TOP while a large timeline lays out across commits is
  // structurally impossible — the reader only ever sees it already at the
  // bottom. An empty timeline reveals immediately (there is nothing to anchor).
  const [revealed, setRevealed] = useState(false);
  // Our own scrollTop assignments echo back as scroll events; those must never
  // UNPIN the reader (they are not reader intent). Marked around every
  // programmatic assignment and consumed by onScroll. When an assignment is a
  // NO-OP (already at the target) no scroll event will fire, so the mark must
  // self-clear — a stale mark would eat the reader's next real scroll-up.
  const programmaticScrollRef = useRef(false);
  const assignScrollTop = useCallback((node: HTMLElement, value: number) => {
    const previous = node.scrollTop;
    programmaticScrollRef.current = true;
    node.scrollTop = value;
    if (node.scrollTop === previous) {
      programmaticScrollRef.current = false;
    }
  }, []);
  // Mirror `pinned` into a ref so the ResizeObserver callback (a stable closure)
  // always reads the live value without re-subscribing on every scroll.
  const pinnedRef = useRef(true);
  // The reader's visual anchor: the topmost still-visible timeline element and
  // its offset from the viewport top. Recaptured on scroll and after every
  // height change, it lets us hold the reader's position when content above the
  // viewport expands or collapses (e.g. a turn folds when it settles).
  const anchorRef = useRef<{ el: Element; top: number } | null>(null);
  const lastItem = resolvedItems[resolvedItems.length - 1];
  const streaming = lastItem !== undefined && (lastItem.kind === "agent-message" || lastItem.kind === "reasoning") && lastItem.streaming;
  const working = status === "running" && !streaming;
  // Bulk paints (the initial tail window, a prepended older window — detected
  // by the first group key changing) must not run per-row entrance animations.
  const firstKeyChangedForBulk = previousBulkFirstKeyRef.current !== undefined && previousBulkFirstKeyRef.current !== firstGroupKey;
  const bulkRender = groups.length > 0 && (bulkActive || firstKeyChangedForBulk);

  // Snapshot the topmost visible element and where it sits in the viewport, so a
  // later reflow can restore it to the same spot. Transient chrome (the backfill
  // sentinel and shimmer) is skipped — anchoring to a row that unmounts when the
  // older window lands would drop the correction mid-prepend.
  const captureAnchor = useCallback(() => {
    const node = scrollRef.current;
    const inner = node?.firstElementChild;
    if (!node || !inner) {
      anchorRef.current = null;
      return;
    }
    const containerTop = node.getBoundingClientRect().top;
    for (const child of Array.from(inner.children)) {
      if (child instanceof HTMLElement && child.dataset.ogTimelineChrome !== undefined) {
        continue;
      }
      const rect = child.getBoundingClientRect();
      if (rect.bottom > containerTop + 1) {
        anchorRef.current = { el: child, top: rect.top - containerTop };
        return;
      }
    }
    anchorRef.current = null;
  }, []);

  // Follow the stream while pinned to the bottom; never fight the reader.
  // A LAYOUT effect so the very first paint of a freshly loaded session is
  // already anchored at the bottom — no visible traversal down the history.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && autoFollow && pinned) {
      assignScrollTop(node, node.scrollHeight);
    }
    if (!revealed && groups.length > 0) {
      setRevealed(true);
    }
  }, [resolvedItems, working, autoFollow, pinned, revealed, groups.length, assignScrollTop]);

  // A cleared timeline (stream identity change) re-arms the reveal so the next
  // session also first paints at its bottom.
  useLayoutEffect(() => {
    if (groups.length === 0 && revealed) {
      setRevealed(false);
    }
  }, [groups.length, revealed]);

  // Clear the bulk-paint marker a frame after it renders, so rows appended
  // live (streams, new turns) animate exactly as before.
  useLayoutEffect(() => {
    previousBulkFirstKeyRef.current = firstGroupKey;
    if (!bulkRender) {
      return;
    }
    setBulkActive(true);
    const frame = requestFrame(() => setBulkActive(false));
    return () => cancelFrame(frame);
  }, [bulkRender, firstGroupKey]);

  // Prefetch older history well before the reader reaches the top: the
  // sentinel sits above the first group and trips 1600px early, so backfill
  // is usually rendered (and anchored by the ResizeObserver below) before the
  // top of the window ever becomes visible.
  useEffect(() => {
    const root = scrollRef.current;
    const target = topSentinelRef.current;
    if (!root || !target || !hasOlder || loadingOlder || !onLoadOlder || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadOlder();
      }
    }, { root, rootMargin: "1600px 0px 0px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlder, loadingOlder, onLoadOlder, firstGroupKey]);

  // Scroll anchoring: when the content reflows (a fold expands/collapses, a
  // stream appends), keep following the bottom if pinned; otherwise pin the
  // reader's anchor in place. A change ABOVE the anchor shifts its viewport
  // offset — we correct scrollTop by that shift so the reader never gets yanked.
  // A change BELOW the anchor (a bottom append while scrolled up) leaves the
  // anchor put, so `diff` is 0 and we leave scrollTop alone.
  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.firstElementChild;
    if (!node || !inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const current = scrollRef.current;
      if (!current) {
        return;
      }
      if (autoFollow && pinnedRef.current) {
        assignScrollTop(current, current.scrollHeight);
      } else {
        const anchor = anchorRef.current;
        if (anchor && anchor.el.isConnected) {
          const containerTop = current.getBoundingClientRect().top;
          const now = anchor.el.getBoundingClientRect().top - containerTop;
          const diff = now - anchor.top;
          if (diff !== 0) {
            assignScrollTop(current, current.scrollTop + diff);
          }
        }
      }
      captureAnchor();
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [autoFollow, captureAnchor, assignScrollTop]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const programmatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;
    const nextPinned = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    // Echoes of our own assignments may PIN but never UNPIN — only the reader
    // scrolling away releases the bottom-follow.
    if (nextPinned || !programmatic) {
      pinnedRef.current = nextPinned;
      setPinned(nextPinned);
    }
    captureAnchor();
  };

  return (
    <LightboxProvider>
    <EntranceAnimationProvider value={!bulkRender}>
    <div className={cn("og-root relative flex min-h-0 flex-col", className)}>
      {/* overflow-anchor off: the browser's native scroll anchoring would fight
          the ResizeObserver corrections above — one authority only. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={groups.length > 0 && !revealed ? { visibility: "hidden" } : undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 [overflow-anchor:none] sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {groups.length === 0 && !working
            ? (emptyState ?? <p className="py-10 text-center text-sm text-og-fg-subtle">No activity yet.</p>)
            : null}
          {hasOlder ? <div ref={topSentinelRef} data-og-top-sentinel="" data-og-timeline-chrome="" aria-hidden="true" className="h-px w-full shrink-0" /> : null}
          {loadingOlder ? (
            <div data-og-timeline-chrome="" className="flex items-center gap-2 text-sm">
              <span className="og-shimmer-text font-medium">Loading earlier activity…</span>
            </div>
          ) : null}
          {groups.map((group) => (
            <TimelineGroupView
              key={timelineGroupKey(group)}
              group={group}
              renderMessageText={renderMessageText}
              onOpenSession={onOpenSession}
              toolRegistry={toolRegistry}
            />
          ))}
          {working ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="og-shimmer-text font-medium">Working…</span>
            </div>
          ) : null}
        </div>
      </div>
      <AnimatePresence>
        {!pinned && autoFollow ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onClick={() => {
              const node = scrollRef.current;
              if (node) {
                node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
              }
              pinnedRef.current = true;
              setPinned(true);
            }}
            className={cn(
              "absolute bottom-4 left-1/2 -translate-x-1/2",
              "inline-flex items-center gap-1.5 rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1.5",
              "text-xs font-medium text-og-fg shadow-og-md backdrop-blur",
              "hover:border-og-border-strong",
            )}
          >
            <ArrowDownIcon className="size-3.5" />
            Jump to latest
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
    </EntranceAnimationProvider>
    </LightboxProvider>
  );
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

function TimelineGroupView({
  group,
  renderMessageText,
  onOpenSession,
  toolRegistry,
  insideTurn = false,
}: {
  group: TimelineGroup;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  toolRegistry: ToolRegistry;
  /** Rendering inside an expanded turn group: the outer chip already owns the
      failure surface, so nested chips stay tinted but quiet (no repeated
      failure text, no auto-open) — one loud error, N calm sub-expands. */
  insideTurn?: boolean;
}) {
  switch (group.kind) {
    case "activity":
      return group.outcome ? (
        <TurnSummary
          items={group.items}
          outcome={group.outcome}
          failureText={insideTurn ? undefined : group.failureText}
          defaultOpen={!insideTurn && group.outcome === "failed" ? true : undefined}
        >
          <ActivityRail items={group.items} onOpenSession={onOpenSession} toolRegistry={toolRegistry} />
        </TurnSummary>
      ) : (
        <ActivityRail items={group.items} onOpenSession={onOpenSession} toolRegistry={toolRegistry} />
      );
    case "turn": {
      const activityItems = flattenActivityItems(group.groups);
      return (
        <TurnSummary
          items={activityItems}
          outcome={group.outcome}
          failureText={group.failureText}
          durationMs={durationBetween(group.startedAt, group.endedAt)}
          defaultOpen={group.outcome === "failed" ? true : undefined}
        >
          {/* The body wears the timeline's rail language (matching ActivityRail)
              so nested chips read as contained by the turn, not as siblings. */}
          <div className="flex flex-col gap-4 border-l-2 border-og-border pl-3 sm:pl-4">
            {group.groups.map((child) => (
              <TimelineGroupView
                key={timelineGroupKey(child)}
                group={child}
                renderMessageText={renderMessageText}
                onOpenSession={onOpenSession}
                toolRegistry={toolRegistry}
                insideTurn
              />
            ))}
          </div>
        </TurnSummary>
      );
    }
    case "item":
      return <TimelineRow item={group.item} renderMessageText={renderMessageText} />;
  }
}

function timelineGroupKey(group: TimelineGroup): string {
  switch (group.kind) {
    case "item":
      return group.item.id;
    case "activity":
      return group.id;
    case "turn":
      return group.id;
  }
}

function flattenActivityItems(groups: TimelineGroup[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const group of groups) {
    if (group.kind === "activity") {
      items.push(...group.items);
    } else if (group.kind === "turn") {
      items.push(...flattenActivityItems(group.groups));
    }
  }
  return items;
}

function durationBetween(startedAt: string, endedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return undefined;
  }
  return ended - started;
}

/* --- single rows ------------------------------------------------------------ */

/**
 * Render one non-activity timeline item (chat message, status divider, goal
 * landmark, notice). Exported so the component demo draws the EXACT same rows as
 * the live app — no forked bubble/goal markup.
 */
export function TimelineRow({
  item,
  renderMessageText,
}: {
  item: TimelineItem;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
}) {
  switch (item.kind) {
    case "user-message":
      return <UserMessageRow item={item} renderMessageText={renderMessageText} />;
    case "agent-message":
      return <AgentMessageRow item={item} renderMessageText={renderMessageText} />;
    case "session-status":
      return <SessionStatusRow item={item} />;
    case "goal":
      return <GoalRow item={item} />;
    case "notice":
      return <NoticeRow item={item} />;
    default:
      return null;
  }
}

function UserMessageRow({
  item,
  renderMessageText,
}: {
  item: UserMessageItem;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
}) {
  const enter = useEntranceAnimation();
  return (
    <div className={cn(enter && "animate-og-enter", "flex justify-end")}>
      <div className="flex max-w-[85%] min-w-0 flex-col items-end gap-1">
        {item.pending ? <span className="px-1 text-og-xs text-og-fg-subtle">queued</span> : null}
        <div className="w-fit max-w-full min-w-0 rounded-og-lg rounded-br-og-xs border border-og-border bg-og-surface-2 px-4 py-2.5 text-og-md leading-6 text-og-fg">
          {renderMessageText ? renderMessageText(item.text, item) : <Markdown>{item.text}</Markdown>}
        </div>
      </div>
    </div>
  );
}

function AgentMessageRow({
  item,
  renderMessageText,
}: {
  item: AgentMessageItem;
  renderMessageText?: ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
}) {
  const enter = useEntranceAnimation();
  const caret = item.streaming ? (
    <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-og-blink rounded-full bg-og-accent" aria-hidden />
  ) : null;
  return (
    <div className={cn(enter && "animate-og-enter", "min-w-0 text-og-md leading-7 text-og-fg")}>
      {renderMessageText ? (
        <>
          {renderMessageText(item.text, item)}
          {caret}
        </>
      ) : (
        // While streaming, let the caret ride the end of the last rendered line:
        // the trailing block (usually a <p>) flows inline so the caret sits on
        // its baseline instead of dropping to a new line.
        <div className={item.streaming ? "[&_>div>:last-child]:inline" : undefined}>
          <Markdown>{item.text}</Markdown>
          {caret}
        </div>
      )}
    </div>
  );
}

function SessionStatusRow({ item }: { item: { status: SessionStatus; occurredAt: string } }) {
  const enter = useEntranceAnimation();
  const meta = SESSION_STATUS_META[item.status];
  return (
    <div className={cn(enter && "animate-og-enter", "flex items-center gap-3 text-og-xs text-og-fg-subtle")} role="status">
      <span className="h-px flex-1 bg-og-border" />
      <span className="inline-flex items-center gap-1.5">
        <StatusDot status={item.status} className="size-1" />
        {meta.label.toLowerCase()} · {formatRelativeTime(item.occurredAt)}
      </span>
      <span className="h-px flex-1 bg-og-border" />
    </div>
  );
}

/**
 * The per-action presentation of a goal landmark pill. Each of the six goal
 * actions reads distinctly, but the palette stays quiet — color is spent only on
 * the two states that genuinely earn it, the rest are neutral pills set apart by
 * their glyph alone:
 *
 *   completed   success      green (status-idle) check — the only "done" hue
 *   paused      attention    waiting-tinted pause — a held goal asks to resume
 *   set         a landmark   a quiet accent target — opening a fresh goal
 *   resumed     forward      neutral play — motion picking back up
 *   updated     a revision   neutral pencil — the goal text changed
 *   continuation steady on   neutral arrow — still tracking the same goal
 *
 * The pill class is the established badge convention (`text-X border-X/30
 * bg-X/10`); neutral actions reuse the surface/border tokens so a clean run of
 * landmarks stays calm rather than a row of colored chips.
 */
type GoalMeta = { label: string; pill: string; icon: ComponentType<{ className?: string }> };

const NEUTRAL_PILL = "border-og-border bg-og-surface-1 text-og-fg-muted";

const GOAL_META: Record<GoalItem["action"], GoalMeta> = {
  set: { label: "Goal set", pill: "border-og-accent/30 bg-og-accent/10 text-og-accent", icon: TargetIcon },
  updated: { label: "Goal updated", pill: NEUTRAL_PILL, icon: PencilLineIcon },
  completed: { label: "Goal completed", pill: "border-og-status-idle/30 bg-og-status-idle/10 text-og-status-idle", icon: CheckIcon },
  paused: { label: "Goal paused", pill: "border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting", icon: PauseIcon },
  resumed: { label: "Goal resumed", pill: NEUTRAL_PILL, icon: PlayIcon },
  continuation: { label: "Continuing toward the goal", pill: NEUTRAL_PILL, icon: ArrowRightIcon },
};

/**
 * A goal landmark pill. Resolves its label, accent/tone, and glyph from
 * {@link GOAL_META} so all six actions are visually distinguishable while the
 * palette stays restrained — see that table for the per-action rationale.
 */
function GoalRow({ item }: { item: GoalItem }) {
  const enter = useEntranceAnimation();
  const { label, pill, icon: Icon } = GOAL_META[item.action];
  return (
    <div className={cn(enter && "animate-og-enter", "flex justify-center")}>
      <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-og-sm", pill)}>
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">
          {label}
          {item.text ? `: ${truncate(item.text, 90)}` : ""}
        </span>
      </span>
    </div>
  );
}

function NoticeRow({ item }: { item: NoticeItem }) {
  const enter = useEntranceAnimation();
  const tone =
    item.tone === "failed"
      ? "border-og-status-failed/35 bg-og-status-failed/10 text-og-status-failed"
      : item.tone === "waiting"
        ? "border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting"
        : "border-og-border bg-og-surface-1 text-og-fg-muted";
  return (
    <div className={cn(enter && "animate-og-enter", "flex items-start gap-2.5 rounded-og-md border px-3.5 py-2.5 text-sm", tone)} role="status">
      <TriangleAlertIcon className={cn("mt-0.5 size-4 shrink-0", item.tone === "cancelled" && "opacity-60")} />
      <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
    </div>
  );
}
