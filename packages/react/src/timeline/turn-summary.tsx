import {
  ChevronRightIcon,
  CircleSlashIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Component, useMemo, useState, type ReactNode } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../lib/cn";
import { useForcedDefaultOpen } from "./disclosure-context";
import { useEntranceAnimation } from "./entrance";
import {
  applyPatchOps,
  isApplyPatch,
  mediaPreviewFact,
  screenshotDataUrl,
} from "./parsers";
import { rawTypeOf } from "./registry";
import type { ActivityItem, ToolCallItem, TurnOutcome } from "./types";
export type { TurnOutcome } from "./types";

/* ----------------------------------------------------------------------------
   Turn summary

   A completed (or failed/cancelled) turn folds behind one quiet summary chip:
   "N steps · M files · K commands · 1 screenshot · 4m". The chip is the default
   surface; expanding it reveals the full settled turn body. A live turn never
   folds — render its rows directly.

   This keeps the timeline calm: a finished turn is a single line until the
   reader chooses to look inside it.
   -------------------------------------------------------------------------- */

export const BUILT_IN_TURN_SUMMARY_FACET_IDS = [
  "steps",
  "files",
  "commands",
  "screenshots",
  "memories",
  "compacted",
  "duration",
] as const;

export type BuiltInTurnSummaryFacetId =
  (typeof BUILT_IN_TURN_SUMMARY_FACET_IDS)[number];

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

export type TurnSummaryFacetConfiguration =
  ModifyTurnSummaryFacets | ReplaceTurnSummaryFacets;

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
  /** Adjacent compaction landmark count for the secondary chip facet. */
  contextCompactionCount?: number | undefined;
  /** The rendered activity rail revealed on expand. */
  children: ReactNode;
};

export function TurnSummary({
  items,
  outcome,
  failureText,
  durationMs,
  defaultOpen,
  bare,
  facets: facetConfiguration,
  contextCompactionCount,
  children,
}: TurnSummaryProps) {
  // An explicit `defaultOpen` always wins; otherwise an ancestor may seed it
  // (screenshot instrumentation); otherwise the turn starts folded.
  const forcedDefaultOpen = useForcedDefaultOpen();
  const [open, setOpen] = useState(defaultOpen ?? forcedDefaultOpen ?? false);
  const enter = useEntranceAnimation();
  const context = useMemo(
    () =>
      createTurnSummaryContext(
        items,
        outcome,
        failureText,
        durationMs,
        contextCompactionCount ?? 0,
      ),
    [items, outcome, failureText, durationMs, contextCompactionCount],
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
          return result && hasFacetContent(result.content)
            ? [{ facet, result }]
            : [];
        } catch {
          // A host extension is presentation-only. It must never take down the
          // durable timeline or hide the remaining built-in evidence.
          return [];
        }
      }),
    [context, facetDefinitions],
  );

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={enter && !bare ? "animate-og-enter" : undefined}
    >
      <Collapsible.Trigger
        className={cn(
          // Both the top-level turn fold and a nested cluster fold render as a
          // FLAT rail row — chevron + glyph + facets on the page background, no
          // border, no fill. Only a hover tint hints the row is expandable, so a
          // collapsed turn never reads as a boxed card. The top-level row is a
          // touch larger (base text, size-5 glyph, wider gap) so it still reads
          // as a turn landmark above the nested cluster rows it groups.
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
        )}
      >
        {/* Disclosure grammar matches the rows: chevron leads (far left), then any
            exceptional or active state, then the facets — one expand affordance
            side everywhere. */}
        <ChevronRightIcon className="size-3.5 shrink-0 text-og-fg-subtle transition-transform duration-150 group-data-[state=open]:rotate-90" />
        {/* Completion is the quiet default and needs no repeated glyph. Failed,
            cancelled, and still-running folds retain a visible state marker. */}
        {outcome === "complete" ? null : (
          <span
            className={cn(
              "inline-flex shrink-0 items-center justify-center",
              bare ? "size-3.5" : "size-5",
              outcome === "failed"
                ? "text-og-status-failed"
                : "text-og-fg-subtle",
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
          className={cn(
            "min-w-0 flex-1 truncate",
            bare ? "text-og-sm" : "text-og-fg-muted",
          )}
        >
          {facets.map(({ facet, result }, index) => (
            <FacetRenderBoundary key={facet.id}>
              <>
                {index > 0 ? " · " : null}
                <span aria-label={result.ariaLabel} title={result.title}>
                  {result.icon ? (
                    <span
                      aria-hidden
                      className="mr-1 inline-flex align-[-0.125em]"
                    >
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
            "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            "pointer-coarse:opacity-100",
          )}
        >
          {open ? "hide steps" : "show steps"}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-og-collapse data-[state=open]:animate-og-expand">
        {/* A nested node indents its revealed rows under the glyph (thread nesting
            off the parent rail); the top-level turn body owns its own rail. */}
        <div className={bare ? "pt-1 pl-5" : "pt-2"}>{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
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
    itemSnapshot.filter(
      (item): item is ToolCallItem => item.kind === "tool-call",
    ),
  );
  const settled = itemSnapshot.every((item) => {
    if (item.kind === "reasoning") {
      return !item.streaming;
    }
    if (
      item.kind === "tool-call" ||
      item.kind === "worker" ||
      item.kind === "sandbox"
    ) {
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

const BUILT_IN_TURN_SUMMARY_FACETS: readonly TurnSummaryFacet[] = Object.freeze(
  [
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
        return files
          ? { content: `${files} ${files === 1 ? "file" : "files"} edited` }
          : null;
      },
    },
    {
      id: "commands",
      summarize: ({ toolCalls }) => {
        const commands = toolCalls.filter(
          (item) => item.name === "exec_command",
        ).length;
        return commands
          ? {
              content: `${commands} ${commands === 1 ? "command" : "commands"}`,
            }
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
            (screenshotDataUrl(item.output) !== null ||
              mediaPreviewFact(item.output) !== null)
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
          parts.push(
            `${updated} ${updated === 1 ? "memory" : "memories"} updated`,
          );
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
                contextCompactionCount === 1
                  ? "compacted"
                  : `${contextCompactionCount} compacts`,
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
  ],
);

function resolveTurnSummaryFacets(
  configuration: TurnSummaryFacetConfiguration | undefined,
): readonly TurnSummaryFacet[] {
  const requested: readonly TurnSummaryFacet[] = configuration?.replace ?? [
    ...BUILT_IN_TURN_SUMMARY_FACETS.filter(
      (facet) =>
        !configuration?.remove?.includes(facet.id as BuiltInTurnSummaryFacetId),
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
  return (
    content !== null &&
    content !== undefined &&
    content !== false &&
    content !== ""
  );
}

class FacetRenderBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function formatDurationFacet(durationMs: number | undefined): string | null {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 1000
  ) {
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
