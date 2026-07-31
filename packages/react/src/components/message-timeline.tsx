import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpToLineIcon,
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
  memo,
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
import { prefersReducedMotion } from "../lib/motion";
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
  type MachineInputBatchItem,
  type NoticeItem,
  type TimelineGroup,
  type TimelineItem,
  type ToolRegistry,
  type TurnSummaryOptions,
  type UserMessageItem,
  type WorkerCompletionItem,
  TurnSummary,
  useTurnSettleOpen,
} from "../timeline";
import { CopyHoverFrame } from "./copy-button";
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
  /** Customize collapsed turn facets for this timeline instance. */
  turnSummary?: TurnSummaryOptions | undefined;
  /** Follow new events when pinned to the bottom. Defaults to true. */
  autoFollow?: boolean | undefined;
  /** Older durable history exists above the current window (see useSessionEvents). */
  hasOlder?: boolean | undefined;
  /** An older window is being fetched; shows the quiet top shimmer. */
  loadingOlder?: boolean | undefined;
  /** Called when the reader nears the top and older history should backfill. */
  onLoadOlder?: (() => void) | undefined;
  /** Jump to the durable session start (bounded oldest window, no middle). */
  onJumpToStart?: (() => void | Promise<void>) | undefined;
  /** True while the oldest window is loading. */
  loadingOldest?: boolean | undefined;
  /** Newer durable history exists below the current (history) window. */
  hasNewer?: boolean | undefined;
  /** A newer history page is being fetched. */
  loadingNewer?: boolean | undefined;
  /** Page forward through history without loading the whole gap to the tip. */
  onLoadNewer?: (() => void) | undefined;
  /**
   * Reload the live tip window. When omitted, Jump to latest only re-pins and
   * scrolls the in-memory window.
   */
  onJumpToLatest?: (() => void | Promise<void>) | undefined;
  emptyState?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * Scroll ownership, from first principles. Everything the events hook has
 * loaded is mounted — no tip-lock window, no per-frame progressive reveal.
 * (The in-memory window is already byte/count-bounded by useSessionEvents, and
 * rows are memoized, so a full mount is cheap; the drip-feed machinery this
 * replaces was the "content is hidden, then pops in in batches" wobble.)
 *
 * Exactly one authority writes scrollTop, depending on mode:
 * - Pinned at the tip → we own it: ease toward the bottom after every commit
 *   (and on ResizeObserver ticks for late layout like images). Native scroll
 *   anchoring is disabled in this mode so it cannot fight the glide.
 * - Scrolled up reading → the BROWSER owns it: native scroll anchoring
 *   (`overflow-anchor: auto`) holds the reader's viewport through history
 *   prepends, image/font late layout, and fold reflows at the compositor
 *   level — no script, nothing to wobble. Where the engine lacks scroll
 *   anchoring, the one scripted exception is a history prepend, corrected
 *   once per commit by the exact scrollHeight delta.
 */
const PIN_THRESHOLD_PX = 48;

/**
 * Adaptive tip-follow glide. Remaining distance shrinks by ~63% every tau ms.
 * Tau is dynamic:
 * - Slow / sparse growth → longer tau (calm float; no strange laggy chase
 *   after a single line).
 * - Fast bursts or stacked debt → shorter tau (catch up without rattling).
 * Velocity is an EMA of scrollHeight growth; debt is distance-to-bottom.
 */
const GLIDE_TAU_MIN_MS = 100;
const GLIDE_TAU_MAX_MS = 420;
/** At this tip-debt, urgency saturates toward the fast tau. */
const GLIDE_CATCHUP_DEBT_PX = 140;
/** Growth speed (px/s) that saturates urgency toward the fast tau. */
const GLIDE_VELOCITY_REF_PX_S = 380;
/** Idle this long without growth → velocity decays (slow stream calms). */
const GLIDE_VELOCITY_IDLE_MS = 180;
/** Growth beyond this snaps instead of gliding (session switches, huge folds). */
const GLIDE_MAX_DISTANCE_PX = 600;

function glideTauMs(debtPx: number, velocityPxPerSec: number): number {
  const debtT = Math.min(1, Math.abs(debtPx) / GLIDE_CATCHUP_DEBT_PX);
  const velT = Math.min(1, Math.max(0, velocityPxPerSec) / GLIDE_VELOCITY_REF_PX_S);
  const urgency = Math.max(debtT, velT);
  return GLIDE_TAU_MAX_MS + (GLIDE_TAU_MIN_MS - GLIDE_TAU_MAX_MS) * urgency;
}

/** Detects native scroll anchoring; a hook so tests can exercise the fallback. */
function useNativeScrollAnchoring(): boolean {
  return useMemo(
    () =>
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("overflow-anchor: auto"),
    [],
  );
}

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
  turnSummary,
  autoFollow = true,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onJumpToStart,
  loadingOldest = false,
  hasNewer = false,
  loadingNewer = false,
  onLoadNewer,
  onJumpToLatest,
  emptyState,
  className,
}: MessageTimelineProps) {
  const resolvedItems = useMemo(() => items ?? buildTimeline(events ?? []), [items, events]);
  const allGroups = useMemo(() => groupTimeline(resolvedItems), [resolvedItems]);
  const groups = useStableTimelineGroupKeys(allGroups);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const previousBulkFirstKeyRef = useRef<string | null | undefined>(undefined);
  const [pinned, setPinned] = useState(true);
  const [bulkActive, setBulkActive] = useState(true);
  // Older history prefetch is user-driven: a window shorter than the viewport
  // + rootMargin would otherwise keep the top sentinel intersecting and fetch
  // history forever while the reader sits at the tip. Arm on first scroll-up.
  const olderPrefetchArmedRef = useRef(false);
  const [olderPrefetchArmed, setOlderPrefetchArmed] = useState(false);
  const firstGroupKey = allGroups[0] ? timelineGroupKey(allGroups[0]) : null;
  // Content stays invisible until its first bottom-anchored frame, so a flash
  // of the window's TOP while a large timeline lays out is structurally
  // impossible — the reader only ever sees it already at the bottom.
  const [revealed, setRevealed] = useState(false);
  // Mirror `pinned` into a ref so ResizeObserver/layout callbacks (stable
  // closures) always read the live value without re-subscribing.
  const pinnedRef = useRef(true);
  // History windows (`hasNewer`) have a bottom that is not the live tip.
  // Pin/follow must ignore that floor — otherwise loadNewer appends yank the
  // reader to the new page bottom. LoadOlder prepends already stay put because
  // the reader is unpinned and scroll anchoring / delta correction owns place.
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;
  // Our own scrollTop writes echo back as delayed scroll events. We only ever
  // write "to the bottom" while pinned (echo reads as pinned — harmless) or a
  // prepend delta while unpinned (echo reads as unpinned — harmless), so no
  // target bookkeeping is needed; a small counter just stops a late echo of a
  // bottom-follow from unpinning a reader who has not touched the wheel.
  const pendingEchoesRef = useRef(0);
  // Prepend detection: the oldest loaded item's id changes exactly when older
  // history lands (including the merge-into-first-group case where the first
  // GROUP key is retained). Item ids, not group keys, are the durable signal.
  // Only consulted where the engine lacks native scroll anchoring.
  const nativeScrollAnchoring = useNativeScrollAnchoring();
  const previousFirstItemIdRef = useRef<string | null>(null);
  const previousScrollHeightRef = useRef(0);
  const firstItemId = resolvedItems[0]?.id ?? null;
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
  const bulkRender = allGroups.length > 0 && (bulkActive || firstKeyChangedForBulk);

  // Mirrors `revealed` for the stable follow callbacks: the very first
  // bottom-anchored frame must SNAP (the reader hasn't seen anything yet);
  // everything after it may glide.
  const revealedRef = useRef(false);

  const writeScrollTop = useCallback((node: HTMLElement, value: number) => {
    const previous = node.scrollTop;
    node.scrollTop = value;
    if (node.scrollTop !== previous) {
      pendingEchoesRef.current = Math.min(pendingEchoesRef.current + 1, 32);
    }
  }, []);

  // Soft follow glide: while pinned, the tip eases toward the bottom with an
  // exponential approach (frame-rate independent) instead of teleporting per
  // commit. Tau adapts to recent growth velocity + tip debt — slow streams
  // stay calm, fast bursts catch up. Target re-read every frame so mid-glide
  // growth extends the same motion. Self-terminates when the pin releases.
  const glideFrameRef = useRef<number | null>(null);
  const glideLastTsRef = useRef(0);
  const growthTrackerRef = useRef({ height: 0, at: 0, velocity: 0 });

  const noteContentGrowth = useCallback((height: number) => {
    const tracker = growthTrackerRef.current;
    const nowTs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (tracker.height > 0 && nowTs > tracker.at) {
      const dh = height - tracker.height;
      const dt = nowTs - tracker.at;
      if (dh > 0 && dt > 0) {
        const instant = (dh / dt) * 1000;
        tracker.velocity = tracker.velocity * 0.65 + instant * 0.35;
      } else if (dt > GLIDE_VELOCITY_IDLE_MS) {
        // Sparse stream: forget burst urgency so the next line floats calmly.
        tracker.velocity *= 0.45;
      }
    }
    tracker.height = height;
    tracker.at = nowTs;
  }, []);

  const stopGlide = useCallback(() => {
    if (glideFrameRef.current !== null) {
      cancelFrame(glideFrameRef.current);
      glideFrameRef.current = null;
    }
  }, []);

  const glideStep = useCallback(() => {
    glideFrameRef.current = null;
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) {
      return;
    }
    noteContentGrowth(node.scrollHeight);
    const target = node.scrollHeight - node.clientHeight;
    const delta = target - node.scrollTop;
    if (Math.abs(delta) <= 1) {
      if (delta !== 0) {
        writeScrollTop(node, target);
      }
      return;
    }
    const nowTs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt =
      glideLastTsRef.current === 0
        ? 16
        : Math.min(64, Math.max(8, nowTs - glideLastTsRef.current));
    glideLastTsRef.current = nowTs;
    // Decay velocity while gliding without new growth so catch-up eases out.
    const tracker = growthTrackerRef.current;
    if (nowTs - tracker.at > GLIDE_VELOCITY_IDLE_MS) {
      tracker.velocity *= 0.85;
      tracker.at = nowTs;
    }
    const tau = glideTauMs(delta, tracker.velocity);
    const alpha = 1 - Math.exp(-dt / tau);
    const step = delta * alpha;
    writeScrollTop(node, node.scrollTop + (Math.abs(step) < 1 ? Math.sign(delta) : step));
    glideFrameRef.current = requestFrame(glideStep);
  }, [noteContentGrowth, writeScrollTop]);

  const startGlide = useCallback(() => {
    if (glideFrameRef.current === null) {
      glideLastTsRef.current = 0;
      glideFrameRef.current = requestFrame(glideStep);
    }
  }, [glideStep]);

  useEffect(() => stopGlide, [stopGlide]);

  const followTip = useCallback(
    (node: HTMLElement) => {
      noteContentGrowth(node.scrollHeight);
      const target = node.scrollHeight - node.clientHeight;
      const delta = target - node.scrollTop;
      if (Math.abs(delta) <= 1) {
        return;
      }
      // Glide only for ordinary streaming-scale growth after the first paint.
      // The initial reveal, session switches, and layout jumps larger than a
      // viewport-ish distance snap — animating those would feel like lag.
      if (revealedRef.current && Math.abs(delta) <= GLIDE_MAX_DISTANCE_PX && !prefersReducedMotion()) {
        startGlide();
      } else {
        stopGlide();
        writeScrollTop(node, target);
      }
    },
    [noteContentGrowth, startGlide, stopGlide, writeScrollTop],
  );

  // The single post-commit scroll authority. Runs after EVERY commit (no dep
  // list): any commit may change content height, and the decision is cheap.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const previousFirstItemId = previousFirstItemIdRef.current;
    const prepended =
      previousFirstItemId !== null &&
      firstItemId !== previousFirstItemId &&
      resolvedItems.some((item) => item.id === previousFirstItemId);
    // Live tip only. A history-page bottom (`hasNewer`) must not follow appends
    // from loadNewer — that path should leave scrollTop alone, like an unpinned
    // reader watching growth below the viewport.
    if (autoFollow && pinnedRef.current && !hasNewerRef.current) {
      followTip(node);
    } else if (prepended && !nativeScrollAnchoring) {
      // Fallback engines only: one exact correction per prepend commit, whole
      // pixels. Anchoring engines already adjusted during layout — correcting
      // again here would double-shift. Growth below the viewport (a live tip
      // streaming while the reader is up in history) never lands here.
      const delta = Math.round(node.scrollHeight - previousScrollHeightRef.current);
      if (delta > 0) {
        writeScrollTop(node, node.scrollTop + delta);
      }
    }
    previousFirstItemIdRef.current = firstItemId;
    previousScrollHeightRef.current = node.scrollHeight;
    if (!revealed && groups.length > 0) {
      revealedRef.current = true;
      setRevealed(true);
    }
  });

  // A cleared timeline (stream identity change) re-arms the reveal + prefetch
  // gate and returns to bottom-follow for the next session's first paint.
  useLayoutEffect(() => {
    if (allGroups.length > 0) {
      return;
    }
    stopGlide();
    revealedRef.current = false;
    if (revealed) {
      setRevealed(false);
    }
    if (olderPrefetchArmedRef.current) {
      olderPrefetchArmedRef.current = false;
      setOlderPrefetchArmed(false);
    }
    if (!pinnedRef.current) {
      pinnedRef.current = true;
      setPinned(true);
    }
  }, [allGroups.length, revealed, stopGlide]);

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

  // Prefetch older history only after the reader scrolls up from the tip.
  // Once armed, the sentinel trips 1600px early so backfill is usually
  // rendered (and its scroll delta corrected) before the reader reaches it.
  useEffect(() => {
    const root = scrollRef.current;
    const target = topSentinelRef.current;
    if (
      !root ||
      !target ||
      !olderPrefetchArmed ||
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
  }, [olderPrefetchArmed, hasOlder, loadingOlder, onLoadOlder, firstGroupKey]);

  // History view: page forward when the reader nears the bottom of the current
  // non-tip window. Does not pull the whole gap — one density-bounded page.
  useEffect(() => {
    const root = scrollRef.current;
    const target = bottomSentinelRef.current;
    if (
      !root ||
      !target ||
      !hasNewer ||
      loadingNewer ||
      !onLoadNewer ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadNewer();
        }
      },
      { root, rootMargin: "0px 0px 1200px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNewer, loadingNewer, onLoadNewer, firstGroupKey]);

  // Late layout that React commits cannot see (images decoding, fonts, code
  // blocks) grows content without a commit. While pinned we keep following the
  // bottom; while unpinned we deliberately do NOTHING — chasing those shifts
  // with scroll corrections was the wobble. We only refresh the height
  // baseline so the next prepend delta stays exact.
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
      if (autoFollow && pinnedRef.current && !hasNewerRef.current) {
        followTip(current);
      }
      previousScrollHeightRef.current = current.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [autoFollow, followTip]);

  // Entering a non-tip history window: drop any live pin so the page bottom
  // cannot re-stick follow across loadNewer.
  useEffect(() => {
    if (!hasNewer) {
      return;
    }
    stopGlide();
    if (pinnedRef.current) {
      pinnedRef.current = false;
      setPinned(false);
    }
  }, [hasNewer, stopGlide]);

  // While the glide is writing scrollTop every frame, its echoes could mask
  // the reader's own upward scroll events — so upward INTENT (wheel up, finger
  // drag down, scrollbar gutter, keys) releases the pin directly. Layout
  // scrolls during settle-fold / scenario spawns must NEVER unpin from
  // onScroll alone — that was the recurring "Jump to latest" trap.
  const releasePin = useCallback(() => {
    const node = scrollRef.current;
    if (!node || node.scrollHeight - node.clientHeight <= 1) {
      return; // nothing to scroll — no pin to release
    }
    stopGlide();
    if (pinnedRef.current) {
      pinnedRef.current = false;
      setPinned(false);
    }
    if (!olderPrefetchArmedRef.current) {
      olderPrefetchArmedRef.current = true;
      setOlderPrefetchArmed(true);
    }
  }, [stopGlide]);

  const scrollbarDragRef = useRef(false);
  const touchYRef = useRef<number | null>(null);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const echo = pendingEchoesRef.current > 0;
    if (echo) {
      pendingEchoesRef.current -= 1;
    }
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
    // Near-bottom (re)pins only for the live tip. History-window bottoms are
    // loadNewer triggers, not follow targets.
    const nextPinned = !hasNewerRef.current && gap < PIN_THRESHOLD_PX;
    previousScrollHeightRef.current = node.scrollHeight;
    // Near-bottom always (re)pins — including echoes of our own writes.
    if (nextPinned) {
      if (!pinnedRef.current) {
        pinnedRef.current = true;
        setPinned(true);
      }
      return;
    }
    if (echo) {
      return;
    }
    // Still pinned but far from the tip. Either layout moved the floor
    // (collapse / append / images) or the reader is dragging the scrollbar.
    // Wheel/touch/keys already called releasePin. Scrollbar sets the drag
    // flag below. Everything else is layout — re-stick, never drop the pin.
    // History mode never re-sticks: drop the pin instead.
    if (pinnedRef.current) {
      if (hasNewerRef.current || scrollbarDragRef.current) {
        releasePin();
        return;
      }
      followTip(node);
      return;
    }
    if (!olderPrefetchArmedRef.current) {
      olderPrefetchArmedRef.current = true;
      setOlderPrefetchArmed(true);
    }
  };

  // Native wheel listener: React's onWheel is unreliable under some test
  // doms, and we want the same intent path in production.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const onWheelNative = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        releasePin();
      }
    };
    const onKeyDownNative = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
        releasePin();
      }
    };
    node.addEventListener("wheel", onWheelNative, { passive: true });
    node.addEventListener("keydown", onKeyDownNative);
    return () => {
      node.removeEventListener("wheel", onWheelNative);
      node.removeEventListener("keydown", onKeyDownNative);
    };
  }, [releasePin]);

  const onWheel = (event: React.WheelEvent) => {
    if (event.deltaY < 0) {
      releasePin();
    }
  };
  const onPointerDown = (event: React.PointerEvent) => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    // Only the classic overlay scrollbar gutter counts as reader intent —
    // clicks on fold chevrons / messages must not arm unpin.
    const gutter = node.offsetWidth - node.clientWidth;
    if (gutter <= 0) {
      return;
    }
    const rect = node.getBoundingClientRect();
    if (event.clientX >= rect.right - gutter - 2) {
      scrollbarDragRef.current = true;
    }
  };
  const onPointerUp = () => {
    scrollbarDragRef.current = false;
  };
  const onTouchStart = (event: React.TouchEvent) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: React.TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined) {
      return;
    }
    const previous = touchYRef.current;
    if (previous !== null && y - previous > 6) {
      releasePin();
    }
    touchYRef.current = y;
  };

  return (
    <LightboxProvider>
      <EntranceAnimationProvider value={!bulkRender}>
        <div className={cn("og-root relative flex min-h-0 flex-col", className)}>
          {/* Pinned: anchoring off so the soft tip-follow glide is the only
          authority. Unpinned: native scroll anchoring holds the reader's
          place through prepends and late layout — the wobble-free path. */}
          <div
            ref={scrollRef}
            tabIndex={-1}
            onScroll={onScroll}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            style={groups.length > 0 && !revealed ? { visibility: "hidden" } : undefined}
            className={cn(
              // tabIndex=-1 is programmatic only — never paint a focus ring on
              // the whole scroller (click + Shift used to flash a blue outline).
              "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 outline-none",
              autoFollow && pinned && !hasNewer
                ? "[overflow-anchor:none]"
                : "[overflow-anchor:auto]",
            )}
          >
            <div className="relative mx-auto flex w-full max-w-3xl flex-col gap-5">
              {groups.length === 0 && !working
                ? (emptyState ?? (
                    <p className="py-10 text-center text-sm text-og-fg-subtle">No activity yet.</p>
                  ))
                : null}
              {hasOlder && olderPrefetchArmed ? (
                // Overlaid, not a layout row: mounting/unmounting the sentinel
                // must never shift content (that shift was itself a wobble).
                <div
                  ref={topSentinelRef}
                  data-og-top-sentinel=""
                  data-og-timeline-chrome=""
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-px"
                />
              ) : null}
              {groups.map(({ group, key }, index) => (
                <div key={key} data-og-timeline-group-anchor="">
                  <TimelineGroupView
                    group={group}
                    renderMessageText={renderMessageText}
                    onOpenSession={onOpenSession}
                    onMemoryClick={onMemoryClick}
                    onReconnect={onReconnect}
                    resolveProviderLogo={resolveProviderLogo}
                    toolRegistry={toolRegistry}
                    turnSummary={turnSummary}
                    foldLiveCluster={isAgentProgress(groups[index + 1]?.group)}
                    trailingAgentText={trailingAgentTextAfterTurn(group, groups[index + 1]?.group)}
                  />
                </div>
              ))}
              {hasNewer ? (
                <div
                  ref={bottomSentinelRef}
                  data-og-bottom-sentinel=""
                  data-og-timeline-chrome=""
                  aria-hidden="true"
                  className="h-px w-full"
                />
              ) : null}
              {working ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="og-shimmer-text font-medium">Working…</span>
                </div>
              ) : null}
            </div>
          </div>
          <AnimatePresence>
            {loadingOlder ||
            loadingOldest ||
            (hasOlder && onJumpToStart && olderPrefetchArmed) ? (
              // Floating over the scroller (not a timeline row) so showing and
              // hiding it never reflows history under the reader.
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                data-og-loading-older=""
                aria-live="polite"
                className="absolute inset-x-0 top-3 z-10 flex justify-center gap-2"
              >
                {loadingOlder || loadingOldest ? (
                  <span className="pointer-events-none inline-flex items-center rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1 text-xs font-medium shadow-og-md backdrop-blur">
                    <span className="og-shimmer-text">
                      {loadingOldest ? "Jumping to start…" : "Loading earlier activity…"}
                    </span>
                  </span>
                ) : null}
                {hasOlder && onJumpToStart && !loadingOldest ? (
                  <button
                    type="button"
                    data-og-jump-to-start=""
                    disabled={loadingOlder}
                    onClick={() => {
                      stopGlide();
                      pinnedRef.current = false;
                      setPinned(false);
                      const node = scrollRef.current;
                      void Promise.resolve(onJumpToStart()).then(() => {
                        const scroller = scrollRef.current ?? node;
                        if (scroller) {
                          writeScrollTop(scroller, 0);
                        }
                      });
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1.5",
                      "text-xs font-medium text-og-fg shadow-og-md backdrop-blur",
                      "hover:border-og-border-strong disabled:opacity-60",
                    )}
                  >
                    <ArrowUpToLineIcon className="size-3.5" />
                    Jump to start
                  </button>
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence>
            {loadingNewer ? (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                data-og-loading-newer=""
                aria-live="polite"
                className="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center"
              >
                <span className="inline-flex items-center rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1 text-xs font-medium shadow-og-md backdrop-blur">
                  <span className="og-shimmer-text">Loading later activity…</span>
                </span>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence>
            {((!pinned && autoFollow) || hasNewer) && autoFollow ? (
              <motion.button
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                onClick={() => {
                  const finish = () => {
                    // Re-pin, then let the glide carry the trip: its writes are
                    // echo-counted (a native smooth scrollTo's are not, and its
                    // mid-flight events would read as the reader unpinning).
                    pinnedRef.current = true;
                    setPinned(true);
                    const node = scrollRef.current;
                    if (!node) {
                      return;
                    }
                    if (prefersReducedMotion()) {
                      writeScrollTop(node, node.scrollHeight - node.clientHeight);
                    } else {
                      startGlide();
                    }
                  };
                  if (onJumpToLatest && hasNewer) {
                    void Promise.resolve(onJumpToLatest()).then(finish);
                    return;
                  }
                  finish();
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

type KeyedTimelineGroup = {
  group: TimelineGroup;
  key: string;
};

/**
 * Projection can legitimately change a group's content-derived key while
 * retaining its existing rows. The common pagination case is an older activity
 * item merging into the first activity group; live appends grow the same group
 * from the other side. Match the new authoritative groups to the previous
 * committed groups by their durable item IDs so both the React key and the
 * progressive-window anchor survive either change.
 */
function useStableTimelineGroupKeys(allGroups: TimelineGroup[]): KeyedTimelineGroup[] {
  const previousRef = useRef<KeyedTimelineGroup[]>([]);
  const keyedGroups = useMemo(() => {
    const previousByItemId = new Map<string, KeyedTimelineGroup>();
    for (const previous of previousRef.current) {
      for (const itemId of timelineGroupItemIds(previous.group)) {
        previousByItemId.set(itemId, previous);
      }
    }

    const usedKeys = new Set<string>();
    return allGroups.map((group, index) => {
      const itemIds = timelineGroupItemIds(group);
      let retainedKey: string | undefined;
      for (const itemId of itemIds) {
        const previous = previousByItemId.get(itemId);
        // Retain only same-kind matches. Activity → turn wrap must NOT keep the
        // activity chip's React key: that reused a collapsed TurnSummary and
        // skipped the settle beat (insta-collapse / content flash).
        if (
          previous &&
          previous.group.kind === group.kind &&
          !usedKeys.has(previous.key)
        ) {
          retainedKey = previous.key;
          break;
        }
      }

      const canonicalKey = timelineGroupKey(group);
      let key = retainedKey ?? canonicalKey;
      let collision = 0;
      while (usedKeys.has(key)) {
        key = `${canonicalKey}:${index}:${collision}`;
        collision += 1;
      }
      usedKeys.add(key);
      return { group, key };
    });
  }, [allGroups]);

  useLayoutEffect(() => {
    previousRef.current = keyedGroups;
  }, [keyedGroups]);

  return keyedGroups;
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

// The full loaded window stays mounted, so settled history rows must be cheap
// on every commit: projection reuses group objects for unchanged groups, so
// memo skips them. Live projection creates a new group object, and
// behavior/callback changes are separate props, so ordinary streaming and host
// updates still invalidate immediately.
const TimelineGroupView = memo(function TimelineGroupView({
  group,
  renderMessageText,
  onOpenSession,
  onMemoryClick,
  onReconnect,
  resolveProviderLogo,
  toolRegistry,
  turnSummary,
  insideTurn = false,
  nestClusterChips = false,
  foldLiveCluster = false,
  trailingAgentText,
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
  turnSummary?: TurnSummaryOptions | undefined;
  /** A completed cluster of a still-RUNNING turn (not the live tail) folds
      behind a neutral chip — the one place activity without an outcome still
      folds, bounding the DOM of days-long autonomous turns. */
  foldLiveCluster?: boolean;
  /** Rendering inside an expanded turn group: the outer chip already owns the
      failure surface, so nested chips stay tinted but quiet (no repeated
      failure text, no auto-open) — one loud error, N calm sub-expands. */
  insideTurn?: boolean;
  /**
   * Parent turn has ≥2 foldable activity clusters. Only then do we wrap settled
   * clusters in nested chips — a single cluster under "N steps" is redundant.
   * Suppressed while the outer settle beat is open so collapse is one layer.
   */
  nestClusterChips?: boolean;
  /**
   * Final agent answer extracted as a sibling after a settled turn — folded
   * into "Copy turn" so the chip copies the whole assistant reply, not only
   * mid-turn narration still inside the fold.
   */
  trailingAgentText?: string | undefined;
}) {
  const enter = useEntranceAnimation();
  const settleOpen = useTurnSettleOpen();
  // Settled (or live-fold) activity clusters get a chip. Inside an expanded
  // turn that is the second layer — quiet nested chips under the outer turn
  // summary when contiguous activity naturally clusters (≥2 only).
  const activityShouldFold =
    group.kind === "activity" &&
    Boolean(group.outcome || (foldLiveCluster && clusterIsSettled(group)));
  // Latch live→folded so a top-level shell that was already mounted open can
  // start the settle beat without remounting bare rail → wrapper.
  const liveActivitySettle = useLiveSettleFold(activityShouldFold && !insideTurn);
  const turnDefaultOpen = !insideTurn && group.kind === "turn" && group.outcome === "failed";
  const settleFold =
    group.kind === "turn"
      ? Boolean(enter && !insideTurn && !turnDefaultOpen)
      : liveActivitySettle;
  switch (group.kind) {
    case "activity":
      if (insideTurn) {
        // Nested chips only when the parent has ≥2 clusters AND the outer
        // settle choreography is done. While settling (beat + collapse) the
        // body stays a flat rail — one height to animate. Remounting closed
        // nested chips when `open` flips false was the mid-collapse snap.
        const useNestedChip = nestClusterChips && activityShouldFold && !settleOpen;
        if (!useNestedChip) {
          return (
            <ActivityRail
              items={group.items}
              onOpenSession={onOpenSession}
              onMemoryClick={onMemoryClick}
              toolRegistry={toolRegistry}
              bare
            />
          );
        }
        return (
          <TurnSummary
            items={group.items}
            outcome={group.outcome}
            failureText={undefined}
            bare
            facets={turnSummary?.facets}
          >
            <ActivityRail
              items={group.items}
              onOpenSession={onOpenSession}
              onMemoryClick={onMemoryClick}
              toolRegistry={toolRegistry}
              bare
            />
          </TurnSummary>
        );
      }
      // Always the same TurnSummary shell while live so mid-turn fold only
      // flips settleFold (collapse) instead of remounting bare rail → wrapper.
      return (
        <TurnSummary
          items={group.items}
          outcome={group.outcome}
          failureText={group.failureText}
          defaultOpen={
            !activityShouldFold || group.outcome === "failed" ? true : undefined
          }
          facets={turnSummary?.facets}
          settleFold={settleFold}
        >
          <FoldBody>
            <TurnRailFrame>
              <ActivityRail
                items={group.items}
                onOpenSession={onOpenSession}
                onMemoryClick={onMemoryClick}
                toolRegistry={toolRegistry}
                bare
              />
            </TurnRailFrame>
          </FoldBody>
        </TurnSummary>
      );
    case "turn": {
      const activityItems = flattenActivityItems(group.groups);
      // Second-layer chips only when there are natural multi-cluster seams —
      // otherwise the outer turn chip alone is enough ("N steps" wrapping one
      // more "N steps" was the redundant double fold).
      const nestClusters = foldableActivityClusterCount(group.groups) >= 2;
      const turnCopyText = collectTurnCopyText(group.groups, trailingAgentText);
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
          turnSummary={turnSummary}
          insideTurn
          nestClusterChips={nestClusters}
        />
      ));
      return (
        <TurnSummary
          items={activityItems}
          outcome={group.outcome}
          failureText={insideTurn ? undefined : group.failureText}
          durationMs={durationBetween(group.startedAt, group.endedAt)}
          defaultOpen={turnDefaultOpen ? true : undefined}
          bare={insideTurn}
          facets={turnSummary?.facets}
          settleFold={settleFold}
          copyText={insideTurn ? undefined : turnCopyText}
        >
          <FoldBody>
            {insideTurn ? (
              // A nested turn is already on an ancestor rail — its body just stacks
              // flush (the bare-node body already indents it), so no second rule.
              <div className="flex flex-col gap-4">{body}</div>
            ) : (
              <TurnRailFrame>{body}</TurnRailFrame>
            )}
          </FoldBody>
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
});

/**
 * Rows revealed by a disclosure — expanding a chip, or the settle-fold beat —
 * must not run per-row entrance animations: the disclosure's height animation
 * owns the motion, and rows that were ALREADY visible when a live cluster
 * folds would otherwise flash as they remount inside the summary. Entrance
 * stays reserved for rows arriving in the live timeline flow.
 */
function FoldBody({ children }: { children: ReactNode }) {
  return <EntranceAnimationProvider value={false}>{children}</EntranceAnimationProvider>;
}

/** Stable left rule for turn/activity bodies — always present so settle wrap
    never inserts or removes the rail chrome. */
function TurnRailFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-l-2 border-og-border pl-3 sm:pl-4">{children}</div>
  );
}

/**
 * True once THIS component instance has seen its group transition from
 * unfolded to folded — i.e. the reader watched the rows live and the fold is
 * new information worth choreographing. Latched: TurnSummary captures the flag
 * at its own mount (the flip render), so later prop churn is inert. History
 * that mounts already folded initializes folded and never latches.
 */
function useLiveSettleFold(folded: boolean): boolean {
  const previousFoldedRef = useRef(folded);
  const latchedRef = useRef(false);
  if (!previousFoldedRef.current && folded) {
    latchedRef.current = true;
  }
  useLayoutEffect(() => {
    previousFoldedRef.current = folded;
  });
  return latchedRef.current;
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

function timelineGroupItemIds(group: TimelineGroup): string[] {
  switch (group.kind) {
    case "item":
      return [group.item.id];
    case "activity":
      return group.items.map((item) => item.id);
    case "turn":
      return group.groups.flatMap(timelineGroupItemIds);
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
    // Memory writes and fleet observations are discrete, already-settled events.
    if (item.kind === "memory" || item.kind === "fleet-decision") {
      return true;
    }
    return item.status !== "running";
  });
}

/** Settled activity clusters that could become nested chips under a turn. */
function foldableActivityClusterCount(groups: readonly TimelineGroup[]): number {
  let count = 0;
  for (const child of groups) {
    if (child.kind === "activity" && (child.outcome || clusterIsSettled(child))) {
      count += 1;
    }
  }
  return count;
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

/** Assistant prose inside a turn fold (mid-turn narration), joined for copy. */
function collectAgentMessageText(groups: readonly TimelineGroup[]): string {
  const parts: string[] = [];
  for (const group of groups) {
    if (group.kind === "item" && group.item.kind === "agent-message") {
      const text = group.item.text.trim();
      if (text.length > 0) {
        parts.push(text);
      }
    } else if (group.kind === "turn") {
      const nested = collectAgentMessageText(group.groups);
      if (nested.length > 0) {
        parts.push(nested);
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * Settled turns lift the final agent answer out as a sibling group. Include it
 * in "Copy turn" when present so the chip copies the full assistant reply.
 */
function trailingAgentTextAfterTurn(
  group: TimelineGroup,
  next: TimelineGroup | undefined,
): string | undefined {
  if (group.kind !== "turn") {
    return undefined;
  }
  if (next?.kind === "item" && next.item.kind === "agent-message") {
    const text = next.item.text.trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function collectTurnCopyText(
  groups: readonly TimelineGroup[],
  trailingAgentText: string | undefined,
): string | undefined {
  const parts = [collectAgentMessageText(groups), trailingAgentText?.trim() ?? ""].filter(
    (part) => part.length > 0,
  );
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
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
    case "machine-input-batch":
      return <MachineInputBatchRow item={item} />;
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
        <CopyHoverFrame
          copyText={item.text}
          label="Copy message"
          className="w-fit max-w-full min-w-0"
        >
          <div className="w-fit max-w-full min-w-0 rounded-og-lg rounded-br-og-xs border border-og-border bg-og-surface-2 px-4 py-2.5 pr-10 text-og-md leading-6 text-og-fg">
            {renderMessageText ? (
              renderMessageText(item.text, item)
            ) : (
              <Markdown>{item.text}</Markdown>
            )}
          </div>
        </CopyHoverFrame>
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
  // No streaming caret: it fought the trailing block layout (inline ↔ block)
  // and snapped on exit. Live text already carries the stream via word-entrance
  // + "Working…" when the tip isn't a streaming message.
  const body = renderMessageText ? (
    renderMessageText(item.text, item)
  ) : (
    <Markdown streaming={item.streaming}>{item.text}</Markdown>
  );
  // While streaming, copy is still useful (current text) but keep chrome calm.
  return (
    <CopyHoverFrame
      copyText={item.text}
      label="Copy message"
      align="end"
      className={cn(enter && "animate-og-enter", "min-w-0 pr-9 text-og-md leading-7 text-og-fg")}
    >
      {body}
    </CopyHoverFrame>
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

const MACHINE_INPUT_META: Record<MachineInputBatchItem["members"][number]["kind"], string> = {
  scheduled_occurrence: "Scheduled update",
  goal_continuation: "Goal continued",
  agent_message: "Agent update",
  agent_steer_instruction: "Agent direction",
  child_terminal_result: "Agent finished",
};

function MachineInputBatchRow({ item }: { item: MachineInputBatchItem }) {
  const enter = useEntranceAnimation();
  const visible = item.members.slice(0, 3);
  return (
    <div
      className={cn(
        enter && "animate-og-enter",
        "rounded-og-md border border-og-border/70 bg-og-surface-1/55 px-3 py-2.5",
      )}
    >
      {item.members.length > 1 && (
        <div className="mb-2 text-xs font-medium text-og-fg-subtle">
          {item.members.length} updates joined this turn
        </div>
      )}
      <div className="space-y-2">
        {visible.map((member) => (
          <MachineInputRow key={member.id} member={member} />
        ))}
      </div>
      {item.members.length > visible.length && (
        <details className="mt-2 pl-8 text-xs text-og-fg-muted">
          <summary className="cursor-pointer select-none hover:text-og-fg">
            Show {item.members.length - visible.length} more
          </summary>
          <div className="mt-2 space-y-2">
            {item.members.slice(visible.length).map((member) => (
              <MachineInputRow key={member.id} member={member} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function MachineInputRow({ member }: { member: MachineInputBatchItem["members"][number] }) {
  const source = readableMachineInputSource(member.sourceId);
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-og-fg-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium text-og-fg-muted">
          {MACHINE_INPUT_META[member.kind]}
        </span>
        {source && <span className="ml-1.5 text-xs text-og-fg-subtle">from {source}</span>}
        {member.summary && (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-5 text-og-fg">
            {truncate(cleanMachineInputSummary(member.summary), 320)}
          </p>
        )}
      </div>
    </div>
  );
}

function readableMachineInputSource(sourceId: string): string | null {
  const value = sourceId.trim();
  if (!value || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return null;
  if (/^(goal|schedule|system):/i.test(value)) return null;
  return value.replaceAll("_", " ");
}

function cleanMachineInputSummary(summary: string): string {
  return summary.replace(/^\[[A-Z][A-Z _-]*(?:\s+\d+\/\d+)?\]\s*/, "").trim();
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
 * The inline connection-recovery card: missing or lapsed access surfaces as a
 * calm, tappable affordance instead of a raw provider-domain error. The `reason`
 * only shapes human copy; no domain or enum code is shown as a label.
 * `onReconnect` (from the app, which owns the SDK client) starts the flow;
 * without it, a pre-minted authorization link is offered, or the card stays
 * informative. Recovery never claims to resume/replay the failed tool call.
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
  const unavailable =
    item.reason === "unsupported_auth" || item.reason === "resource_scope_unavailable";
  const missing = item.reason === "missing_connection";
  const actionLabel = missing ? "Connect" : "Reconnect";

  const start = async () => {
    if (!onReconnect || busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      // On success the app redirects to consent (or routes to credential entry),
      // so this row unmounts; a resolve without navigation just relaxes the button.
      // The callback starts authorization only. It never resumes this tool call.
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
            <p className="truncate text-og-md font-medium text-og-fg">
              {unavailable ? `${provider} tools unavailable` : `${actionLabel} ${provider}`}
            </p>
            <p className="truncate text-og-sm text-og-fg-subtle">{authReasonLine(item.reason)}</p>
          </div>
        </div>
        {!unavailable && onReconnect ? (
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
            {busy ? "Opening…" : actionLabel}
          </button>
        ) : !unavailable && item.authorizationUrl ? (
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
            {actionLabel}
          </a>
        ) : null}
      </div>
      {!unavailable ? (
        <p className="px-1 text-og-xs text-og-fg-subtle">
          This tool call wasn't replayed. After {missing ? "connecting" : "reconnecting"}, send a
          new message to try again.
        </p>
      ) : null}
      {failed ? (
        <p className="px-1 text-og-xs text-og-status-failed">
          Couldn't start {missing ? "connecting" : "reconnecting"} {provider}. Try again.
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
    case "unsupported_auth":
      return "This connection cannot authenticate the configured tool endpoint.";
    case "resource_scope_unavailable":
      return "This tool endpoint cannot enforce the selected repository access.";
    default:
      return "Its connection needs attention.";
  }
}
