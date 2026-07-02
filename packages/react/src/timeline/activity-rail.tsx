import { BotIcon, BrainIcon, SquareTerminalIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { truncate } from "../lib/format";
import { defaultToolRegistry } from "./tool-renderers";
import { useEntranceAnimation } from "./entrance";
import type { ToolRegistry } from "./registry";
import { PayloadBlock, ActivityDisclosure } from "./shared";
import { toolDisplayName } from "./projection";
import type { ActivityItem, ReasoningItem, SandboxItem, WorkerItem } from "./types";

/* ----------------------------------------------------------------------------
   Activity rail

   Renders a run of clustered activity items (reasoning, tool calls, workers,
   sandbox ops) as the left-bordered column between chat messages. Tool calls
   resolve through the renderer registry; everything else has a first-class row.

   Shared by `MessageTimeline` and the component demo so both draw the exact
   same rail — no divergence.
   -------------------------------------------------------------------------- */

export type ActivityRailProps = {
  items: ActivityItem[];
  /** Renderer registry for tool calls. Defaults to {@link defaultToolRegistry}. */
  toolRegistry?: ToolRegistry | undefined;
  /** Drill into a spawned worker session. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /** Drop the left rule + indent (used inside a folded turn summary). */
  bare?: boolean | undefined;
  className?: string | undefined;
};

/**
 * The "family" a row belongs to, for light intra-rail grouping. Consecutive
 * rows of the same family sit tight; a family change gets a little extra top
 * margin so a long run reads as clusters rather than one undifferentiated wall.
 */
function familyOf(item: ActivityItem): string {
  if (item.kind === "tool-call") {
    return item.name === "exec_command" || item.name === "write_stdin" ? "terminal" : item.name;
  }
  return item.kind;
}

export function ActivityRail({ items, toolRegistry = defaultToolRegistry, onOpenSession, bare, className }: ActivityRailProps) {
  const enter = useEntranceAnimation();
  return (
    <div
      className={cn(
        // Rows sit TIGHT by default (gap-0.5) so a same-family run reads as one
        // calm cluster; a family change opens real breathing room (mt-3) below,
        // so a long rail reads as a few clusters, not a metronome of rows.
        "flex flex-col gap-0.5",
        !bare && "border-l-2 border-og-border pl-3 sm:pl-4",
        !bare && enter && "animate-og-enter",
        className,
      )}
    >
      {items.map((item, index) => {
        const newFamily = index > 0 && familyOf(item) !== familyOf(items[index - 1]!);
        const row = renderActivity(item, toolRegistry, onOpenSession);
        return (
          <div key={item.id} className={cn(newFamily && "mt-3")}>
            {row}
          </div>
        );
      })}
    </div>
  );
}

/** A never-reachable guard: adding an `ActivityItem` kind is now a compile error. */
function assertNever(item: never): never {
  throw new Error(`ActivityRail: unhandled activity item ${JSON.stringify(item)}`);
}

function renderActivity(
  item: ActivityItem,
  toolRegistry: ToolRegistry,
  onOpenSession: ((sessionId: string) => void) | undefined,
) {
  switch (item.kind) {
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "tool-call": {
      const Renderer = toolRegistry.resolve(item);
      return <Renderer item={item} />;
    }
    case "worker":
      return <WorkerRow item={item} onOpenSession={onOpenSession} />;
    case "sandbox":
      return <SandboxRow item={item} />;
    default:
      return assertNever(item);
  }
}

function ReasoningRow({ item }: { item: ReasoningItem }) {
  // Reasoning recedes: a dimmer, lighter-weight title so action rows lead and
  // thought rows sit a half-step back in the hierarchy.
  return (
    <ActivityDisclosure
      icon={<BrainIcon className="size-3.5" />}
      iconTone="muted"
      title={
        item.streaming ? (
          "Thinking"
        ) : (
          <span className="font-normal italic text-og-fg-subtle">Thought</span>
        )
      }
      running={item.streaming}
      preview={truncate(item.text, 110)}
    >
      <p className="whitespace-pre-wrap text-og-base leading-6 text-og-fg-muted">{item.text}</p>
    </ActivityDisclosure>
  );
}

function SandboxRow({ item }: { item: SandboxItem }) {
  return (
    <ActivityDisclosure
      icon={<SquareTerminalIcon className="size-3.5" />}
      iconTone={item.status === "failed" ? "failed" : item.status === "running" ? "running" : "muted"}
      title={toolDisplayName(item.name)}
      running={item.status === "running"}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
      preview={item.command ?? undefined}
    >
      {item.command ? <PayloadBlock label="Command" value={item.command} /> : null}
      {item.output ? <PayloadBlock label="Output" value={item.output} /> : null}
    </ActivityDisclosure>
  );
}

/** Spawned/messaged worker sessions get a first-class card, not a tool row. */
function WorkerRow({ item, onOpenSession }: { item: WorkerItem; onOpenSession?: ((sessionId: string) => void) | undefined }) {
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const title =
    item.action === "spawn"
      ? running
        ? "Spawning worker"
        : failed
          ? "Worker spawn failed"
          : cancelled
            ? "Worker interrupted"
            : "Worker spawned"
      : item.action === "interrupt"
        ? (() => {
            const verb = item.mode === "steer" ? "Steering" : "Stopping";
            const done = item.mode === "steer" ? "Worker steered" : "Worker stopped";
            return running ? `${verb} worker` : failed ? "Worker interrupt failed" : cancelled ? "Worker interrupted" : done;
          })()
        : running
          ? "Messaging worker"
          : failed
            ? "Worker message failed"
            : cancelled
              ? "Worker interrupted"
              : "Worker messaged";
  return (
    <div
      className={cn(
        "my-0.5 flex items-start gap-3 rounded-og-md border bg-og-surface-1 p-3",
        failed ? "border-og-status-failed/40" : "border-og-border",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center",
          failed ? "text-og-status-failed" : "text-og-accent",
        )}
      >
        <BotIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {/* In-flight state is carried ONLY by the shimmering title (no detached
            pulse badge), matching every other running row in the rail. */}
        <span className={cn("text-og-base font-medium", running ? "og-shimmer-text" : failed ? "text-og-status-failed" : "text-og-fg")}>
          {title}
        </span>
        {item.prompt ? <p className="mt-0.5 truncate text-og-sm text-og-fg-muted">{truncate(item.prompt, 140)}</p> : null}
        {item.workerSessionId ? (
          <p className="mt-1 font-og-mono text-og-xs text-og-fg-subtle">{item.workerSessionId.slice(0, 8)}</p>
        ) : null}
      </div>
      {/* Right gutter: failed gets a red chip; cancelled gets a calm "interrupted"
          chip (no dot, no red); a live complete worker shows an "Open session" button. */}
      {failed ? (
        <span className="inline-flex shrink-0 self-center items-center gap-1.5 font-og-mono text-og-xs leading-none text-og-status-failed">
          <span className="size-1.5 rounded-full bg-og-status-failed" />
          failed
        </span>
      ) : cancelled ? (
        <span className="og-cancelled-chip shrink-0 self-center font-og-mono text-og-xs leading-none text-og-fg-subtle">
          interrupted
        </span>
      ) : item.workerSessionId && onOpenSession ? (
        <button
          type="button"
          onClick={() => item.workerSessionId && onOpenSession(item.workerSessionId)}
          className={cn(
            "shrink-0 self-center rounded-og-sm border border-og-border px-2.5 py-1 text-og-sm font-medium text-og-fg-muted pointer-coarse:py-2",
            "outline-none transition-colors duration-150 hover:border-og-border-strong hover:text-og-fg",
            "focus-visible:ring-2 focus-visible:ring-og-accent",
          )}
        >
          Open session
        </button>
      ) : null}
    </div>
  );
}
