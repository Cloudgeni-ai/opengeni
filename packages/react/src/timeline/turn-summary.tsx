import { ChevronRightIcon, CircleSlashIcon, TriangleAlertIcon } from "lucide-react";
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Collapsible } from "radix-ui";
import { CopyButton } from "../components/copy-button";
import { cn } from "../lib/cn";
import { MOTION_INSPECT_SCALE } from "../lib/motion-inspect";
import { useForcedDefaultOpen } from "./disclosure-context";
import { useEntranceAnimation } from "./entrance";
import { useFoldMemory, type FoldRestingState } from "./fold-memory";
import { applyPatchOps, isApplyPatch, mediaPreviewFact, screenshotDataUrl } from "./parsers";
import { rawTypeOf } from "./registry";
import type { ActivityItem, ToolCallItem, TurnOutcome } from "./types";
export type { TurnOutcome } from "./types";

/* ----------------------------------------------------------------------------
   Turn summary

   A completed (or failed/cancelled) turn folds behind one quiet summary chip:
   "N steps · M files · K commands · 1 screenshot · 4m". The chip is the default
   surface; expanding it reveals the full settled turn body. Top-level live
   activity keeps the same open shell so settling never remounts the rail into
   a brand-new wrapper (that remount was the hard yank).

   This keeps the timeline calm: a finished turn is a single line until the
   reader chooses to look inside it.
   -------------------------------------------------------------------------- */

const TurnSettleChromeContext = createContext(false);

/**
 * True while settle chrome is active (open beat, slow collapse, or the short
 * cancel-close latch). Nested cluster chips stay mounted and forced OPEN for
 * this window so the body keeps a stable height — never flat-map to bare
 * rails, and never remount closed nested chips mid-collapse (that yanked).
 */
export function useTurnSettleOpen(): boolean {
  return useContext(TurnSettleChromeContext);
}

export const BUILT_IN_TURN_SUMMARY_FACET_IDS = [
  "steps",
  "files",
  "commands",
  "screenshots",
  "memories",
  "compacted",
  "duration",
] as const;

export type BuiltInTurnSummaryFacetId = (typeof BUILT_IN_TURN_SUMMARY_FACET_IDS)[number];

export type TurnSummaryContext = Readonly<{
  /** Every normalized activity item folded into this summary. */
  items: readonly ActivityItem[];
  /** Tool calls from `items`, retained in timeline order for convenient aggregation. */
  toolCalls: readonly ToolCallItem[];
  /** The settled turn verdict, or absent for a neutral/incomplete cluster. */
  outcome: TurnOutcome | undefined;
  /** The bounded failure reason rendered by the enclosing summary, when present. */
  failureText: string | undefined;
  /** Total turn duration when the enclosing group has both valid timestamps. */
  durationMs: number | undefined;
  /** False when any projected activity is still running or streaming. */
  settled: boolean;
  /**
   * Adjacent compaction landmarks next to this fold. Landmark remains the
   * primary UI; this is a secondary chip signal only.
   */
  contextCompactionCount: number;
}>;

export type TurnSummaryFacetResult = Readonly<{
  icon?: ReactNode;
  content: ReactNode;
  ariaLabel?: string;
  title?: string;
}>;

export type TurnSummaryFacet = Readonly<{
  /** Stable identity used for removal and deterministic de-duplication. */
  id: string;
  /** Return null when this facet has nothing useful to show. */
  summarize(context: TurnSummaryContext): TurnSummaryFacetResult | null;
}>;

type ModifyTurnSummaryFacets = Readonly<{
  /** Appended after the remaining built-ins, in supplied order. */
  add?: readonly TurnSummaryFacet[];
  /** Built-ins to omit before custom facets are appended. */
  remove?: readonly BuiltInTurnSummaryFacetId[];
  replace?: never;
}>;

type ReplaceTurnSummaryFacets = Readonly<{
  /** The complete ordered facet list. Mutually exclusive with add/remove. */
  replace: readonly TurnSummaryFacet[];
  add?: never;
  remove?: never;
}>;

export type TurnSummaryFacetConfiguration = ModifyTurnSummaryFacets | ReplaceTurnSummaryFacets;

export type TurnSummaryOptions = Readonly<{
  facets?: TurnSummaryFacetConfiguration;
}>;

export type TurnSummaryProps = {
  /** The activity items in the turn (used only to compute the facet counts). */
  items: ActivityItem[];
  /**
   * The settled verdict — or absent for a completed CLUSTER of a still-running
   * turn, which folds neutrally: no verdict glyph (the turn has none yet), a
   * quiet pulse dot in its place so alignment and the running feel both hold.
   */
  outcome?: TurnOutcome | undefined;
  /** A short failure reason shown inline on a failed chip (never hidden). */
  failureText?: string | undefined;
  /** Elapsed turn duration; shown as a trailing facet when at least 1s. */
  durationMs?: number | undefined;
  /** Start expanded. */
  defaultOpen?: boolean | undefined;
  /**
   * A nested fold — a cluster or sub-turn INSIDE an already-expanded turn. It
   * drops the bordered/filled chip and renders as a plain disclosure node on the
   * parent's rail (chevron + glyph + facets), so expanding a turn reveals a thread
   * of nodes, never a stack of boxes-in-boxes. The top-level fold stays a chip.
   */
  bare?: boolean | undefined;
  /** Per-instance facet customization. Omit to preserve the built-in summary exactly. */
  facets?: TurnSummaryFacetConfiguration | undefined;
  /**
   * Settle choreography: this fold replaced rows the reader was just watching
   * live. Instead of yanking them behind a chip in one frame, the fold mounts
   * OPEN with the summary chip easing in above the still-visible rows, holds a
   * short beat so the reader registers the settle, then glides closed. Any
   * user interaction during the beat cancels the auto-collapse. Captured at
   * mount; ignored when the fold starts expanded (e.g. a failed turn).
   */
  settleFold?: boolean | undefined;
  /**
   * Durable identity (timeline group id) for cross-remount fold memory. When
   * an ancestor provides a {@link FoldMemoryProvider} map, reaching a resting
   * state is recorded under this key: "closed" when the settle choreography
   * completes its collapse or the reader closes the chip, "open" when the
   * reader expands it. A later remount under the same key restores that
   * resting state and never replays the open settle beat — the activity→turn
   * wrap and the nested force-open during settle chrome must not re-expand a
   * fold that already settled closed.
   */
  foldKey?: string | undefined;
  /**
   * When set, a hover/focus copy control sits on the chip row (outside the
   * disclosure trigger) so the reader can copy the turn's assistant prose
   * without toggling the fold.
   */
  copyText?: string | undefined;
  /** Adjacent compaction landmark count for the secondary chip facet. */
  contextCompactionCount?: number | undefined;
  /** The rendered activity rail revealed on expand. */
  children: ReactNode;
};

/** How long a settling fold stays open before gliding closed. */
const SETTLE_FOLD_BEAT_MS = 1100 * MOTION_INSPECT_SCALE;
/** Keep in sync with `--og-duration-disclose-settle`. */
const SETTLE_COLLAPSE_MS = 820 * MOTION_INSPECT_SCALE;
/** Keep in sync with `--og-duration-disclose` (manual / cancel-close). */
const DISCLOSE_MS = 120 * MOTION_INSPECT_SCALE;

export function TurnSummary({
  items,
  outcome,
  failureText,
  durationMs,
  defaultOpen,
  bare,
  facets: facetConfiguration,
  settleFold,
  foldKey,
  copyText,
  contextCompactionCount,
  children,
}: TurnSummaryProps) {
  // An explicit `defaultOpen` always wins; otherwise an ancestor may seed it
  // (screenshot instrumentation); otherwise the turn starts folded.
  const forcedDefaultOpen = useForcedDefaultOpen();
  const foldMemory = useFoldMemory();
  // A remembered resting state outranks author defaults: a fold that already
  // finished its settle collapse (or that the reader closed) mounts closed
  // even when a remount asks for the settle beat or a forced defaultOpen —
  // and one the reader expanded mounts open instead of snapping shut.
  const remembered = foldKey !== undefined ? foldMemory?.get(foldKey) : undefined;
  const restingOpen =
    remembered === "closed"
      ? false
      : remembered === "open"
        ? true
        : (defaultOpen ?? forcedDefaultOpen ?? false);
  const initialSettle = Boolean(settleFold) && !restingOpen && remembered === undefined;
  const [settling, setSettling] = useState(initialSettle);
  const [open, setOpen] = useState(initialSettle ? true : restingOpen);
  // While true, a close uses the slow settle collapse. Cleared after that
  // auto-collapse finishes (or on first user interaction) so later manual
  // closes are the fast disclose pair.
  const [settlePhase, setSettlePhase] = useState(initialSettle);
  // Separate from settlePhase CSS: keep nested chips force-open through
  // cancel-close (fast collapse) without forcing the slow settle-collapse.
  const [nestSuppressLatch, setNestSuppressLatch] = useState(initialSettle);
  // Expand animation must NOT run on the settle mount (rows were already
  // visible — a height sweep would flash them). Armed once we leave that
  // initial open, so a later manual reopen animates instead of snapping.
  const [expandReady, setExpandReady] = useState(!initialSettle);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleCloseDoneRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nestLatchClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleFoldSeenRef = useRef(Boolean(settleFold));
  const settleArmedRef = useRef(false);
  const clearNestLatchTimer = () => {
    if (nestLatchClearRef.current !== null) {
      clearTimeout(nestLatchClearRef.current);
      nestLatchClearRef.current = null;
    }
  };
  const clearSettleTimers = () => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (settleCloseDoneRef.current !== null) {
      clearTimeout(settleCloseDoneRef.current);
      settleCloseDoneRef.current = null;
    }
    clearNestLatchTimer();
  };
  const rememberResting = (state: FoldRestingState) => {
    if (foldKey !== undefined && foldMemory) {
      foldMemory.set(foldKey, state);
    }
  };
  const armSettleCollapse = () => {
    if (settleArmedRef.current) {
      return;
    }
    settleArmedRef.current = true;
    setSettling(true);
    setSettlePhase(true);
    setNestSuppressLatch(true);
    setExpandReady(false);
    setOpen(true);
    clearSettleTimers();
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setExpandReady(true);
      setOpen(false);
      // The glide toward closed IS the choreography completing — record it
      // now, so a wrap that lands mid-collapse still remounts this fold shut.
      rememberResting("closed");
      settleCloseDoneRef.current = setTimeout(() => {
        settleCloseDoneRef.current = null;
        settleArmedRef.current = false;
        setSettlePhase(false);
        setSettling(false);
        setNestSuppressLatch(false);
      }, SETTLE_COLLAPSE_MS);
    }, SETTLE_FOLD_BEAT_MS);
  };
  const mountSettleRef = useRef(initialSettle);
  // Mount-time settle (new turn wrap).
  // Mount-once settle arm + unmount timer cleanup — re-running on foldMemory
  // identity churn would restart the beat mid-choreography.
  useEffect(() => {
    if (mountSettleRef.current) {
      armSettleCollapse();
    }
    return () => {
      clearSettleTimers();
      settleArmedRef.current = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Live shell already open: settleFold rises later without remounting.
  // Do not require !restingOpen — live shells mount with defaultOpen and
  // only later receive settleFold. Failed turns mount with both at once
  // (seen=true), so they never take this edge.
  // Edge-trigger on settleFold only; foldMemory/foldKey are reopen guards.
  useEffect(() => {
    const was = settleFoldSeenRef.current;
    settleFoldSeenRef.current = Boolean(settleFold);
    if (!was && settleFold) {
      // A remembered resting state means this fold's story already resolved
      // once (choreography closed it, or the reader chose a state). Replaying
      // the open beat would re-expand it — the exact reopen this guards.
      if (foldKey !== undefined && foldMemory?.get(foldKey) !== undefined) {
        return;
      }
      armSettleCollapse();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settleFold]);
  const onOpenChange = (next: boolean) => {
    // The reader took over — cancel the pending auto-collapse for good.
    // Clear settle CSS phase immediately (fast collapse) but keep nest latch
    // through the disclose window so nested chips stay force-open mid-close
    // (remounting them closed here yanks height).
    const wasNestFlat = settling || settlePhase || nestSuppressLatch;
    clearSettleTimers();
    settleArmedRef.current = false;
    rememberResting(next ? "open" : "closed");
    setExpandReady(true);
    setSettlePhase(false);
    setSettling(false);
    if (next) {
      setNestSuppressLatch(false);
      setOpen(true);
      return;
    }
    setOpen(false);
    if (wasNestFlat) {
      setNestSuppressLatch(true);
      nestLatchClearRef.current = setTimeout(() => {
        nestLatchClearRef.current = null;
        setNestSuppressLatch(false);
      }, DISCLOSE_MS);
    } else {
      setNestSuppressLatch(false);
    }
  };
  const enter = useEntranceAnimation();
  // Capture once: after a settle choreography the chip is already on screen.
  // Re-applying `animate-og-enter` when `settling` clears was the post-collapse
  // flash (opacity replay on the summary row).
  const [allowEnterAnimation] = useState(() =>
    Boolean(enter && !bare && !initialSettle && !restingOpen),
  );
  // Hold duration (and its "· 8s" insertion) until settle choreography finishes.
  // Surfacing it mid-beat or on the activity→turn remount made the chip text
  // reflow twice and read as another flash after the fold.
  const context = useMemo(
    () =>
      createTurnSummaryContext(
        items,
        outcome,
        failureText,
        settling || settlePhase ? undefined : durationMs,
        contextCompactionCount ?? 0,
      ),
    [items, outcome, failureText, durationMs, settling, settlePhase, contextCompactionCount],
  );
  const facetDefinitions = useMemo(
    () => resolveTurnSummaryFacets(facetConfiguration),
    [facetConfiguration],
  );
  const facets = useMemo(
    () =>
      facetDefinitions.flatMap((facet) => {
        try {
          const result = facet.summarize(context);
          return result && hasFacetContent(result.content) ? [{ facet, result }] : [];
        } catch {
          // A host extension is presentation-only. It must never take down the
          // durable timeline or hide the remaining built-in evidence.
          return [];
        }
      }),
    [context, facetDefinitions],
  );

  // Live open shell: keep the chip in-flow (so settle never inserts layout)
  // but quiet it until there is an outcome or a settle beat.
  const liveShell = outcome === undefined && open && !settlePhase && !bare;
  // Settle CSS phase OR cancel-close latch — see useTurnSettleOpen.
  // Nested chips stay force-open for this window (stable height).
  const settleChrome = settling || settlePhase || nestSuppressLatch;

  // Copy only on the collapsed chip — when open, per-message copy is enough
  // and a second control on the summary row felt crowded / off.
  const copyable = Boolean(
    copyText && copyText.trim().length > 0 && !bare && !liveShell && !open && !settlePhase,
  );

  return (
    <TurnSettleChromeContext.Provider value={settleChrome}>
      <div className={cn(copyable && "group/copy relative")}>
        <Collapsible.Root
          open={open}
          onOpenChange={onOpenChange}
          // History-only entrance. Never toggle this on after mount — see
          // allowEnterAnimation. Settle uses animate-og-settle-chip on the trigger.
          className={allowEnterAnimation && !liveShell ? "animate-og-enter" : undefined}
        >
          <Collapsible.Trigger
            className={cn(
              settling && "animate-og-settle-chip",
              // Top-level turn fold and (when used) nested cluster folds render as
              // FLAT rail rows — chevron + glyph + facets on the page background, no
              // border, no fill. Only a hover tint hints the row is expandable, so a
              // collapsed turn never reads as a boxed card. The top-level row is a
              // touch larger (base text, size-5 glyph, wider gap) so it still reads
              // as a turn landmark above any nested cluster rows it groups.
              "group flex w-full items-center rounded-og-sm text-left transition-colors",
              // A folded turn is a touch target on coarse pointers: grow the row so it
              // clears the 40px minimum without disturbing the calm desktop rhythm.
              "pointer-coarse:py-2.5",
              bare
                ? "gap-2 px-1.5 py-1.5 text-og-sm text-og-fg-muted"
                : "-mx-2 gap-2.5 px-2 py-1.5 text-og-base text-og-fg-muted",
              // A failed fold keeps its red accent (glyph + inline reason below) and a
              // faint red hover wash so attention still lands there; every other
              // outcome gets the neutral surface hover.
              outcome === "failed"
                ? "hover:bg-og-status-failed/[0.06] hover:text-og-fg"
                : "hover:bg-og-surface-1 hover:text-og-fg",
              liveShell && "pointer-events-none text-og-fg-subtle",
            )}
          >
            {/* Disclosure grammar matches the rows: chevron leads (far left), then any
            exceptional or active state, then the facets — one expand affordance
            side everywhere. */}
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-og-fg-subtle transition-transform ease-og-in-out group-data-[state=open]:rotate-90",
                settlePhase
                  ? "duration-[var(--og-duration-disclose-settle)]"
                  : "duration-[var(--og-duration-disclose)]",
              )}
            />
            {/* Completion is the quiet default and needs no repeated glyph. Failed,
            cancelled, and still-running folds retain a visible state marker. */}
            {outcome === "complete" ? null : (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center justify-center",
                  bare ? "size-3.5" : "size-5",
                  outcome === "failed" ? "text-og-status-failed" : "text-og-fg-subtle",
                )}
              >
                {outcome === "failed" ? (
                  <TriangleAlertIcon className="size-3" />
                ) : outcome === "cancelled" ? (
                  <CircleSlashIcon className="size-3" />
                ) : (
                  <span className="size-1.5 animate-og-pulse rounded-full bg-og-fg-subtle" />
                )}
              </span>
            )}
            <span
              className={cn("min-w-0 flex-1 truncate", bare ? "text-og-sm" : "text-og-fg-muted")}
            >
              {facets.map(({ facet, result }, index) => (
                <FacetRenderBoundary key={facet.id}>
                  <>
                    {index > 0 ? " · " : null}
                    <span aria-label={result.ariaLabel} title={result.title}>
                      {result.icon ? (
                        <span aria-hidden className="mr-1 inline-flex align-[-0.125em]">
                          {result.icon}
                        </span>
                      ) : null}
                      {result.content}
                    </span>
                  </>
                </FacetRenderBoundary>
              ))}
              {outcome === "failed" && failureText ? (
                <span className="text-og-status-failed"> · {failureText}</span>
              ) : null}
              {outcome === "cancelled" ? (
                <span className="text-og-fg-subtle"> · interrupted</span>
              ) : null}
            </span>
            {/* The disclosure hint. Calm at rest on fine pointers (revealed on hover
            and keyboard focus), but always present on coarse pointers where there
            is no hover to lean on — so the fold never reads as a static status
            line. Purely visual: the trigger's aria-expanded already conveys state
            to assistive tech, so the hint is hidden from the accessible name. */}
            <span
              aria-hidden
              className={cn(
                "ml-auto shrink-0 pl-2 text-og-xs text-og-fg-subtle transition-opacity duration-150",
                // Leave a sliver so a collapsed-chip copy icon can sit outside.
                copyable ? "pr-8" : null,
                "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                "pointer-coarse:opacity-100",
              )}
            >
              {open ? "hide steps" : "show steps"}
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content
            {...(nestSuppressLatch ? { forceMount: true as const } : {})}
            data-og-fold-content=""
            className={cn(
              "overflow-hidden",
              expandReady && "data-[state=open]:animate-og-expand",
              // Auto-close: slow settle. Manual close (settlePhase cleared): fast.
              settlePhase
                ? "data-[state=closed]:animate-og-settle-collapse"
                : "data-[state=closed]:animate-og-collapse",
            )}
          >
            {/* A nested node indents its revealed rows under the glyph (thread nesting
            off the parent rail); the top-level turn body owns its own rail. */}
            <div className={bare ? "pt-1 pl-5" : "pt-2"}>{children}</div>
          </Collapsible.Content>
        </Collapsible.Root>
        {copyable ? (
          <div className="pointer-events-none absolute top-1.5 right-0 z-10">
            <div className="pointer-events-auto">
              <CopyButton text={copyText!} label="Copy turn" reveal="group-hover" />
            </div>
          </div>
        ) : null}
      </div>
    </TurnSettleChromeContext.Provider>
  );
}

function createTurnSummaryContext(
  items: ActivityItem[],
  outcome: TurnOutcome | undefined,
  failureText: string | undefined,
  durationMs: number | undefined,
  contextCompactionCount: number,
): TurnSummaryContext {
  const itemSnapshot = Object.freeze([...items]);
  const toolCalls = Object.freeze(
    itemSnapshot.filter((item): item is ToolCallItem => item.kind === "tool-call"),
  );
  const settled = itemSnapshot.every((item) => {
    if (item.kind === "reasoning") {
      return !item.streaming;
    }
    if (item.kind === "tool-call" || item.kind === "worker" || item.kind === "sandbox") {
      return item.status !== "running";
    }
    return true;
  });
  return Object.freeze({
    items: itemSnapshot,
    toolCalls,
    outcome,
    failureText,
    durationMs,
    settled,
    contextCompactionCount: Math.max(0, Math.floor(contextCompactionCount)),
  });
}

const BUILT_IN_TURN_SUMMARY_FACETS: readonly TurnSummaryFacet[] = Object.freeze([
  {
    id: "steps",
    summarize: ({ items }) => ({
      content: `${items.length} ${items.length === 1 ? "step" : "steps"}`,
    }),
  },
  {
    id: "files",
    summarize: ({ toolCalls }) => {
      let files = 0;
      for (const item of toolCalls) {
        if (isApplyPatch(item)) {
          files += applyPatchOps(item.raw).length;
        }
      }
      return files ? { content: `${files} ${files === 1 ? "file" : "files"} edited` } : null;
    },
  },
  {
    id: "commands",
    summarize: ({ toolCalls }) => {
      const commands = toolCalls.filter((item) => item.name === "exec_command").length;
      return commands
        ? { content: `${commands} ${commands === 1 ? "command" : "commands"}` }
        : null;
    },
  },
  {
    id: "screenshots",
    summarize: ({ toolCalls }) => {
      let screenshots = 0;
      for (const item of toolCalls) {
        if (
          (rawTypeOf(item) === "computer_call" ||
            item.name === "computer_call" ||
            item.name === "computer_screenshot") &&
          (screenshotDataUrl(item.output) !== null || mediaPreviewFact(item.output) !== null)
        ) {
          screenshots += 1;
        }
      }
      return screenshots
        ? {
            content: `${screenshots} ${screenshots === 1 ? "screenshot" : "screenshots"}`,
          }
        : null;
    },
  },
  {
    id: "memories",
    summarize: ({ items }) => {
      let saved = 0;
      let updated = 0;
      for (const item of items) {
        if (item.kind !== "memory") {
          continue;
        }
        if (item.variant === "corrected") {
          updated += 1;
        } else {
          saved += 1;
        }
      }
      const parts: string[] = [];
      if (saved) {
        parts.push(`${saved} ${saved === 1 ? "memory" : "memories"} saved`);
      }
      if (updated) {
        parts.push(`${updated} ${updated === 1 ? "memory" : "memories"} updated`);
      }
      return parts.length > 0 ? { content: parts.join(" · ") } : null;
    },
  },
  {
    id: "compacted",
    summarize: ({ contextCompactionCount }) =>
      contextCompactionCount > 0
        ? {
            content:
              contextCompactionCount === 1 ? "compacted" : `${contextCompactionCount} compacts`,
            ariaLabel:
              contextCompactionCount === 1
                ? "Conversation memory compacted"
                : `${contextCompactionCount} conversation memory compactions`,
          }
        : null,
  },
  {
    id: "duration",
    summarize: ({ durationMs }) => {
      const duration = formatDurationFacet(durationMs);
      return duration ? { content: duration } : null;
    },
  },
]);

function resolveTurnSummaryFacets(
  configuration: TurnSummaryFacetConfiguration | undefined,
): readonly TurnSummaryFacet[] {
  const requested: readonly TurnSummaryFacet[] = configuration?.replace ?? [
    ...BUILT_IN_TURN_SUMMARY_FACETS.filter(
      (facet) => !configuration?.remove?.includes(facet.id as BuiltInTurnSummaryFacetId),
    ),
    ...(configuration?.add ?? []),
  ];
  const seen = new Set<string>();
  return requested.filter((facet) => {
    if (!facet.id || seen.has(facet.id)) {
      return false;
    }
    seen.add(facet.id);
    return true;
  });
}

function hasFacetContent(content: ReactNode): boolean {
  return content !== null && content !== undefined && content !== false && content !== "";
}

class FacetRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function formatDurationFacet(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) {
    return null;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
