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
  /** The rendered activity rail revealed on expand. */
  children: React.ReactNode;
};

export function TurnSummary({ items, outcome, failureText, durationMs, defaultOpen, children }: TurnSummaryProps) {
  // An explicit `defaultOpen` always wins; otherwise an ancestor may seed it
  // (screenshot instrumentation); otherwise the turn starts folded.
  const forcedDefaultOpen = useForcedDefaultOpen();
  const [open, setOpen] = useState(defaultOpen ?? forcedDefaultOpen ?? false);
  const enter = useEntranceAnimation();
  const facets = summarizeTurn(items, durationMs);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={enter ? "animate-og-enter" : undefined}>
      <Collapsible.Trigger
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-og-md border px-3 py-2 text-left text-og-base transition-colors",
          // A folded turn is a touch target on coarse pointers: grow the row so
          // it clears the 40px minimum without disturbing the calm desktop rhythm.
          "pointer-coarse:py-2.5",
          // Only a failed turn earns the one filled/tinted card in the timeline;
          // complete and cancelled stay flat and calm.
          outcome === "failed"
            ? "border-og-status-failed/30 bg-og-status-failed/[0.06] hover:border-og-status-failed/50"
            : "border-og-border bg-og-surface-1/50 hover:border-og-border-strong",
        )}
      >
        {/* Disclosure grammar matches the rows: chevron leads (far left), then the
            outcome glyph, then the facets — one expand affordance side everywhere. */}
        <ChevronRightIcon className="size-3.5 shrink-0 text-og-fg-subtle transition-transform duration-150 group-data-[state=open]:rotate-90" />
        {/* Only the exceptional outcomes earn a filled tinted circle. A clean
            (complete) run draws a bare muted check — zero colored fills, so the
            eye is pulled only to a turn that needs attention. */}
        <span
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
            outcome === "failed"
              ? "bg-og-status-failed/15 text-og-status-failed"
              : outcome === "cancelled"
                ? "bg-og-fg-subtle/15 text-og-fg-subtle"
                : "text-og-fg-subtle",
          )}
        >
          {outcome === "failed" ? (
            <TriangleAlertIcon className="size-3" />
          ) : outcome === "cancelled" ? (
            <CircleSlashIcon className="size-3" />
          ) : outcome === "complete" ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <span className="size-1.5 animate-og-pulse rounded-full bg-og-fg-subtle" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-og-fg-muted">
          {facets}
          {outcome === "failed" && failureText ? (
            <span className="text-og-status-failed"> · {failureText}</span>
          ) : null}
          {outcome === "cancelled" ? <span className="text-og-fg-subtle"> · interrupted</span> : null}
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
        <div className="pt-2">{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** Compose the facet summary line ("14 steps · 3 files · 2 commands · 1 screenshot · 4m"). */
function summarizeTurn(items: ActivityItem[], durationMs?: number): string {
  let files = 0;
  let commands = 0;
  let screenshots = 0;
  for (const item of items) {
    if (item.kind !== "tool-call") {
      continue;
    }
    // `item` is narrowed to ToolCallItem by the guard above — no cast needed.
    if (isApplyPatch(item)) {
      files += applyPatchOps(item.raw).length;
    } else if (item.name === "exec_command") {
      commands += 1;
    } else if (rawTypeOf(item) === "computer_call" || item.name === "computer_call" || item.name === "computer_screenshot") {
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
