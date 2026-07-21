import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  PauseCircleIcon,
  PauseIcon,
  PencilLineIcon,
  PlayIcon,
  RefreshCwIcon,
  TargetIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Collapsible } from "radix-ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  type AuthNeededItem,
  type GoalItem,
  type NoticeItem,
  type TimelineGroup,
  type TimelineItem,
  type ToolRegistry,
  type UserMessageItem,
  type WorkerCompletionItem,
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
  renderMessageText?:
    | ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode)
    | undefined;
  /** Drill into a spawned worker session. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /**
   * Deep-link a memory row (a `memory.saved` / `memory.corrected` step) to its
   * record in the host's memory pane. Opt-in, exactly like `onReconnect`: the
   * library draws no "View in memory" affordance without a handler — the memory
   * row is then non-interactive rich content. This is the switch that makes the
   * deep-link a first-party OpenGeni capability without other SDK consumers
   * opting into it. The app supplies it (it owns routing to the memory pane).
   */
  onMemoryClick?: ((memoryId: string) => void) | undefined;
  /**
   * Start the reconnect flow when a tool needs its connection reauthorized. The
   * app supplies this (it owns the SDK client + workspace): it typically kicks
   * off `startConnectionOAuth` and redirects, or routes to credential entry.
   * Rejecting surfaces a calm inline error on the card; the library never draws
   * a Reconnect button without a handler to run it.
   */
  onReconnect?: ((item: AuthNeededItem) => void | Promise<void>) | undefined;
  /**
   * Resolve a provider domain (from a reconnect card) to a logo URL the host
   * serves itself — the app maps it through its catalog + `catalogAssetUrl`.
   * Return null/undefined to fall back to a calm monogram. The library never
   * fetches an off-origin favicon (CSP + privacy); an unresolved logo is a
   * monogram, not an external image.
   */
  resolveProviderLogo?: ((providerDomain: string) => string | null | undefined) | undefined;
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
  onMemoryClick,
  onReconnect,
  resolveProviderLogo,
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
  const streaming =
    lastItem !== undefined &&
    (lastItem.kind === "agent-message" || lastItem.kind === "reasoning") &&
    lastItem.streaming;
  const working = status === "running" && !streaming;
  // Bulk paints (the initial tail window, a prepended older window — detected
  // by the first group key changing) must not run per-row entrance animations.
  const firstKeyChangedForBulk =
    previousBulkFirstKeyRef.current !== undefined &&
    previousBulkFirstKeyRef.current !== firstGroupKey;
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
    if (
      !root ||
      !target ||
      !hasOlder ||
      loadingOlder ||
      !onLoadOlder ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadOlder();
        }
      },
      { root, rootMargin: "1600px 0px 0px 0px" },
    );
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
                ? (emptyState ?? (
                    <p className="py-10 text-center text-sm text-og-fg-subtle">No activity yet.</p>
                  ))
                : null}
              {hasOlder ? (
                <div
                  ref={topSentinelRef}
                  data-og-top-sentinel=""
                  data-og-timeline-chrome=""
                  aria-hidden="true"
                  className="h-px w-full shrink-0"
                />
              ) : null}
              {loadingOlder ? (
                <div data-og-timeline-chrome="" className="flex items-center gap-2 text-sm">
                  <span className="og-shimmer-text font-medium">Loading earlier activity…</span>
                </div>
              ) : null}
              {groups.map((group, index) => (
                <TimelineGroupView
                  key={timelineGroupKey(group)}
                  group={group}
                  renderMessageText={renderMessageText}
                  onOpenSession={onOpenSession}
                  onMemoryClick={onMemoryClick}
                  onReconnect={onReconnect}
                  resolveProviderLogo={resolveProviderLogo}
                  toolRegistry={toolRegistry}
                  foldLiveCluster={isAgentProgress(groups[index + 1])}
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
  onMemoryClick,
  onReconnect,
  resolveProviderLogo,
  toolRegistry,
  insideTurn = false,
  foldLiveCluster = false,
}: {
  group: TimelineGroup;
  renderMessageText?:
    | ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode)
    | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onMemoryClick?: ((memoryId: string) => void) | undefined;
  onReconnect?: ((item: AuthNeededItem) => void | Promise<void>) | undefined;
  resolveProviderLogo?: ((providerDomain: string) => string | null | undefined) | undefined;
  toolRegistry: ToolRegistry;
  /** A completed cluster of a still-RUNNING turn (not the live tail) folds
      behind a neutral chip — the one place activity without an outcome still
      folds, bounding the DOM of days-long autonomous turns. */
  foldLiveCluster?: boolean;
  /** Rendering inside an expanded turn group: the outer chip already owns the
      failure surface, so nested chips stay tinted but quiet (no repeated
      failure text, no auto-open) — one loud error, N calm sub-expands. */
  insideTurn?: boolean;
}) {
  switch (group.kind) {
    case "activity":
      return group.outcome || (foldLiveCluster && clusterIsSettled(group)) ? (
        <TurnSummary
          items={group.items}
          outcome={group.outcome}
          failureText={insideTurn ? undefined : group.failureText}
          defaultOpen={!insideTurn && group.outcome === "failed" ? true : undefined}
          bare={insideTurn}
        >
          <ActivityRail
            items={group.items}
            onOpenSession={onOpenSession}
            onMemoryClick={onMemoryClick}
            toolRegistry={toolRegistry}
            bare={insideTurn}
          />
        </TurnSummary>
      ) : (
        // A nested live cluster hangs on the turn's rail (bare); a top-level one
        // owns its own rail.
        <ActivityRail
          items={group.items}
          onOpenSession={onOpenSession}
          onMemoryClick={onMemoryClick}
          toolRegistry={toolRegistry}
          bare={insideTurn}
        />
      );
    case "turn": {
      const activityItems = flattenActivityItems(group.groups);
      const body = group.groups.map((child) => (
        <TimelineGroupView
          key={timelineGroupKey(child)}
          group={child}
          renderMessageText={renderMessageText}
          onOpenSession={onOpenSession}
          onMemoryClick={onMemoryClick}
          onReconnect={onReconnect}
          resolveProviderLogo={resolveProviderLogo}
          toolRegistry={toolRegistry}
          insideTurn
        />
      ));
      return (
        <TurnSummary
          items={activityItems}
          outcome={group.outcome}
          // One loud error at the top; nested sub-turn chips stay calm — the
          // parent already renders the failure reason, so clear it here exactly
          // as the nested activity-cluster case does.
          failureText={insideTurn ? undefined : group.failureText}
          durationMs={durationBetween(group.startedAt, group.endedAt)}
          defaultOpen={!insideTurn && group.outcome === "failed" ? true : undefined}
          bare={insideTurn}
        >
          {insideTurn ? (
            // A nested turn is already on an ancestor rail — its body just stacks
            // flush (the bare-node body already indents it), so no second rule.
            <div className="flex flex-col gap-4">{body}</div>
          ) : (
            // The top-level turn draws THE rail: one thin continuous rule that
            // every nested node and step hangs off of.
            <div className="flex flex-col gap-4 border-l-2 border-og-border pl-3 sm:pl-4">
              {body}
            </div>
          )}
        </TurnSummary>
      );
    }
    case "item":
      return (
        <TimelineRow
          item={group.item}
          renderMessageText={renderMessageText}
          onReconnect={onReconnect}
          resolveProviderLogo={resolveProviderLogo}
          onOpenSession={onOpenSession}
        />
      );
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

/** The agent has moved PAST a cluster only when what follows is more agent
    progress — new activity, a settled turn, or narration. A waiting notice
    (approval pause), a pending queued message, a goal pill, or nothing at all
    do NOT advance the story, and folding on them would hide exactly the work
    the reader needs in view. */
function isAgentProgress(next: TimelineGroup | undefined): boolean {
  if (!next) {
    return false;
  }
  return (
    next.kind === "activity" ||
    next.kind === "turn" ||
    (next.kind === "item" && next.item.kind === "agent-message")
  );
}

/** No item still running or streaming — the only state safe to fold live.
    Position alone is a broken proxy: a pending queued message (or any trailing
    item) can sit after the ACTIVE cluster, which must never fold mid-work. */
function clusterIsSettled(group: Extract<TimelineGroup, { kind: "activity" }>): boolean {
  return group.items.every((item) => {
    if (item.kind === "reasoning") {
      return !item.streaming;
    }
    // A memory write is a discrete, already-settled event — it has no running state.
    if (item.kind === "memory") {
      return true;
    }
    return item.status !== "running";
  });
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
  onReconnect,
  resolveProviderLogo,
  onOpenSession,
}: {
  item: TimelineItem;
  renderMessageText?:
    | ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode)
    | undefined;
  onReconnect?: ((item: AuthNeededItem) => void | Promise<void>) | undefined;
  resolveProviderLogo?: ((providerDomain: string) => string | null | undefined) | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  switch (item.kind) {
    case "user-message":
      return <UserMessageRow item={item} renderMessageText={renderMessageText} />;
    case "agent-message":
      return <AgentMessageRow item={item} renderMessageText={renderMessageText} />;
    case "worker-completion":
      return <WorkerCompletionRow item={item} onOpenSession={onOpenSession} />;
    case "session-status":
      return <SessionStatusRow item={item} />;
    case "goal":
      return <GoalRow item={item} />;
    case "notice":
      return <NoticeRow item={item} />;
    case "auth-needed":
      return (
        <AuthNeededRow
          item={item}
          onReconnect={onReconnect}
          resolveProviderLogo={resolveProviderLogo}
        />
      );
    default:
      return null;
  }
}

function UserMessageRow({
  item,
  renderMessageText,
}: {
  item: UserMessageItem;
  renderMessageText?:
    | ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode)
    | undefined;
}) {
  const enter = useEntranceAnimation();
  return (
    <div className={cn(enter && "animate-og-enter", "flex justify-end")}>
      <div className="flex max-w-[85%] min-w-0 flex-col items-end gap-1">
        <div className="w-fit max-w-full min-w-0 rounded-og-lg rounded-br-og-xs border border-og-border bg-og-surface-2 px-4 py-2.5 text-og-md leading-6 text-og-fg">
          {renderMessageText ? (
            renderMessageText(item.text, item)
          ) : (
            <Markdown>{item.text}</Markdown>
          )}
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
  renderMessageText?:
    | ((text: string, item: AgentMessageItem | UserMessageItem) => ReactNode)
    | undefined;
}) {
  const enter = useEntranceAnimation();
  const caret = item.streaming ? (
    <span
      className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-og-blink rounded-full bg-og-accent"
      aria-hidden
    />
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

/**
 * A worker session reporting back to its manager. The child's completion arrives
 * as a `user.message` carrying a `childCompletion` payload (the raw message text
 * used to render as an "ugly" user bubble); it projects to a `worker-completion`
 * item and draws here as a quietly-confident card — an inbound result, not
 * something the human said. One glyph + one line carry the outcome; the worker's
 * full report, evidence, and any paused reason live behind a collapsed
 * disclosure, and a "View session" affordance deep-links into the child.
 *
 * Color follows the timeline's restraint: green only for a completed goal, the
 * waiting hue only for a paused one, red only for a failed child — everything
 * else is a neutral inbound card.
 */
type WorkerCompletionMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  iconClass: string;
  /** The 2px left-accent hue — color spent only on the exceptional outcomes. */
  accentClass: string;
};

function workerCompletionMeta(item: WorkerCompletionItem): WorkerCompletionMeta {
  if (item.childStatus === "failed") {
    return {
      label: "Worker failed",
      icon: XCircleIcon,
      iconClass: "text-og-status-failed",
      accentClass: "border-og-status-failed/60",
    };
  }
  if (item.goalStatus === "paused") {
    return {
      label: "Worker paused",
      icon: PauseCircleIcon,
      iconClass: "text-og-status-waiting",
      accentClass: "border-og-status-waiting/50",
    };
  }
  if (item.goalStatus === "completed") {
    return {
      label: "Worker completed",
      icon: CheckCircle2Icon,
      iconClass: "text-og-status-idle",
      accentClass: "border-og-status-idle/45",
    };
  }
  return {
    label: "Worker reported back",
    icon: BotIcon,
    iconClass: "text-og-accent",
    accentClass: "border-og-border-strong",
  };
}

function WorkerCompletionRow({
  item,
  onOpenSession,
}: {
  item: WorkerCompletionItem;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const enter = useEntranceAnimation();
  const [open, setOpen] = useState(false);
  const meta = workerCompletionMeta(item);
  const Icon = meta.icon;
  // The worker's own report is the substance behind the fold; evidence and any
  // paused reason sit alongside it as quieter, labelled context.
  // "Paused because" only when the outcome actually IS a pause — completion
  // payloads can carry a leftover pausedReason/rationale from earlier in the
  // worker's life, and a "Worker completed" card must not show a pause section.
  const showPausedReason =
    item.childStatus !== "failed" &&
    item.goalStatus === "paused" &&
    Boolean(item.pausedReason?.trim());
  const details: { label: string; value: string; muted?: boolean }[] = [
    ...(item.text.trim() ? [{ label: "Report", value: item.text.trim() }] : []),
    ...(item.evidence?.trim()
      ? [{ label: "Evidence", value: item.evidence.trim(), muted: true }]
      : []),
    ...(showPausedReason
      ? [{ label: "Paused because", value: item.pausedReason!.trim(), muted: true }]
      : []),
  ];
  const hasDetails = details.length > 0;
  return (
    <div className={cn(enter && "animate-og-enter", "min-w-0")}>
      {/* An inbound result, not a bubble: a 2px left accent carries the outcome —
          no full frame, no surface fill. The report unfolds flush beneath. */}
      <div className={cn("flex flex-col gap-2 border-l-2 pl-3", meta.accentClass)}>
        <div className="flex items-start gap-2.5">
          <span className={cn("mt-0.5 shrink-0", meta.iconClass)}>
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-og-base leading-5 text-og-fg">
              <span className="font-medium">{meta.label}</span>
              {item.goalText ? (
                <span className="text-og-fg-muted"> · {truncate(item.goalText, 90)}</span>
              ) : null}
            </p>
          </div>
          {item.childSessionId && onOpenSession ? (
            <button
              type="button"
              onClick={() => onOpenSession(item.childSessionId)}
              className={cn(
                "-my-0.5 -mr-1 inline-flex shrink-0 items-center gap-1 rounded-og-sm px-2 py-1 text-og-sm font-medium text-og-fg-muted pointer-coarse:py-2",
                "outline-none transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg",
                "focus-visible:ring-2 focus-visible:ring-og-accent",
              )}
            >
              View session
              <ArrowRightIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        {hasDetails ? (
          <Collapsible.Root open={open} onOpenChange={setOpen}>
            <Collapsible.Trigger asChild>
              <button
                type="button"
                className={cn(
                  "group/wc -mx-1 inline-flex w-fit items-center gap-1 rounded-og-sm px-1 py-0.5 text-og-xs font-medium text-og-fg-subtle",
                  "outline-none transition-colors duration-150 hover:text-og-fg-muted focus-visible:ring-2 focus-visible:ring-og-accent",
                )}
              >
                <ChevronRightIcon className="size-3 transition-transform duration-150 ease-og-in-out group-data-[state=open]/wc:rotate-90" />
                {open ? "Hide details" : "Show details"}
              </button>
            </Collapsible.Trigger>
            <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-og-collapse data-[state=open]:animate-og-expand">
              <div className="ml-1 mt-1.5 flex flex-col gap-2.5">
                {details.map((detail) => (
                  <div key={detail.label} className="min-w-0">
                    <p className="mb-1 text-og-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle">
                      {detail.label}
                    </p>
                    <p
                      className={cn(
                        "whitespace-pre-wrap break-words text-og-sm leading-6",
                        detail.muted ? "text-og-fg-subtle" : "text-og-fg-muted",
                      )}
                    >
                      {detail.value}
                    </p>
                  </div>
                ))}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        ) : null}
      </div>
    </div>
  );
}

function SessionStatusRow({ item }: { item: { status: SessionStatus; occurredAt: string } }) {
  const enter = useEntranceAnimation();
  const meta = SESSION_STATUS_META[item.status];
  return (
    <div
      className={cn(
        enter && "animate-og-enter",
        "flex items-center gap-3 text-og-xs text-og-fg-subtle",
      )}
      role="status"
    >
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
  set: {
    label: "Goal set",
    pill: "border-og-accent/30 bg-og-accent/10 text-og-accent",
    icon: TargetIcon,
  },
  updated: { label: "Goal updated", pill: NEUTRAL_PILL, icon: PencilLineIcon },
  completed: {
    label: "Goal completed",
    pill: "border-og-status-idle/30 bg-og-status-idle/10 text-og-status-idle",
    icon: CheckIcon,
  },
  paused: {
    label: "Goal paused",
    pill: "border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting",
    icon: PauseIcon,
  },
  resumed: { label: "Goal resumed", pill: NEUTRAL_PILL, icon: PlayIcon },
  cleared: { label: "Goal cleared", pill: NEUTRAL_PILL, icon: Trash2Icon },
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
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-og-sm",
          pill,
        )}
      >
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
    <div
      className={cn(
        enter && "animate-og-enter",
        "flex items-start gap-2.5 rounded-og-md border px-3.5 py-2.5 text-sm",
        tone,
      )}
      role="status"
    >
      <TriangleAlertIcon
        className={cn("mt-0.5 size-4 shrink-0", item.tone === "cancelled" && "opacity-60")}
      />
      <div className="min-w-0 flex-1">
        <span className="whitespace-pre-wrap break-words">{item.text}</span>
        {item.details ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-medium">{item.details.label}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-og-sm bg-black/5 p-2 font-mono dark:bg-white/5">
              {JSON.stringify(item.details.value, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
      {item.action ? (
        <a
          className="shrink-0 rounded-og-sm border border-current/25 px-2 py-1 text-xs font-medium hover:bg-current/10"
          href={item.action.url}
          rel="noreferrer"
          target="_blank"
        >
          {item.action.label}
        </a>
      ) : null}
    </div>
  );
}

/**
 * The inline reconnect card: a lapsed connection surfaces as a calm, tappable
 * affordance — provider logo, one human line, one primary Reconnect button —
 * instead of a raw "linear.app needs to be reconnected." string. The `reason`
 * only shapes the helper copy; no domain or enum code is shown as a label.
 * `onReconnect` (from the app, which owns the SDK client) runs the flow; without
 * it, a pre-minted authorization link is offered, or the card stays informative.
 */
function AuthNeededRow({
  item,
  onReconnect,
  resolveProviderLogo,
}: {
  item: AuthNeededItem;
  onReconnect?: ((item: AuthNeededItem) => void | Promise<void>) | undefined;
  resolveProviderLogo?: ((providerDomain: string) => string | null | undefined) | undefined;
}) {
  const enter = useEntranceAnimation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const provider = providerLabel(item.providerDomain);

  const start = async () => {
    if (!onReconnect || busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      // On success the app redirects to consent (or routes to credential entry),
      // so this row unmounts; a resolve without navigation just relaxes the button.
      await onReconnect(item);
      setBusy(false);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className={cn(enter && "animate-og-enter", "flex flex-col gap-2")} role="status">
      <div className="flex flex-col gap-3 rounded-og-lg border border-og-border bg-og-surface-1 px-3.5 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AuthProviderLogo
            src={resolveProviderLogo?.(item.providerDomain) ?? null}
            label={provider}
          />
          <div className="min-w-0">
            <p className="truncate text-og-md font-medium text-og-fg">Reconnect {provider}</p>
            <p className="truncate text-og-sm text-og-fg-subtle">{authReasonLine(item.reason)}</p>
          </div>
        </div>
        {onReconnect ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className={cn(
              "inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-og-md bg-og-accent px-3 py-1.5 text-sm font-medium text-og-accent-fg sm:w-auto",
              "transition-colors hover:bg-og-accent-strong disabled:opacity-70 pointer-coarse:min-h-9",
            )}
          >
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-og-spin")} aria-hidden />
            {busy ? "Reconnecting…" : "Reconnect"}
          </button>
        ) : item.authorizationUrl ? (
          <a
            href={item.authorizationUrl}
            rel="noreferrer"
            target="_blank"
            className={cn(
              "inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-og-md bg-og-accent px-3 py-1.5 text-sm font-medium text-og-accent-fg sm:w-auto",
              "transition-colors hover:bg-og-accent-strong pointer-coarse:min-h-9",
            )}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            Reconnect
          </a>
        ) : null}
      </div>
      {failed ? (
        <p className="px-1 text-og-xs text-og-status-failed">
          Couldn't start reconnecting {provider}. Try again.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The provider's logo in a rounded tile, from a URL the HOST serves itself
 * (resolved via `resolveProviderLogo` → the app's catalog assets). A missing or
 * failed image falls back to a calm letter monogram — same as the rest of the
 * app — so the card never shows a broken-image glyph and never reaches off-origin
 * for a favicon (CSP + privacy).
 */
function AuthProviderLogo({ src, label }: { src: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  // A resolver that only returns the URL after a lazy catalog fetch means `src`
  // can arrive on a later render; reset the error latch so it gets its attempt.
  useEffect(() => setFailed(false), [src]);
  const showImage = src && !failed;
  return (
    <span
      className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-og-md border border-og-border bg-og-surface-2 text-sm font-semibold text-og-fg-muted"
      aria-hidden
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{monogram(label)}</span>
      )}
    </span>
  );
}

/** First one or two initials for the monogram fallback — mirrors the app's
    `capabilityMonogram` so the reconnect tile reads like every other logo tile. */
function monogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** "linear.app" -> "Linear": the first domain label, capitalized. A calm human
    name for the provider — never the raw domain shown as a label. */
function providerLabel(domain: string): string {
  const host =
    domain
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] ?? "";
  const first = host.split(".")[0] ?? host;
  if (!first) {
    return "this service";
  }
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** A calm, human helper line per reauth reason — the `reason` informs the copy
    but is never rendered as a raw enum/code. */
function authReasonLine(reason: AuthNeededItem["reason"]): string {
  switch (reason) {
    case "insufficient_scope":
      return "It needs additional access to continue.";
    case "missing_connection":
      return "It isn't connected yet.";
    case "expired":
    case "refresh_failed":
      return "Its access expired.";
    default:
      return "Its connection needs attention.";
  }
}
