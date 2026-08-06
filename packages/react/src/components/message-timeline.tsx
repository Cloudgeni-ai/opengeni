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
  ShrinkIcon,
  TargetIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Collapsible } from "radix-ui";
import {
  Component,
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
import { formatClockTime, formatRelativeTime, truncate } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { Markdown } from "./markdown";
import {
  UserMessageBody,
  UserMessageDisclosureProvider,
  type UserMessageDisclosureContextValue,
} from "./user-message-body";
import {
  createTipFollowState,
  readerScrollUpPx,
  tipFollowCancel,
  tipFollowCompensateShrink,
  tipFollowCompensateViewportShrink,
  tipFollowStep,
  supportsScrollEndEvent,
  TIP_FOLLOW_READER_UP_EPS_PX,
  TIP_FOLLOW_SHRINK_EPS_PX,
  type TipFollowState,
} from "./tip-follow";
import {
  ActivityRail,
  buildTimeline,
  defaultToolRegistry,
  groupTimeline,
  LightboxProvider,
  type ActivityItem,
  type AgentMessageItem,
  type AuthNeededItem,
  type ContextCompactionItem,
  type GoalItem,
  type MachineInputBatchItem,
  type NoticeItem,
  type TimelineGroup,
  type TimelineItem,
  type RetainedScreenshotLoader,
  type ToolRegistry,
  type TurnSummaryOptions,
  type UserMessageItem,
  type FoldRestingState,
  type WorkerCompletionItem,
  FoldMemoryProvider,
  inheritFoldRestingState,
  TurnSummary,
  useFoldMemory,
  useTurnSettleOpen,
} from "../timeline";
import { CopyHoverFrame } from "./copy-button";
import {
  MACHINE_INPUT_META,
  cleanMachineInputSummary,
  machineInputBatchLabel,
  machineInputSummaryIsUseful,
  readableMachineInputSource,
} from "./machine-input-display";
import { SESSION_STATUS_META, StatusDot } from "./session-status";
import { TimelineComputeLabelProvider } from "../timeline/compute-label";
import { EntranceAnimationProvider, useEntranceAnimation } from "../timeline/entrance";
import { SeenActivityIdsProvider } from "../timeline/seen-activity-ids";
import { TooltipProvider } from "./tooltip";

export type MessageTimelineProps = {
  /** Raw session events (projected internally) … */
  events?: SessionEvent[] | undefined;
  /** … or pre-projected items (e.g. from `useSessionEvents().timeline`). */
  items?: TimelineItem[] | undefined;
  /** Current session status (reserved; tip "Working…" chrome removed for now). */
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
   * Decide which durable authentication notices this timeline presents.
   * Defaults to showing every notice. Embedded hosts can suppress notices for
   * credentials they manage elsewhere without discarding the underlying event.
   */
  shouldRenderAuthNeeded?: ((item: AuthNeededItem) => boolean) | undefined;
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
  /** Resolve opaque retained screenshot receipts through the authenticated host SDK. */
  loadRetainedScreenshot?: RetainedScreenshotLoader | undefined;
  /**
   * Display name of the session's active compute target (Connected Machine or
   * cloud sandbox). When set, exec_command collapsed previews prefix `on {label}`.
   */
  computeLabel?: string | null | undefined;
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
  /** Host-owned content appended after timeline groups, such as startup progress. */
  trailingState?: ReactNode | undefined;
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
 * Scroll invariant (tip-follow camera — see `./tip-follow.ts`):
 * - Load/remount: hidden until tip is hard-snapped across a short settle; then
 *   reveal. Live tip: DOM grows immediately; the camera eases down (not
 *   tip-glued feed-forward — that is the one-line yank).
 * - One continuous follow while hot (faster τ when behind); sleeps when cold.
 * - While pinned, tip-debt from growth/collapse must NEVER unpin — only
 *   wheel/keys/pointer-armed scroll-up, or a settled scrollend away from the
 *   tip while the tip-follow camera is idle (Vimium / unfocused PageUp).
 *   Height shrink compensates scrollTop by Δh (collapse owns motion); tip-ease
 *   pauses briefly so the two don't fight. Programmatic camera writes are
 *   tagged so their scroll echoes never count as leave.
 * - overflow-anchor off while pinned so the browser cannot instant-correct.
 * - Scrolled up → history prepends restore via the retained group anchor
 *   (offsetTop delta); loadOlder can truncate the tip, so scrollHeight delta
 *   alone is wrong. Late layout while unpinned stays browser-owned.
 */
const PIN_THRESHOLD_PX = 48;
/**
 * Prefetch older history when the top sentinel is this far from the viewport.
 * After a page loads we stay cool until the reader leaves this band (scrolls
 * down into content) — never re-fire from continued scroll toward y=0.
 */
const OLDER_PREFETCH_MARGIN_PX = 400;
const OLDER_PREFETCH_ROOT_MARGIN = `${OLDER_PREFETCH_MARGIN_PX}px 0px 0px 0px`;

/**
 * Pinned = the viewport bottom is within PIN_THRESHOLD_PX of the content
 * bottom. When the scroll range itself is shorter than the threshold, the
 * whole range would count as "at the bottom" and the reader could never unpin
 * to reach older history — so the effective threshold shrinks to the range,
 * making the very top of a short window count as scrolled up. A window that
 * cannot scroll at all is always pinned.
 */
function maxScrollOf(node: HTMLElement): number {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

/**
 * Wheel bubbled from a nested overflow scroller that can still move up — not
 * timeline intent (code blocks / notice `<pre>`).
 */
function wheelConsumedByNestedScrollable(event: {
  deltaY: number;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}): boolean {
  if (event.deltaY >= 0) {
    return false;
  }
  let el = event.target instanceof Element ? event.target : null;
  const root = event.currentTarget instanceof Element ? event.currentTarget : null;
  while (el && el !== root) {
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        el.scrollHeight > el.clientHeight + 1 &&
        el.scrollTop > 0
      ) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

function isNearBottom(node: HTMLElement): boolean {
  const maxScroll = maxScrollOf(node);
  if (maxScroll <= 1) {
    return true;
  }
  const gap = maxScroll - node.scrollTop;
  return gap < Math.min(PIN_THRESHOLD_PX, maxScroll);
}

/** Escape a value for use inside a CSS attribute selector. */
function cssEscapeAttribute(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
  status: _status,
  renderMessageText,
  onOpenSession,
  onMemoryClick,
  onReconnect,
  shouldRenderAuthNeeded,
  resolveProviderLogo,
  toolRegistry = defaultToolRegistry,
  loadRetainedScreenshot,
  computeLabel = null,
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
  trailingState,
  emptyState,
  className,
}: MessageTimelineProps) {
  const resolvedItems = useMemo(() => {
    const projected = items ?? buildTimeline(events ?? []);
    if (!shouldRenderAuthNeeded) {
      return projected;
    }
    return projected.filter((item) => item.kind !== "auth-needed" || shouldRenderAuthNeeded(item));
  }, [items, events, shouldRenderAuthNeeded]);
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
  // One loadOlder per visit to the top band. Re-arm only after the reader
  // leaves that band (scrolls down / sentinel exits) — never from scrolling
  // further toward y=0 (that was the batch-top load loop).
  const olderLoadGateRef = useRef<"armed" | "cooling">("armed");
  const resizeFollowRafRef = useRef<number | null>(null);
  const firstGroupKey = allGroups[0] ? timelineGroupKey(allGroups[0]) : null;
  // Content stays invisible until the tip is hard-parked across a short
  // post-commit settle (two rAFs). That absorbs sync late layout while hidden
  // so load/remount does not ease into the tip — live tip-follow is unchanged
  // once revealed. A flash of the window's TOP is still structurally impossible.
  const [revealed, setRevealed] = useState(false);
  // Mirror `pinned` into a ref, written ONLY by applyPinned, so the
  // ResizeObserver rAF (a stable closure) reads the live value and a snap can
  // never race a just-unpinned reader across a pending React commit.
  const pinnedRef = useRef(true);
  // History windows (`hasNewer`) have a bottom that is not the live tip.
  // Pin/follow must ignore that floor — otherwise loadNewer appends yank the
  // reader to the new page bottom. LoadOlder prepends already stay put because
  // the reader is unpinned and scroll anchoring / delta correction owns place.
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;
  // Jump-to-latest pressed while a history window is showing: the pin must
  // wait for the tip window to actually land (`hasNewer` → false) — pinning
  // immediately would snap to the bottom of the CURRENT history page and
  // page-crawl forward through the gap.
  const wantPinRef = useRef(false);
  // Jump-to-start pressed: consume on the commit that swaps the window so the
  // scroll-to-top write races neither the old DOM nor the prepend correction.
  const pendingJumpToStartRef = useRef(false);
  // Identifies the newest Jump-to-start click so a settling promise callback
  // from an earlier click can never clear a re-click's pending flag.
  const jumpToStartSeqRef = useRef(0);
  // Prepend detection: the oldest loaded item's id changes exactly when older
  // history lands (including the merge-into-first-group case where the first
  // GROUP key is retained). Item ids, not group keys, are the durable signal.
  const previousFirstItemIdRef = useRef<string | null>(null);
  const previousScrollHeightRef = useRef(0);
  // Per-commit place memory for unpinned prepend restore (see layout effect).
  // Paired with max/height/client for clamp-conservation reader-intent math.
  const lastScrollTopRef = useRef(0);
  const lastMaxScrollRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  /**
   * Armed by pointerdown on the scroller. Immediate geometric scroll-up unpins
   * while armed (scrollbar / touch drag). Wheel/keys unpin directly. Extension
   * jumps (Vimium) settle via scrollend while the camera is idle.
   */
  const readerIntentArmRef = useRef(false);
  /**
   * Count of camera/snap scrollTop writes whose scroll echoes are not yet
   * consumed. A boolean was wrong when the browser coalesced two writes into
   * one scroll event (or fired two) — use a count, and clear to 0 on echo.
   */
  const programmaticScrollRef = useRef(0);
  /**
   * Disclosure height changes are not reader navigation. While an unpinned
   * Show more/less state is active, its clamp/native-anchor scroll echoes must
   * never geometrically re-enable bottom-follow. A later real reader navigation
   * or explicit Jump to latest releases this fence.
   */
  const disclosureKeepsUnpinnedRef = useRef(false);
  /**
   * Unarmed scroll-away observed; waiting for scrollend (or rAF fallback).
   * Blocks layout tip-follow so a stream token cannot yank before leave settles.
   */
  const pendingReaderLeaveRef = useRef(false);
  /** Fallback leave check when `scrollend` is missing (one rAF, not a timer). */
  const leaveFallbackRafRef = useRef<number | null>(null);
  // Resting fold state per durable group id (see fold-memory.ts). Outlives the
  // deliberate chip remounts (activity→turn wrap, nested key flips) so a fold
  // that already settled closed — or that the reader closed — never reopens.
  const foldMemoryRef = useRef<Map<string, FoldRestingState>>(new Map());
  const userMessageDisclosureMemoryRef = useRef<Map<string, boolean>>(new Map());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const groupKeyByItemIdRef = useRef<Map<string, string>>(new Map());
  const groupOffsetByKeyRef = useRef<Map<string, number>>(new Map());
  const firstItemId = resolvedItems[0]?.id ?? null;
  // Bulk paints (the initial tail window, a prepended older window — detected
  // by the first group key changing) must not run per-row entrance animations.
  const firstKeyChangedForBulk =
    previousBulkFirstKeyRef.current !== undefined &&
    previousBulkFirstKeyRef.current !== firstGroupKey;
  const bulkRender = allGroups.length > 0 && (bulkActive || firstKeyChangedForBulk);

  // The ONLY writer of the pinned flag. Ref and state move together, so
  // behavior (refs read by rAF callbacks) and rendering (the anchor class,
  // the Jump-to-latest button) can never desync.
  const applyPinned = useCallback((value: boolean) => {
    if (pinnedRef.current !== value) {
      pinnedRef.current = value;
      setPinned(value);
    }
  }, []);

  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;

  // Pure tip-follow camera. Pin intent uses clamp conservation, not timers.
  const followRef = useRef<TipFollowState>(createTipFollowState());
  const followFrameRef = useRef<number | null>(null);

  const syncScrollBaseline = useCallback((node: HTMLElement) => {
    lastScrollTopRef.current = node.scrollTop;
    lastMaxScrollRef.current = maxScrollOf(node);
    lastScrollHeightRef.current = node.scrollHeight;
    lastClientHeightRef.current = node.clientHeight;
  }, []);

  const writeScrollTop = useCallback((node: HTMLElement, top: number) => {
    const next = Math.max(0, top);
    const before = node.scrollTop;
    if (before === next) {
      return;
    }
    programmaticScrollRef.current += 1;
    node.scrollTop = next;
    if (node.scrollTop === before) {
      // The engine floored a sub-device-pixel write to a no-op: no scroll echo
      // will ever fire. Counting it would leak the echo count and silently eat
      // a later REAL reader scroll as programmatic.
      programmaticScrollRef.current -= 1;
    }
  }, []);

  const cancelLeaveFallback = useCallback(() => {
    if (leaveFallbackRafRef.current !== null) {
      cancelFrame(leaveFallbackRafRef.current);
      leaveFallbackRafRef.current = null;
    }
  }, []);

  const clearPendingReaderLeave = useCallback(() => {
    pendingReaderLeaveRef.current = false;
    cancelLeaveFallback();
  }, [cancelLeaveFallback]);

  const stopFollow = useCallback(() => {
    followRef.current = tipFollowCancel(followRef.current);
    if (followFrameRef.current !== null) {
      cancelFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
  }, []);

  /** Reader left the tip — wheel, keyboard, pointer-armed scroll-up, or scrollend. */
  const releasePinFromReader = useCallback(
    (node?: HTMLElement | null) => {
      if (!autoFollow || !pinnedRef.current || hasNewerRef.current) {
        return;
      }
      // Unscrollable window: unpin strands Jump-to-latest with no way back.
      if (node && maxScrollOf(node) <= 1) {
        return;
      }
      readerIntentArmRef.current = false;
      clearPendingReaderLeave();
      stopFollow();
      applyPinned(false);
      if (wantPinRef.current) {
        wantPinRef.current = false;
      }
      if (!olderPrefetchArmedRef.current) {
        olderPrefetchArmedRef.current = true;
        setOlderPrefetchArmed(true);
      }
    },
    [autoFollow, applyPinned, clearPendingReaderLeave, stopFollow],
  );

  /**
   * Settled away from the tip while the camera is idle — Vimium / unfocused
   * PageUp. Folds are recovered by layout tip-follow before this fires at tip.
   */
  const releasePinAfterScrollSettled = useCallback(
    (node: HTMLElement) => {
      if (!autoFollow || !pinnedRef.current || hasNewerRef.current) {
        return;
      }
      if (programmaticScrollRef.current > 0) {
        return;
      }
      if (followRef.current.running || followFrameRef.current !== null) {
        return;
      }
      if (isNearBottom(node) || maxScrollOf(node) <= 1) {
        clearPendingReaderLeave();
        return;
      }
      releasePinFromReader(node);
      if (olderLoadGateRef.current === "cooling" && node.scrollTop > OLDER_PREFETCH_MARGIN_PX) {
        olderLoadGateRef.current = "armed";
      }
    },
    [autoFollow, clearPendingReaderLeave, releasePinFromReader],
  );

  const scheduleLeaveFallback = useCallback(() => {
    // Prefer scrollend when the engine supports it.
    if (supportsScrollEndEvent()) {
      return;
    }
    cancelLeaveFallback();
    leaveFallbackRafRef.current = requestFrame(() => {
      leaveFallbackRafRef.current = null;
      const current = scrollRef.current;
      if (current) {
        releasePinAfterScrollSettled(current);
      }
    });
  }, [cancelLeaveFallback, releasePinAfterScrollSettled]);

  const onWheel = (event: {
    deltaY: number;
    deltaX: number;
    target: EventTarget | null;
    currentTarget: EventTarget | null;
  }) => {
    // Nested overflow (code / notice pre) or mostly-horizontal pan: not
    // timeline reader intent. A real timeline wheel in either direction
    // releases the disclosure fence; downward movement may then re-pin
    // naturally when it reaches the bottom.
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    if (wheelConsumedByNestedScrollable(event)) {
      return;
    }
    disclosureKeepsUnpinnedRef.current = false;
    if (event.deltaY >= 0) {
      return;
    }
    const node =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : scrollRef.current;
    releasePinFromReader(node);
  };

  /** Touch / stylus / mouse drag on the scroller — explicit leave (not layout). */
  const onPointerDown = (event: {
    button: number;
    pointerType: string;
    target: EventTarget | null;
  }) => {
    // Primary button / touch / pen only. Ignore right-click etc.
    if (event.button !== 0 && event.pointerType === "mouse") {
      return;
    }
    // Clicks on chips/buttons/links must not arm — their settle collapse
    // also drops scrollTop and would false-unpin. Drag on prose/scroller may.
    if (
      event.target instanceof Element &&
      event.target.closest("button, a, input, textarea, select, [role='button']")
    ) {
      return;
    }
    disclosureKeepsUnpinnedRef.current = false;
    readerIntentArmRef.current = true;
  };

  const onKeyDown = (event: { key: string; currentTarget: EventTarget | null }) => {
    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "PageUp" ||
      event.key === "PageDown" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      disclosureKeepsUnpinnedRef.current = false;
    }
    if (event.key !== "ArrowUp" && event.key !== "PageUp" && event.key !== "Home") {
      return;
    }
    const node =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : scrollRef.current;
    releasePinFromReader(node);
  };

  const snapToBottom = useCallback(
    (node: HTMLElement) => {
      stopFollow();
      cancelLeaveFallback();
      writeScrollTop(node, Math.max(0, node.scrollHeight - node.clientHeight));
      syncScrollBaseline(node);
      followRef.current = {
        ...followRef.current,
        lastHeight: node.scrollHeight,
        lastClientHeight: node.clientHeight,
        cameraTop: null,
      };
    },
    [cancelLeaveFallback, stopFollow, syncScrollBaseline, writeScrollTop],
  );

  const beginUserMessageDisclosureChange = useCallback(
    (messageBody: HTMLElement, disclosureControl: HTMLElement) => {
      const node = scrollRef.current;
      if (!node || !node.contains(messageBody)) {
        return null;
      }
      const keepBottom = autoFollow && pinnedRef.current && !hasNewerRef.current;
      if (keepBottom) {
        return () => {
          const current = scrollRef.current;
          if (current) {
            snapToBottom(current);
          }
        };
      }

      disclosureKeepsUnpinnedRef.current = true;

      const scrollerRect = node.getBoundingClientRect();
      const group = messageBody.closest<HTMLElement>("[data-og-timeline-group-anchor]");
      const groupRect = group?.getBoundingClientRect();
      // Expanding from a visible message top keeps the beginning in place.
      // Collapsing after reading deep in the message keeps the disclosure
      // control in place because the message top is already above the viewport.
      const anchor =
        group &&
        groupRect &&
        groupRect.top >= scrollerRect.top - 1 &&
        groupRect.top < scrollerRect.bottom
          ? group
          : disclosureControl;
      const beforeTop = anchor.getBoundingClientRect().top - scrollerRect.top;

      return () => {
        const current = scrollRef.current;
        if (!current || !current.contains(anchor)) {
          return;
        }
        const currentScrollerTop = current.getBoundingClientRect().top;
        const afterTop = anchor.getBoundingClientRect().top - currentScrollerTop;
        const delta = afterTop - beforeTop;
        if (Math.abs(delta) > 0.5) {
          writeScrollTop(current, current.scrollTop + delta);
        }
        applyPinned(false);
        syncScrollBaseline(current);
      };
    },
    [applyPinned, autoFollow, snapToBottom, syncScrollBaseline, writeScrollTop],
  );

  const userMessageDisclosureContext = useMemo<UserMessageDisclosureContextValue>(
    () => ({
      expandedByMessageId: userMessageDisclosureMemoryRef.current,
      beginChange: beginUserMessageDisclosureChange,
    }),
    [beginUserMessageDisclosureChange],
  );

  const driveFollowRef = useRef<(node: HTMLElement, now?: number) => void>(() => undefined);
  const driveFollow = useCallback(
    (node: HTMLElement, nowMs?: number) => {
      if (!pinnedRef.current || hasNewerRef.current) {
        stopFollow();
        return;
      }
      // Reader/extension leave in flight — do not yank back before scrollend.
      if (pendingReaderLeaveRef.current) {
        stopFollow();
        return;
      }
      cancelLeaveFallback();
      // Prefer the rAF timestamp so ease integrates against vsync (and tests
      // can advance a synthetic clock via requestAnimationFrame callbacks).
      const now =
        typeof nowMs === "number"
          ? nowMs
          : typeof performance !== "undefined"
            ? performance.now()
            : Date.now();
      const previousHeight = followRef.current.lastHeight;
      // Settle-collapse: compensate Δh from the pre-shrink baseline (browser
      // may already have clamped — don't double-subtract). Keep the follow rAF
      // alive so when collapse ends (or stream resumes) we ease instead of a
      // hard stop → flick. Do NOT tip-ease on the same frame as a real shrink
      // (that fight was the top-of-viewport flicker).
      if (previousHeight > 0 && node.scrollHeight < previousHeight - TIP_FOLLOW_SHRINK_EPS_PX) {
        let nextTop = tipFollowCompensateShrink(
          lastScrollTopRef.current,
          previousHeight,
          node.scrollHeight,
          node.clientHeight,
        );
        // A chrome/composer dock can land on the same frame as a settle-fold
        // (the "turn blocked" moment). Compensate BOTH in one write — adopting
        // the shrunk clientHeight below without gluing left the chrome height
        // behind as cold tip debt.
        const previousClient = followRef.current.lastClientHeight;
        if (previousClient > 0 && node.clientHeight < previousClient - TIP_FOLLOW_SHRINK_EPS_PX) {
          nextTop = tipFollowCompensateViewportShrink(
            nextTop,
            previousClient,
            node.clientHeight,
            node.scrollHeight,
          );
        }
        writeScrollTop(node, nextTop);
        syncScrollBaseline(node);
        followRef.current = {
          ...followRef.current,
          lastHeight: node.scrollHeight,
          lastClientHeight: node.clientHeight,
          running: true,
          lastTs: now,
          // A direct glue write re-based the camera — drop any stale fraction.
          cameraTop: null,
        };
        if (followFrameRef.current === null) {
          followFrameRef.current = requestFrame((frameNow) => {
            followFrameRef.current = null;
            const current = scrollRef.current;
            if (current) {
              driveFollowRef.current(current, frameNow);
            }
          });
        }
        return;
      }
      // Sub-eps height noise: adopt height without moving the camera. Do NOT
      // adopt clientHeight here — tipFollowStep (next line) owns that baseline
      // and must still see a same-frame viewport shrink to glue it.
      if (previousHeight > 0 && node.scrollHeight < previousHeight) {
        followRef.current = {
          ...followRef.current,
          lastHeight: node.scrollHeight,
        };
      }
      const result = tipFollowStep(followRef.current, {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        now,
        pinned: true,
        reducedMotion: prefersReducedMotion(),
        revealed: revealedRef.current,
      });
      followRef.current = result.state;
      writeScrollTop(node, result.scrollTop);
      syncScrollBaseline(node);
      if (result.state.running) {
        cancelLeaveFallback();
        if (followFrameRef.current === null) {
          followFrameRef.current = requestFrame((frameNow) => {
            followFrameRef.current = null;
            const current = scrollRef.current;
            if (current) {
              driveFollowRef.current(current, frameNow);
            }
          });
        }
      } else if (followFrameRef.current !== null) {
        cancelFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    },
    [cancelLeaveFallback, stopFollow, syncScrollBaseline, writeScrollTop],
  );
  driveFollowRef.current = driveFollow;

  useEffect(() => stopFollow, [stopFollow]);
  useEffect(() => () => cancelLeaveFallback(), [cancelLeaveFallback]);

  // The single post-commit scroll authority. Runs after EVERY commit (no dep
  // list): any commit may change content height, and the decision is cheap.
  // Also the ONLY writer of the prepend-correction baselines
  // (previousFirstItemIdRef / previousScrollHeightRef / group offset maps).
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Deliberately runs after every commit.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const previousFirstItemId = previousFirstItemIdRef.current;
    const previousGroupKeyByItemId = groupKeyByItemIdRef.current;
    const previousGroupOffsetByKey = groupOffsetByKeyRef.current;
    const previousScrollTop = lastScrollTopRef.current;
    const firstItemChanged = previousFirstItemId !== null && firstItemId !== previousFirstItemId;
    const prepended =
      firstItemChanged && resolvedItems.some((item) => item.id === previousFirstItemId);
    if (pendingJumpToStartRef.current && firstItemChanged) {
      // The oldest window landed — jump against the NEW DOM, and skip the
      // prepend correction (it would shift the reader away from the top).
      pendingJumpToStartRef.current = false;
      stopFollow();
      writeScrollTop(node, 0);
    } else if (wantPinRef.current && !hasNewer) {
      // Jump-to-latest was pressed on a history window and the tip window is
      // in THIS commit — consume pre-paint so the first tip frame is already
      // at the bottom (post-paint consumption flashed one clamped frame).
      wantPinRef.current = false;
      if (autoFollow) {
        applyPinned(true);
        snapToBottom(node);
      }
    } else if (autoFollow && pinnedRef.current && !hasNewer) {
      // Load/remount (still hidden): hard-park. Live tip after reveal: ease.
      // Pending unarmed leave: tip *growth* must not yank (Vimium during stream).
      // Flat/shrink commits (fold) still recover — height did not grow under us.
      if (!revealedRef.current) {
        snapToBottom(node);
      } else if (pendingReaderLeaveRef.current) {
        if (node.scrollHeight <= lastScrollHeightRef.current) {
          clearPendingReaderLeave();
          driveFollow(node);
        }
      } else {
        driveFollow(node);
      }
    } else if (prepended) {
      // Keep the reader on the same retained rows. Prefer the offsetTop delta
      // of the group that still holds the previous first item — that stays
      // correct when loadOlder also truncates the tip (height delta then lies).
      // If native anchoring already applied the same shift, leave scrollTop.
      const anchorKey =
        previousFirstItemId !== null
          ? previousGroupKeyByItemId.get(previousFirstItemId)
          : undefined;
      const previousAnchorTop =
        anchorKey !== undefined ? previousGroupOffsetByKey.get(anchorKey) : undefined;
      const anchorEl =
        anchorKey !== undefined
          ? node.querySelector(`[data-og-group-key="${cssEscapeAttribute(anchorKey)}"]`)
          : null;
      let delta: number | null = null;
      if (anchorEl instanceof HTMLElement && previousAnchorTop !== undefined) {
        const moved = Math.round(anchorEl.offsetTop - previousAnchorTop);
        if (moved !== 0) {
          delta = moved;
        }
      }
      if (delta === null) {
        const heightDelta = Math.round(node.scrollHeight - previousScrollHeightRef.current);
        if (heightDelta > 0) {
          delta = heightDelta;
        }
      }
      if (delta !== null) {
        const expected = previousScrollTop + delta;
        if (Math.abs(node.scrollTop - expected) > 2) {
          writeScrollTop(node, expected);
        }
      }
    }
    // After a prepend, if restore left us below the top prefetch band,
    // re-arm so a later approach can load again. Still cooling while parked
    // inside the band (short pages) — that stops the y=0 load loop.
    if (
      prepended &&
      !pinnedRef.current &&
      olderLoadGateRef.current === "cooling" &&
      node.scrollTop > OLDER_PREFETCH_MARGIN_PX
    ) {
      olderLoadGateRef.current = "armed";
    }
    previousFirstItemIdRef.current = firstItemId;
    previousScrollHeightRef.current = node.scrollHeight;
    syncScrollBaseline(node);
    // Item→group keys are cheap (data only). offsetTop queries are O(groups)
    // layout reads — skip while pinned at the live tip (every stream token
    // used to remeasure the whole timeline; that was the long-run lag).
    const nextKeyByItemId = new Map<string, string>();
    for (const { group, key } of groups) {
      for (const itemId of timelineGroupItemIds(group)) {
        nextKeyByItemId.set(itemId, key);
      }
    }
    groupKeyByItemIdRef.current = nextKeyByItemId;
    const needOffsets = prepended || firstItemChanged || !pinnedRef.current || Boolean(hasNewer);
    if (needOffsets) {
      const nextOffsetByKey = new Map<string, number>();
      for (const { key } of groups) {
        const el = node.querySelector(`[data-og-group-key="${cssEscapeAttribute(key)}"]`);
        if (el instanceof HTMLElement) {
          nextOffsetByKey.set(key, el.offsetTop);
        }
      }
      groupOffsetByKeyRef.current = nextOffsetByKey;
    }
  });

  // First paint / session remount: keep the scroller hidden, snap to tip for
  // two animation frames (late sync layout), then reveal. Does not change the
  // tip-follow ease law used once `revealed` is true.
  useLayoutEffect(() => {
    if (revealed || allGroups.length === 0) {
      return;
    }
    let cancelled = false;
    let frame2 = 0;
    const park = () => {
      const node = scrollRef.current;
      if (node && autoFollow && pinnedRef.current && !hasNewerRef.current) {
        snapToBottom(node);
      }
    };
    park();
    const frame1 = requestFrame(() => {
      if (cancelled) {
        return;
      }
      park();
      frame2 = requestFrame(() => {
        if (cancelled) {
          return;
        }
        park();
        setRevealed(true);
      });
    });
    return () => {
      cancelled = true;
      cancelFrame(frame1);
      if (frame2 !== 0) {
        cancelFrame(frame2);
      }
    };
  }, [revealed, allGroups.length, autoFollow, snapToBottom]);

  // A cleared timeline (stream identity change) re-arms the reveal + prefetch
  // gate and returns to bottom-follow for the next session's first paint.
  useLayoutEffect(() => {
    if (allGroups.length > 0) {
      return;
    }
    if (revealed) {
      setRevealed(false);
    }
    if (olderPrefetchArmedRef.current) {
      olderPrefetchArmedRef.current = false;
      setOlderPrefetchArmed(false);
    }
    olderLoadGateRef.current = "armed";
    wantPinRef.current = false;
    pendingJumpToStartRef.current = false;
    previousFirstItemIdRef.current = null;
    previousScrollHeightRef.current = 0;
    lastScrollTopRef.current = 0;
    lastMaxScrollRef.current = 0;
    lastScrollHeightRef.current = 0;
    lastClientHeightRef.current = 0;
    groupKeyByItemIdRef.current = new Map();
    groupOffsetByKeyRef.current = new Map();
    foldMemoryRef.current.clear();
    userMessageDisclosureMemoryRef.current.clear();
    disclosureKeepsUnpinnedRef.current = false;
    seenActivityIdsRef.current.clear();
    applyPinned(true);
  }, [allGroups.length, revealed, applyPinned]);

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
  // Once armed, the sentinel trips early so backfill is usually rendered
  // (and its scroll delta corrected) before the reader reaches it. Gated so
  // a short prepend that leaves the sentinel intersecting cannot loop.
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
        const intersecting = entries.some((entry) => entry.isIntersecting);
        if (!intersecting) {
          // Left the top band — next approach may load once.
          olderLoadGateRef.current = "armed";
          return;
        }
        if (olderLoadGateRef.current !== "armed") {
          return;
        }
        olderLoadGateRef.current = "cooling";
        onLoadOlder();
      },
      { root, rootMargin: OLDER_PREFETCH_ROOT_MARGIN },
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
  // blocks) grows content without a commit. While pinned, soft-follow the tip;
  // unpinned: do nothing — chasing those shifts was the wobble. Coalesce RO
  // into one rAF.
  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.firstElementChild;
    if (!node || !inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (resizeFollowRafRef.current !== null) {
        return;
      }
      resizeFollowRafRef.current = requestFrame(() => {
        resizeFollowRafRef.current = null;
        const current = scrollRef.current;
        if (!current) {
          return;
        }
        if (!autoFollow || !pinnedRef.current || hasNewerRef.current) {
          return;
        }
        // Still unveiling the first tip frame: hard-park (no ease settle).
        if (!revealedRef.current) {
          snapToBottom(current);
          return;
        }
        driveFollow(current);
      });
    });
    observer.observe(inner);
    // The scroller's own box moves the bottom too (window resize, composer
    // growing): clientHeight changes with no inner resize and no commit.
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (resizeFollowRafRef.current !== null) {
        cancelFrame(resizeFollowRafRef.current);
        resizeFollowRafRef.current = null;
      }
    };
  }, [autoFollow, driveFollow, snapToBottom]);

  // Entering a non-tip history window: drop any live pin so the page bottom
  // cannot re-stick follow across loadNewer. Leaving it (the tip window
  // landed): honor a pending Jump-to-latest, or re-pin a reader already parked
  // at what just became the live bottom — paging forward to the tip must not
  // strand them unpinned watching new content grow below.
  useEffect(() => {
    if (hasNewer) {
      stopFollow();
      applyPinned(false);
      return;
    }
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    if (wantPinRef.current) {
      wantPinRef.current = false;
      if (autoFollow) {
        applyPinned(true);
        snapToBottom(node);
      }
      return;
    }
    if (autoFollow && !pinnedRef.current && isNearBottom(node)) {
      applyPinned(true);
    }
  }, [hasNewer, autoFollow, applyPinned, snapToBottom, stopFollow]);

  // Pinned: layout/camera recover tip debt; wheel/keys/pointer-arm unpin
  // immediately; extension jumps settle via scrollend (or one-rAF fallback).
  // Do not tip-follow-yank an in-flight unarmed scroll-away — that ate Vimium.
  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const previousTop = lastScrollTopRef.current;
    const previousMaxScroll = lastMaxScrollRef.current;
    const nextTop = node.scrollTop;
    const nextMaxScroll = maxScrollOf(node);
    const nextHeight = node.scrollHeight;
    const readerUp = readerScrollUpPx(previousTop, nextTop, previousMaxScroll, nextMaxScroll);
    const maxFell = nextMaxScroll < previousMaxScroll - 1;
    const readerArmed = readerIntentArmRef.current;
    const heightShrunk =
      followRef.current.lastHeight > 0 &&
      nextHeight < followRef.current.lastHeight - TIP_FOLLOW_SHRINK_EPS_PX;
    // Consume all pending camera-write echoes (browsers may coalesce writes).
    const programmatic = programmaticScrollRef.current > 0;
    if (programmatic) {
      programmaticScrollRef.current = 0;
    }
    if (disclosureKeepsUnpinnedRef.current) {
      stopFollow();
      applyPinned(false);
      syncScrollBaseline(node);
      return;
    }

    if (autoFollow && pinnedRef.current && !hasNewer) {
      // Fold / composer / SessionChrome: viewport shrink raises maxScroll without
      // growing content. Must hit tipFollow before we adopt the new clientHeight
      // (the near-bottom branch used to poison lastClientHeight and skip glue).
      const previousClient = followRef.current.lastClientHeight;
      const viewportShrunk =
        previousClient > 0 && node.clientHeight < previousClient - TIP_FOLLOW_SHRINK_EPS_PX;
      // Fold / composer content shrink: compensate before baseline sync so
      // driveFollow still sees the pre-shrink scrollTop (avoid double-subtract).
      if (heightShrunk || maxFell || viewportShrunk) {
        readerIntentArmRef.current = false;
        clearPendingReaderLeave();
        driveFollow(node);
        return;
      }
      if (programmatic) {
        // Camera-write echo: consume it, sync the SHELL baselines only. The
        // camera's growth baselines (lastHeight / lastClientHeight) belong to
        // tipFollowStep — adopting them here made every echo "consume" growth
        // that arrived without a commit (motion/Radix height animations of
        // nested tools, late layout). Echoes fire before rAF callbacks, so the
        // step saw frameGrowth=0, never heated, and the cold ~42px/s settle
        // let bursty growth park the tip under the chrome.
        syncScrollBaseline(node);
        return;
      }
      syncScrollBaseline(node);
      const nearBottomPinned = isNearBottom(node);
      if (nearBottomPinned) {
        clearPendingReaderLeave();
      }
      // Pointer-dragged scroll-up away from tip. Layout churn never arms this.
      if (readerArmed && readerUp > TIP_FOLLOW_READER_UP_EPS_PX && !nearBottomPinned) {
        readerIntentArmRef.current = false;
        releasePinFromReader(node);
        if (olderLoadGateRef.current === "cooling" && node.scrollTop > OLDER_PREFETCH_MARGIN_PX) {
          olderLoadGateRef.current = "armed";
        }
        return;
      }
      // Tip grew under a still viewport (no reader-up): ease back to the tip.
      // Reader/extension scroll-up in progress: do not yank — scrollend decides.
      // Near-bottom with tipDebt≈0 stays the quiet path (do not broaden follow
      // inside PIN_THRESHOLD — that fights small intentional scroll-ups).
      if (!nearBottomPinned && readerUp <= TIP_FOLLOW_READER_UP_EPS_PX) {
        if (!pendingReaderLeaveRef.current) {
          driveFollow(node);
        }
      } else if (!nearBottomPinned && readerUp > TIP_FOLLOW_READER_UP_EPS_PX) {
        pendingReaderLeaveRef.current = true;
        scheduleLeaveFallback();
      }
      // Near-bottom reader jiggle: stay quiet, and leave the camera's growth
      // baselines alone — adopting them here stole the heat of growth the
      // step had not seen yet (the next driveFollow then settled cold and
      // parked short inside the pin band).
      return;
    }

    syncScrollBaseline(node);
    const nearBottom = isNearBottom(node);

    // Re-pin only when the reader moved toward/at the tip — not when a fold
    // clamp dragged scrollTop down onto nearBottom.
    const nextPinned =
      !hasNewer && nearBottom && nextTop >= previousTop - TIP_FOLLOW_READER_UP_EPS_PX;
    if (!nextPinned) {
      stopFollow();
    }
    applyPinned(nextPinned);
    // A far-from-bottom scroll while a Jump-to-latest is pending is the reader
    // changing their mind: drop the latch, or a stale one (host rejected or
    // never flipped hasNewer) would fire a surprise pin + snap whenever the
    // reader later pages to the tip themselves. Our own snaps land AT the
    // bottom, so their echoes read nearBottom and keep a live latch.
    if (wantPinRef.current && !nearBottom) {
      wantPinRef.current = false;
    }
    if (nextPinned) {
      return;
    }
    if (!olderPrefetchArmedRef.current) {
      olderPrefetchArmedRef.current = true;
      setOlderPrefetchArmed(true);
    }
    // Re-arm older prefetch only after leaving the top band (scroll down into
    // content). Never re-arm/load from continued scroll toward y=0.
    if (olderLoadGateRef.current === "cooling" && node.scrollTop > OLDER_PREFETCH_MARGIN_PX) {
      olderLoadGateRef.current = "armed";
    }
  };

  const onScrollEnd = () => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    cancelLeaveFallback();
    if (disclosureKeepsUnpinnedRef.current) {
      programmaticScrollRef.current = 0;
      stopFollow();
      applyPinned(false);
      syncScrollBaseline(node);
      return;
    }
    if (programmaticScrollRef.current > 0) {
      programmaticScrollRef.current = 0;
      syncScrollBaseline(node);
      return;
    }
    releasePinAfterScrollSettled(node);
  };

  return (
    <LightboxProvider>
      <FoldMemoryProvider value={foldMemoryRef.current}>
        <SeenActivityIdsProvider value={seenActivityIdsRef.current}>
          <TimelineComputeLabelProvider value={computeLabel ?? null}>
            <EntranceAnimationProvider value={!bulkRender}>
              <TooltipProvider delayDuration={400}>
                <div className={cn("og-root relative flex min-h-0 flex-col", className)}>
                  {/* Pinned: anchoring off so the tip-follow camera owns the motion.
          Unpinned: native scroll anchoring holds the reader's place. */}
                  <div
                    ref={scrollRef}
                    data-og-timeline-scroller=""
                    data-og-bottom-follow={autoFollow && pinned && !hasNewer ? "true" : "false"}
                    tabIndex={-1}
                    onScroll={onScroll}
                    onScrollEnd={onScrollEnd}
                    onWheel={onWheel}
                    onPointerDown={onPointerDown}
                    onKeyDown={onKeyDown}
                    style={groups.length > 0 && !revealed ? { visibility: "hidden" } : undefined}
                    className={cn(
                      // tabIndex=-1 is programmatic only — never paint a focus ring on
                      // the whole scroller (click + Shift used to flash a blue outline).
                      "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 outline-hidden",
                      autoFollow && pinned && !hasNewer
                        ? "[overflow-anchor:none]"
                        : "[overflow-anchor:auto]",
                    )}
                  >
                    <div className="relative mx-auto flex w-full max-w-3xl flex-col gap-5">
                      {groups.length === 0
                        ? (emptyState ?? (
                            <p className="py-10 text-center text-og-menu text-og-fg-subtle">
                              No activity yet.
                            </p>
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
                      {groups.map(({ group, key }, index) => {
                        const next = groups[index + 1]?.group;
                        const contextCompactionCount =
                          group.kind === "turn"
                            ? (group.contextCompactionCount ?? 0)
                            : group.kind === "activity" &&
                                next?.kind === "item" &&
                                next.item.kind === "context-compaction" &&
                                next.item.phase === "compacted"
                              ? 1
                              : 0;
                        return (
                          <div key={key} data-og-timeline-group-anchor="" data-og-group-key={key}>
                            <TimelineGroupRenderBoundary
                              resetKeys={[
                                group,
                                renderMessageText,
                                onOpenSession,
                                onMemoryClick,
                                onReconnect,
                                resolveProviderLogo,
                                toolRegistry,
                                loadRetainedScreenshot,
                                turnSummary,
                              ]}
                            >
                              <UserMessageDisclosureProvider value={userMessageDisclosureContext}>
                                <TimelineGroupView
                                  group={group}
                                  renderMessageText={renderMessageText}
                                  onOpenSession={onOpenSession}
                                  onMemoryClick={onMemoryClick}
                                  onReconnect={onReconnect}
                                  resolveProviderLogo={resolveProviderLogo}
                                  toolRegistry={toolRegistry}
                                  loadRetainedScreenshot={loadRetainedScreenshot}
                                  turnSummary={turnSummary}
                                  foldLiveCluster={isAgentProgress(next)}
                                  trailingAgentText={trailingAgentTextAfterTurn(group, next)}
                                  contextCompactionCount={
                                    contextCompactionCount > 0 ? contextCompactionCount : undefined
                                  }
                                />
                              </UserMessageDisclosureProvider>
                            </TimelineGroupRenderBoundary>
                          </div>
                        );
                      })}
                      {groups.length > 0 && trailingState ? (
                        <div data-og-timeline-trailing-state="">{trailingState}</div>
                      ) : null}
                      {hasNewer ? (
                        <div
                          ref={bottomSentinelRef}
                          data-og-bottom-sentinel=""
                          data-og-timeline-chrome=""
                          aria-hidden="true"
                          className="h-px w-full"
                        />
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
                          <span className="pointer-events-none inline-flex items-center rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1 text-og-control font-medium shadow-og-md backdrop-blur">
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
                              applyPinned(false);
                              pendingJumpToStartRef.current = true;
                              const seq = ++jumpToStartSeqRef.current;
                              const node = scrollRef.current;
                              void Promise.resolve(onJumpToStart()).then(
                                () => {
                                  // The commit that swaps in the oldest window consumes
                                  // the flag against the new DOM; this write covers the
                                  // already-committed order and the no-window-change
                                  // case (jumping within the current window).
                                  const scroller = scrollRef.current ?? node;
                                  if (scroller) {
                                    scroller.scrollTop = 0;
                                  }
                                  // A host may resolve without ever changing the
                                  // window (already on the oldest page). Any swap
                                  // commit runs its layout effect before the next
                                  // frame, so a flag still armed by then is the
                                  // no-change case — clear it, or a LATER prepend
                                  // would spuriously jump the reader to the top.
                                  requestFrame(() => {
                                    if (jumpToStartSeqRef.current === seq) {
                                      pendingJumpToStartRef.current = false;
                                    }
                                  });
                                },
                                () => {
                                  if (jumpToStartSeqRef.current === seq) {
                                    pendingJumpToStartRef.current = false;
                                  }
                                },
                              );
                            }}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1.5",
                              "text-og-control font-medium text-og-fg shadow-og-md backdrop-blur",
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
                        <span className="inline-flex items-center rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1 text-og-control font-medium shadow-og-md backdrop-blur">
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
                          disclosureKeepsUnpinnedRef.current = false;
                          if (hasNewer) {
                            // Do not pin against the current history page — its bottom
                            // is not the tip. The pin + snap run when the tip window
                            // actually lands (`hasNewer` flips false).
                            wantPinRef.current = true;
                            const node = scrollRef.current;
                            if (onJumpToLatest) {
                              void Promise.resolve(onJumpToLatest()).then(
                                () => {
                                  // Covers a host that flipped hasNewer before
                                  // resolving; otherwise the tip-window commit
                                  // consumes the flag.
                                  const current = scrollRef.current;
                                  if (current && wantPinRef.current && !hasNewerRef.current) {
                                    wantPinRef.current = false;
                                    applyPinned(true);
                                    snapToBottom(current);
                                  }
                                },
                                () => {
                                  // The tip reload failed (ordinary network error):
                                  // an armed latch would fire a surprise snap when
                                  // the reader later pages to the tip themselves.
                                  wantPinRef.current = false;
                                },
                              );
                            } else if (node) {
                              // No tip reload available: jump within the in-memory
                              // window so the newer sentinel can page forward; the
                              // latch pins if the tip window eventually lands.
                              snapToBottom(node);
                            }
                            return;
                          }
                          const node = scrollRef.current;
                          if (node) {
                            applyPinned(true);
                            snapToBottom(node);
                          }
                        }}
                        className={cn(
                          "absolute inset-x-0 bottom-4 mx-auto w-fit",
                          "inline-flex items-center gap-1.5 rounded-full border border-og-border bg-og-surface-3/90 px-3 py-1.5",
                          "text-og-control font-medium text-og-fg shadow-og-md backdrop-blur",
                          "hover:border-og-border-strong",
                        )}
                      >
                        <ArrowDownIcon className="size-3.5" />
                        Jump to latest
                      </motion.button>
                    ) : null}
                  </AnimatePresence>
                </div>
              </TooltipProvider>
            </EntranceAnimationProvider>
          </TimelineComputeLabelProvider>
        </SeenActivityIdsProvider>
      </FoldMemoryProvider>
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
        if (previous && previous.group.kind === group.kind && !usedKeys.has(previous.key)) {
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

type TimelineGroupRenderBoundaryProps = {
  children: ReactNode;
  resetKeys: readonly unknown[];
};

type TimelineGroupRenderBoundaryState = {
  failed: boolean;
  resetKeys: readonly unknown[];
};

function timelineRenderResetKeysChanged(
  previous: readonly unknown[],
  next: readonly unknown[],
): boolean {
  return (
    previous.length !== next.length || previous.some((key, index) => !Object.is(key, next[index]))
  );
}

/**
 * A malformed historical payload or consumer renderer must not take down the
 * entire conversation. Keep the boundary outside the row component so React
 * can replace an invalid element type (error #130) with a bounded fallback.
 */
class TimelineGroupRenderBoundary extends Component<
  TimelineGroupRenderBoundaryProps,
  TimelineGroupRenderBoundaryState
> {
  state: TimelineGroupRenderBoundaryState = {
    failed: false,
    resetKeys: this.props.resetKeys,
  };

  static getDerivedStateFromError(): Partial<TimelineGroupRenderBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: TimelineGroupRenderBoundaryProps,
    state: TimelineGroupRenderBoundaryState,
  ): Partial<TimelineGroupRenderBoundaryState> | null {
    if (timelineRenderResetKeysChanged(state.resetKeys, props.resetKeys)) {
      return { failed: false, resetKeys: props.resetKeys };
    }
    return null;
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div
          data-testid="timeline-group-render-error"
          role="status"
          className="flex items-start gap-2 rounded-lg border border-og-border bg-og-surface-muted px-3 py-2 text-og-menu text-og-fg-muted"
        >
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium text-og-fg">Timeline item unavailable</p>
            <p>
              This item could not be displayed. The rest of the conversation is still available.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
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
  loadRetainedScreenshot,
  turnSummary,
  insideTurn = false,
  nestClusterChips = false,
  foldLiveCluster = false,
  trailingAgentText,
  contextCompactionCount,
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
  loadRetainedScreenshot?: RetainedScreenshotLoader | undefined;
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
   * During outer settle chrome, nested chips stay force-open (structure kept,
   * height stable) instead of flat-mapping to bare rails.
   */
  nestClusterChips?: boolean;
  /**
   * Final agent answer extracted as a sibling after a settled turn — folded
   * into "Copy turn" so the chip copies the whole assistant reply, not only
   * mid-turn narration still inside the fold.
   */
  trailingAgentText?: string | undefined;
  /** Secondary chip facet when this fold sits next to a compaction landmark. */
  contextCompactionCount?: number | undefined;
}) {
  const enter = useEntranceAnimation();
  const settleChrome = useTurnSettleOpen();
  const foldMemory = useFoldMemory();
  // Settled (or live-fold) activity clusters get a chip. Inside an expanded
  // turn that is the second layer — quiet nested chips under the outer turn
  // summary when contiguous activity naturally clusters (≥2 only).
  const activityShouldFold =
    group.kind === "activity" &&
    Boolean(group.outcome || (foldLiveCluster && clusterIsSettled(group)));
  // Latch live→folded so a top-level shell that was already mounted open can
  // start the settle beat without remounting bare rail → wrapper.
  const liveActivitySettle = useLiveSettleFold(activityShouldFold && !insideTurn);
  const turnDefaultOpen =
    !insideTurn &&
    group.kind === "turn" &&
    (group.outcome === "failed" || timelineGroupContainsAuthNeeded(group));
  // activity-* → turn-* remount: carry resting state so settleFold does not
  // re-open a chip the reader already watched collapse.
  if (group.kind === "turn" && foldMemory && !insideTurn) {
    inheritFoldRestingState(
      foldMemory,
      group.id,
      group.groups.flatMap((child) => (child.kind === "activity" ? [child.id] : [])),
    );
  }
  const settleFold =
    group.kind === "turn" ? Boolean(enter && !insideTurn && !turnDefaultOpen) : liveActivitySettle;
  switch (group.kind) {
    case "activity":
      if (insideTurn) {
        // Nested chips whenever the parent has ≥2 clusters. During outer settle
        // chrome they stay force-open so structure is visible and height stays
        // stable through collapse — never flat-map to bare rails (that flash
        // was the "inner steps vanish then reappear nested" bug). Key flips
        // when chrome clears so they remount closed inside the already-hidden
        // parent (safe; mid-collapse remount of closed chips was the snap).
        // foldKey memory overrides the force-open: a cluster that already
        // settled closed pre-wrap was showing as a CHIP, so mounting it closed
        // is both the stable height and the honest state — force-opening it
        // was the "already-collapsed cluster auto-expands at the end" reopen.
        const useNestedChip = nestClusterChips && activityShouldFold;
        if (!useNestedChip) {
          return (
            <ActivityRail
              items={group.items}
              onOpenSession={onOpenSession}
              onMemoryClick={onMemoryClick}
              toolRegistry={toolRegistry}
              loadRetainedScreenshot={loadRetainedScreenshot}
              bare
            />
          );
        }
        return (
          <TurnSummary
            key={settleChrome ? "settle" : "rest"}
            items={group.items}
            outcome={group.outcome}
            failureText={undefined}
            bare
            defaultOpen={settleChrome ? true : undefined}
            foldKey={group.id}
            facets={turnSummary?.facets}
            contextCompactionCount={contextCompactionCount}
          >
            <ActivityRail
              items={group.items}
              onOpenSession={onOpenSession}
              onMemoryClick={onMemoryClick}
              toolRegistry={toolRegistry}
              loadRetainedScreenshot={loadRetainedScreenshot}
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
          defaultOpen={!activityShouldFold || group.outcome === "failed" ? true : undefined}
          foldKey={group.id}
          facets={turnSummary?.facets}
          settleFold={settleFold}
          contextCompactionCount={contextCompactionCount}
        >
          <FoldBody>
            <TurnRailFrame>
              <ActivityRail
                items={group.items}
                onOpenSession={onOpenSession}
                onMemoryClick={onMemoryClick}
                toolRegistry={toolRegistry}
                loadRetainedScreenshot={loadRetainedScreenshot}
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
      const body = group.groups.map((child) => {
        const key = timelineGroupKey(child);
        return (
          <TimelineGroupRenderBoundary
            key={key}
            resetKeys={[
              child,
              renderMessageText,
              onOpenSession,
              onMemoryClick,
              onReconnect,
              resolveProviderLogo,
              toolRegistry,
              loadRetainedScreenshot,
              turnSummary,
            ]}
          >
            <TimelineGroupView
              group={child}
              renderMessageText={renderMessageText}
              onOpenSession={onOpenSession}
              onMemoryClick={onMemoryClick}
              onReconnect={onReconnect}
              resolveProviderLogo={resolveProviderLogo}
              toolRegistry={toolRegistry}
              loadRetainedScreenshot={loadRetainedScreenshot}
              turnSummary={turnSummary}
              insideTurn
              nestClusterChips={nestClusters}
            />
          </TimelineGroupRenderBoundary>
        );
      });
      return (
        <TurnSummary
          items={activityItems}
          outcome={group.outcome}
          failureText={insideTurn ? undefined : group.failureText}
          durationMs={durationBetween(group.startedAt, group.endedAt)}
          defaultOpen={turnDefaultOpen ? true : undefined}
          bare={insideTurn}
          foldKey={group.id}
          facets={turnSummary?.facets}
          settleFold={settleFold}
          copyText={insideTurn ? undefined : turnCopyText}
          contextCompactionCount={contextCompactionCount ?? group.contextCompactionCount}
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
 * Body under a turn/activity chip. Remount flashes are gated by the timeline
 * seen-activity-id map (not by killing entrance): FoldBody used to force
 * entrance off, which made every live tool pop with no fade.
 */
function FoldBody({ children }: { children: ReactNode }) {
  return <>{children}</>;
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

function timelineGroupContainsAuthNeeded(group: TimelineGroup): boolean {
  switch (group.kind) {
    case "item":
      return group.item.kind === "auth-needed";
    case "activity":
      return false;
    case "turn":
      return group.groups.some(timelineGroupContainsAuthNeeded);
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

/** Non-null turnIds projected into a turn body (activity + nested messages). */
function collectTurnIdsFromGroups(groups: readonly TimelineGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    if (group.kind === "item") {
      const turnId = "turnId" in group.item ? group.item.turnId : null;
      if (typeof turnId === "string" && turnId.length > 0) {
        ids.add(turnId);
      }
    } else if (group.kind === "activity") {
      for (const item of group.items) {
        if (item.turnId) {
          ids.add(item.turnId);
        }
      }
    } else if (group.kind === "turn") {
      for (const nested of collectTurnIdsFromGroups(group.groups)) {
        ids.add(nested);
      }
    }
  }
  return ids;
}

/**
 * Settled turns lift the final agent answer out as a sibling group. Include it
 * in "Copy turn" when present so the chip copies the full assistant reply.
 * Fenced by turnId so the next turn's answer is never stolen.
 */
export function trailingAgentTextAfterTurn(
  group: TimelineGroup,
  next: TimelineGroup | undefined,
): string | undefined {
  if (group.kind !== "turn") {
    return undefined;
  }
  if (next?.kind === "item" && next.item.kind === "agent-message") {
    const turnIds = collectTurnIdsFromGroups(group.groups);
    // Degenerate body with no turnIds: do not guess — safer than lifting wrong.
    if (turnIds.size === 0) {
      return undefined;
    }
    if (!next.item.turnId || !turnIds.has(next.item.turnId)) {
      return undefined;
    }
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
    case "context-compaction":
      return <CompactionRow item={item} />;
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

const COMPACTION_TRIGGER_LABEL: Record<NonNullable<ContextCompactionItem["trigger"]>, string> = {
  auto: "Auto",
  operator: "Manual",
  proactive: "Auto",
  overflow: "Overflow",
};

function CompactionRow({ item }: { item: ContextCompactionItem }) {
  const enter = useEntranceAnimation();
  const trigger =
    item.trigger && item.phase !== "started" ? COMPACTION_TRIGGER_LABEL[item.trigger] : null;
  const before =
    item.estimatedTokensBefore !== null
      ? Math.round(item.estimatedTokensBefore).toLocaleString("en-US")
      : null;
  const after =
    item.estimatedTokensAfter !== null
      ? Math.round(item.estimatedTokensAfter).toLocaleString("en-US")
      : null;
  const title =
    item.phase === "started"
      ? "Compacting conversation history…"
      : item.phase === "compacted"
        ? before && after
          ? `Conversation history compacted · ~${before} → ~${after} estimated history tokens`
          : "Conversation history compacted"
        : "Couldn’t compact conversation history";
  const subtitle =
    item.phase === "compacted"
      ? "Chat history above is unchanged"
      : item.phase === "skipped"
        ? compactionSkipSubtitle(item.skipReason)
        : null;
  const pill =
    item.phase === "skipped" && item.skipReason === "summarization_failed"
      ? "border-og-status-failed/35 bg-og-status-failed/10 text-og-status-failed"
      : item.phase === "started"
        ? "border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting"
        : "border-og-border bg-og-surface-1 text-og-fg-muted";
  return (
    <div className={cn(enter && "animate-og-enter", "flex justify-center")}>
      <div
        className={cn(
          "inline-flex max-w-full flex-col items-center gap-0.5 rounded-full border px-3 py-1.5 text-og-sm",
          pill,
        )}
        role="status"
      >
        <span className="inline-flex max-w-full items-center gap-1.5">
          <ShrinkIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {title}
            {trigger ? ` · ${trigger}` : ""}
          </span>
        </span>
        {subtitle ? <span className="truncate text-og-xs opacity-80">{subtitle}</span> : null}
      </div>
    </div>
  );
}

function compactionSkipSubtitle(reason: string | null): string {
  switch (reason) {
    case "no_history":
      return "No active history to compact";
    case "replacement_not_smaller":
      return "Checkpoint would not reduce memory size";
    case "replacement_unchanged":
      return "Checkpoint made no progress";
    case "summarization_failed":
      return "Request it again to retry. Chat history is unchanged.";
    default:
      return "Compaction was not needed. Chat history is unchanged.";
  }
}

/** Hover-reveal clock beside the copy control (sent / finished). */
function MessageFooterTime({ occurredAt }: { occurredAt: string }) {
  return (
    <time
      dateTime={occurredAt}
      className={cn(
        "shrink-0 tabular-nums text-og-xs text-og-fg-subtle",
        "opacity-0 transition-opacity duration-150",
        "group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      {formatClockTime(occurredAt)}
    </time>
  );
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
          trailing={<MessageFooterTime occurredAt={item.occurredAt} />}
        >
          <div className="w-fit max-w-full min-w-0 rounded-og-lg rounded-br-og-xs border border-og-border bg-og-surface-2 px-4 py-2.5 text-og-md leading-6 text-og-fg">
            {renderMessageText ? (
              renderMessageText(item.text, item)
            ) : (
              <UserMessageBody messageId={item.id} text={item.text}>
                <Markdown>{item.text}</Markdown>
              </UserMessageBody>
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
  // and snapped on exit. Live text carries the stream via tip ink.
  const body = renderMessageText ? (
    renderMessageText(item.text, item)
  ) : (
    <Markdown streaming={item.streaming}>{item.text}</Markdown>
  );
  // While streaming, copy is still useful (current text) but keep chrome calm —
  // stamp only after the message finishes (occurredAt tracks completion).
  return (
    <CopyHoverFrame
      copyText={item.text}
      label="Copy message"
      align="start"
      className={cn(enter && "animate-og-enter", "min-w-0 text-og-md leading-7 text-og-fg")}
      trailing={item.streaming ? null : <MessageFooterTime occurredAt={item.occurredAt} />}
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
                "outline-hidden transition-colors duration-150 hover:bg-og-surface-2 hover:text-og-fg",
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
                  "outline-hidden transition-colors duration-150 hover:text-og-fg-muted focus-visible:ring-2 focus-visible:ring-og-accent",
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

function MachineInputBatchRow({ item }: { item: MachineInputBatchItem }) {
  const enter = useEntranceAnimation();
  const label = machineInputBatchLabel(item.members);
  const single = item.members.length === 1 ? item.members[0]! : null;
  const singleSummary = single ? cleanMachineInputSummary(single.summary) : "";
  const showCollapsedSummary =
    single != null && machineInputSummaryIsUseful(single.kind, singleSummary);

  return (
    <div className={cn(enter && "animate-og-enter", "flex flex-col items-center gap-1.5")}>
      <details className="group w-full max-w-full" data-og-machine-input-batch="">
        <summary className="flex cursor-pointer list-none justify-center [&::-webkit-details-marker]:hidden">
          <span
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-og-sm",
              NEUTRAL_PILL,
            )}
          >
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            />
            <span className="truncate">{label}</span>
          </span>
        </summary>
        <div className="mx-auto mt-2 w-full max-w-lg space-y-2 border-t border-og-border/50 pt-2">
          {item.members.map((member) => (
            <MachineInputRow key={member.id} member={member} />
          ))}
        </div>
      </details>
      {showCollapsedSummary ? (
        <p className="max-w-lg px-3 text-center text-og-xs leading-4 text-og-fg-subtle">
          {truncate(singleSummary, 160)}
        </p>
      ) : null}
    </div>
  );
}

function MachineInputRow({ member }: { member: MachineInputBatchItem["members"][number] }) {
  const source = readableMachineInputSource(member.sourceId);
  const summary = cleanMachineInputSummary(member.summary);
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-og-fg-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="text-og-control font-medium text-og-fg-muted">
          {MACHINE_INPUT_META[member.kind]}
        </span>
        {source && <span className="ml-1.5 text-og-control text-og-fg-subtle">from {source}</span>}
        {summary ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-og-menu leading-5 text-og-fg">
            {truncate(summary, 320)}
          </p>
        ) : null}
      </div>
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
        "flex items-start gap-2.5 rounded-og-md border px-3.5 py-2.5 text-og-menu",
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
          <details className="mt-2 text-og-control">
            <summary className="cursor-pointer font-medium">{item.details.label}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-og-sm bg-black/5 p-2 font-mono dark:bg-white/5">
              {JSON.stringify(item.details.value, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
      {item.action ? (
        <a
          className="shrink-0 rounded-og-sm border border-current/25 px-2 py-1 text-og-control font-medium hover:bg-current/10"
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
  const provider =
    item.serverId === "codex_apps" ? "Codex Apps" : providerLabel(item.providerDomain);
  const unavailable =
    item.reason === "personal_authority_unavailable" ||
    item.reason === "unsupported_auth" ||
    item.reason === "resource_scope_unavailable";
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
              "inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-og-md bg-og-accent px-3 py-1.5 text-og-menu font-medium text-og-accent-fg sm:w-auto",
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
              "inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-og-md bg-og-accent px-3 py-1.5 text-og-menu font-medium text-og-accent-fg sm:w-auto",
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
      className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-og-md border border-og-border bg-og-surface-2 text-og-menu font-semibold text-og-fg-muted"
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
    case "personal_authority_unavailable":
      return "This automation was not granted access to your personal connection.";
    case "unsupported_auth":
      return "This connection cannot authenticate the configured tool endpoint.";
    case "resource_scope_unavailable":
      return "This tool endpoint cannot enforce the selected repository access.";
    default:
      return "Its connection needs attention.";
  }
}
