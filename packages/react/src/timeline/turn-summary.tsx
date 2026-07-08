import { CheckIcon, ChevronRightIcon, CircleSlashIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../lib/cn";
import { useForcedDefaultOpen } from "./disclosure-context";
import { useEntranceAnimation } from "./entrance";
import { applyPatchOps, isApplyPatch, screenshotDataUrl } from "./parsers";
import { rawTypeOf } from "./registry";
import type { ActivityItem, TurnOutcome } from "./types";
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
  /** The rendered activity rail revealed on expand. */
  children: React.ReactNode;
};

export function TurnSummary({
  items,
  outcome,
  failureText,
  durationMs,
  defaultOpen,
  bare,
  children,
}: TurnSummaryProps) {
  // An explicit `defaultOpen` always wins; otherwise an ancestor may seed it
  // (screenshot instrumentation); otherwise the turn starts folded.
  const forcedDefaultOpen = useForcedDefaultOpen();
  const [open, setOpen] = useState(defaultOpen ?? forcedDefaultOpen ?? false);
  const enter = useEntranceAnimation();
  const facets = summarizeTurn(items, durationMs);

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
        {/* Disclosure grammar matches the rows: chevron leads (far left), then the
            outcome glyph, then the facets — one expand affordance side everywhere. */}
        <ChevronRightIcon className="size-3.5 shrink-0 text-og-fg-subtle transition-transform duration-150 group-data-[state=open]:rotate-90" />
        {/* The outcome glyph carries the state by hue alone — no filled circle, no
            card. A clean (complete) run draws a bare muted check; a failed one a
            red triangle; a cancelled one a muted slash; a still-running cluster a
            quiet pulse dot in the glyph's place so alignment holds. */}
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
          ) : outcome === "complete" ? (
            <CheckIcon className={bare ? "size-3" : "size-3.5"} />
          ) : (
            <span className="size-1.5 animate-og-pulse rounded-full bg-og-fg-subtle" />
          )}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", bare ? "text-og-sm" : "text-og-fg-muted")}>
          {facets}
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

/** Compose the facet summary line ("14 steps · 3 files · 2 commands · 1 screenshot · 4m"). */
function summarizeTurn(items: ActivityItem[], durationMs?: number): string {
  let files = 0;
  let commands = 0;
  let screenshots = 0;
  let memoriesSaved = 0;
  let memoriesUpdated = 0;
  for (const item of items) {
    if (item.kind === "memory") {
      // A memory write is a first-class facet — the "wrote 1 memory" signal the
      // fold should make prominent — counted saved vs updated separately.
      if (item.variant === "corrected") {
        memoriesUpdated += 1;
      } else {
        memoriesSaved += 1;
      }
      continue;
    }
    if (item.kind !== "tool-call") {
      continue;
    }
    // `item` is narrowed to ToolCallItem by the guard above — no cast needed.
    if (isApplyPatch(item)) {
      files += applyPatchOps(item.raw).length;
    } else if (item.name === "exec_command") {
      commands += 1;
    } else if (
      rawTypeOf(item) === "computer_call" ||
      item.name === "computer_call" ||
      item.name === "computer_screenshot"
    ) {
      if (screenshotDataUrl(item.output) !== null) {
        screenshots += 1;
      }
    }
  }
  const parts = [`${items.length} ${items.length === 1 ? "step" : "steps"}`];
  if (files) {
    parts.push(`${files} ${files === 1 ? "file" : "files"} edited`);
  }
  if (commands) {
    parts.push(`${commands} ${commands === 1 ? "command" : "commands"}`);
  }
  if (screenshots) {
    parts.push(`${screenshots} ${screenshots === 1 ? "screenshot" : "screenshots"}`);
  }
  if (memoriesSaved) {
    parts.push(`${memoriesSaved} ${memoriesSaved === 1 ? "memory" : "memories"} saved`);
  }
  if (memoriesUpdated) {
    parts.push(`${memoriesUpdated} ${memoriesUpdated === 1 ? "memory" : "memories"} updated`);
  }
  const duration = formatDurationFacet(durationMs);
  if (duration) {
    parts.push(duration);
  }
  return parts.join(" · ");
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
