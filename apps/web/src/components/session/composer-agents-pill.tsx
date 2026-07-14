// The composer-anchored subagent pill: a compact floating pill that sits above
// the composer (a sibling of the goal pill), front-and-center, and expands
// UPWARD into the shared subagent lineage popover. This is the one Agents
// surface: a manager watches the tree from the input, not in duplicate chrome.
//
// State language: calm at rest ("3 agents") and live when any worker is running
// (a pulsing running-tone dot + "1 running"), so a glance at the composer tells
// you whether the fleet is working. Clicking opens {@link SubagentTree} from
// the same source of truth.
//
// Copy doctrine: human language only; no status enum leaks into a label.
import type { LineageNode } from "@opengeni/sdk";
import { BotIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";

import { SubagentTree, SubagentsLabel } from "@/components/session/subagents";
import { cn } from "@/lib/utils";

export function ComposerAgentsPill({
  workspaceId,
  nodes,
}: {
  workspaceId: string;
  /** Direct children; presentational — the caller owns the single lineage read.
   *  Renders nothing when there are no children. */
  nodes: LineageNode[];
}) {
  const [open, setOpen] = useState(false);
  const count = nodes.length;
  if (count === 0) {
    return null;
  }
  const runningCount = nodes.filter((n) => n.session.status === "running").length;
  const live = runningCount > 0;

  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl justify-start px-4 sm:px-6">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid="composer-agents-pill"
            className={cn(
              // Same elevated floating family as the goal pill (rounded-full /
              // border / surface-2 / shadow-md / backdrop-blur), and matched to
              // its height + left inset so the two read as siblings when stacked.
              "inline-flex h-8 max-w-full items-center gap-2 rounded-full border bg-surface-2/90 pl-3 pr-3.5 text-xs shadow-md backdrop-blur",
              "supports-[backdrop-filter]:bg-surface-2/75 outline-none transition-colors",
              "hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:border-border-strong",
              "pointer-coarse:min-h-11",
              live ? "border-status-running/40" : "border-border",
            )}
          >
            {/* Leading glyph: a live pulsing dot when work is running, else the
                calm bot icon. */}
            {live ? (
              <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                <span className="absolute inline-flex size-2 rounded-full bg-status-running opacity-70 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2 rounded-full bg-status-running" />
              </span>
            ) : (
              <BotIcon className="size-3.5 shrink-0 text-fg-subtle" />
            )}
            <span className="shrink-0 font-medium text-fg">
              {count} agent{count === 1 ? "" : "s"}
            </span>
            {live ? (
              <>
                <span aria-hidden className="shrink-0 text-fg-subtle">
                  ·
                </span>
                <span className="shrink-0 font-medium text-status-running">
                  {runningCount} running
                </span>
              </>
            ) : null}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={cn(
              // Anchored above the composer, opening UPWARD — the same panel
              // family + scroll behaviour as the goal pill's detail panel.
              "z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-y-auto overscroll-contain",
              "rounded-xl border border-border bg-surface shadow-lg outline-none",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[side=top]:slide-in-from-bottom-1",
            )}
          >
            <div className="p-2.5">
              <SubagentsLabel count={count} />
              {/* count > 0 here (the pill only renders with children), so the
                  tree always has rows — no loading/empty branch to guard. */}
              <div className="mt-2">
                <SubagentTree
                  workspaceId={workspaceId}
                  nodes={nodes}
                  onNavigate={() => setOpen(false)}
                />
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
