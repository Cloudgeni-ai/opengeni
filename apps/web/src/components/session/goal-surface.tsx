// The goal surface: ONE slim floating pill above the composer (Codex-style)
// that carries the active goal at a glance — state, truncated title, live
// elapsed — and expands to a panel with the full goal detail, autonomy
// counters, and pause/resume. The goal is its own concern: spawned agents live
// in their single composer-adjacent surface, so nothing here reaches for the
// session's lineage.
//
// Copy doctrine: human language only. Internal status slugs (requires_action,
// active, …) are translated to plain labels at this boundary; no enum leaks
// into a rendered string.
import type { UseGoalResult } from "@opengeni/react";
import type { SessionGoal } from "@opengeni/sdk";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useState, type ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

/* --- state model ------------------------------------------------------------ */

export type GoalPillState =
  | "pursuing"
  | "scheduled"
  | "blocked"
  | "held"
  | "paused"
  | "invariant_broken"
  | "completed";

type GoalPillMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Glyph + accent tint for the leading icon and the elapsed dot. */
  tint: string;
  /** Ring/border tint for the pill when the state earns color. */
  ring: string;
};

const GOAL_PILL_META: Record<GoalPillState, GoalPillMeta> = {
  pursuing: { label: "Pursuing goal", icon: ZapIcon, tint: "text-brand", ring: "border-brand/40" },
  scheduled: {
    label: "Continuation scheduled",
    icon: Loader2Icon,
    tint: "text-brand",
    ring: "border-brand/40",
  },
  blocked: {
    label: "Continuation blocked",
    icon: TriangleAlertIcon,
    tint: "text-status-waiting",
    ring: "border-status-waiting/40",
  },
  paused: {
    label: "Goal paused",
    icon: PauseIcon,
    tint: "text-status-waiting",
    ring: "border-status-waiting/40",
  },
  held: {
    label: "Held by workstream",
    icon: PauseIcon,
    tint: "text-status-waiting",
    ring: "border-status-waiting/40",
  },
  invariant_broken: {
    label: "Needs attention",
    icon: TriangleAlertIcon,
    tint: "text-status-waiting",
    ring: "border-status-waiting/50",
  },
  completed: {
    label: "Goal completed",
    icon: CheckCircle2Icon,
    tint: "text-status-idle",
    ring: "border-status-idle/40",
  },
};

/**
 * Select the pill state from the goal's authoritative continuation projection.
 * An active goal without a projection is an invariant failure, never evidence
 * that the agent is pursuing it.
 */
export function goalPillState(
  goalStatus: "active" | "paused" | "completed",
  continuation: SessionGoal["continuation"],
): GoalPillState {
  if (goalStatus === "completed") {
    return "completed";
  }
  if (goalStatus === "paused") {
    return "paused";
  }
  if (!continuation) {
    return "invariant_broken";
  }
  if (continuation.state === "running") {
    // `running` is meaningful only with the goal-owned reason. Keep the UI
    // truthful even when an older or corrupt server pairs it with human work.
    return continuation.reason === "goal_turn_running"
      ? "pursuing"
      : continuation.reason === "human_turn_running"
        ? "blocked"
        : "invariant_broken";
  }
  if (continuation.state === "scheduled") {
    return "scheduled";
  }
  if (continuation.state === "blocked") {
    return continuation.reason === "workstream_paused" ? "held" : "blocked";
  }
  return "invariant_broken";
}

function continuationNotice(
  state: GoalPillState,
  continuation: SessionGoal["continuation"],
): { tone: "info" | "waiting" | "failed"; title: string; body: string } | null {
  if (!continuation || state === "pursuing" || state === "paused" || state === "completed") {
    return state === "invariant_broken"
      ? {
          tone: "failed",
          title: "Needs attention",
          body:
            continuation?.lastError ?? "The server could not verify how this goal will continue.",
        }
      : null;
  }
  if (state === "scheduled") {
    return {
      tone: "info",
      title: "Continuation scheduled",
      body: continuation.nextAttemptAt
        ? `The next goal turn is scheduled for ${new Date(continuation.nextAttemptAt).toLocaleString()}.`
        : "The next goal turn is scheduled and waiting for its wake signal.",
    };
  }
  if (state === "held") {
    return {
      tone: "waiting",
      title: "Goal held by workstream",
      body: "The goal is still active. It will continue when this workstream is resumed.",
    };
  }
  if (state === "blocked") {
    return {
      tone: "waiting",
      title: "Continuation blocked",
      body: continuation.lastError ?? "The next goal turn is blocked until the blocker clears.",
    };
  }
  return {
    tone: "failed",
    title: "Needs attention",
    body: continuation.lastError ?? "The server reported an invalid continuation state.",
  };
}

/* --- elapsed clock ---------------------------------------------------------- */

function formatCoarseElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Elapsed time since `startIso`, ticking every second while `live`. When frozen
 * (paused/completed) it renders the span to `endIso` if given, else to the
 * moment it stopped ticking — a completed goal shows its final duration, a
 * paused one holds still.
 */
function useLiveElapsed(
  startIso: string | null | undefined,
  live: boolean,
  endIso?: string | null,
): string | null {
  const start = startIso ? Date.parse(startIso) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live]);
  if (!Number.isFinite(start)) {
    return null;
  }
  const end = live ? now : endIso ? Date.parse(endIso) : now;
  return formatCoarseElapsed((Number.isFinite(end) ? end : now) - start);
}

/* --- the floating pill ------------------------------------------------------ */

export function GoalSurface({ goal }: { session: Session; goal: UseGoalResult }) {
  const [open, setOpen] = useState(false);
  const record = goal.goal;
  // All hooks run unconditionally (the null-goal early return is below): the
  // elapsed clock ticks only while the server-authoritative projection says the
  // goal turn is running. No session status is used as a pursuit proxy.
  const live =
    record?.status === "active" &&
    record.continuation?.state === "running" &&
    record.continuation.reason === "goal_turn_running";
  const elapsed = useLiveElapsed(
    record?.createdAt,
    Boolean(live),
    // Freeze the clock whenever it stops ticking: a completed goal shows its
    // final duration; scheduled/blocked/invariant-broken projections freeze at
    // the goal's last update rather than implying ongoing pursuit.
    !live ? record?.updatedAt : null,
  );

  // Hidden entirely when the session has no goal — the pill is a goal surface,
  // not a permanent chrome element.
  if (!record) {
    return null;
  }

  const state = goalPillState(record.status, record.continuation);
  const meta = GOAL_PILL_META[state];
  const Icon = meta.icon;
  const canToggle = record.status !== "completed";

  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl justify-start px-4 sm:px-6">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div
            data-testid="goal-surface"
            className={cn(
              "inline-flex max-w-full items-center gap-2 rounded-full border bg-surface-2/90 py-1 pl-3 pr-1 text-xs shadow-md backdrop-blur",
              "supports-[backdrop-filter]:bg-surface-2/75",
              meta.ring,
            )}
          >
            <Icon className={cn("size-3.5 shrink-0", meta.tint)} />
            <span
              className={cn("shrink-0 font-medium", state === "pursuing" ? "text-fg" : meta.tint)}
            >
              {meta.label}
            </span>
            <span aria-hidden className="shrink-0 text-fg-subtle">
              ·
            </span>
            <span className="min-w-0 truncate text-fg-muted" title={record.text}>
              {record.text}
            </span>
            {elapsed ? (
              <>
                <span aria-hidden className="shrink-0 text-fg-subtle">
                  ·
                </span>
                <span className="shrink-0 tabular-nums text-fg-muted" title="Time on this goal">
                  {elapsed}
                </span>
              </>
            ) : null}

            {/* The inline pause/resume toggle lives on the COLLAPSED pill only —
                once the panel is open, its labeled Pause/Resume button owns the
                action, so showing both would be a duplicate control. */}
            {canToggle && !open ? (
              <button
                type="button"
                aria-label={record.status === "paused" ? "Resume goal" : "Pause goal"}
                disabled={goal.updating}
                onClick={() =>
                  void (record.status === "paused"
                    ? goal.resume()
                    : goal.pause("Paused from the console"))
                }
                className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle outline-none transition-colors hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
              >
                {goal.updating ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : record.status === "paused" ? (
                  <PlayIcon className="size-3.5" />
                ) : (
                  <PauseIcon className="size-3.5" />
                )}
              </button>
            ) : null}

            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label={open ? "Hide goal detail" : "Show goal detail"}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle outline-none transition-colors hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-3 data-[state=open]:text-fg"
              >
                <ChevronDownIcon className="size-3.5 transition-transform data-[state=open]:rotate-180" />
              </button>
            </Popover.Trigger>
          </div>
        </Popover.Anchor>

        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={cn(
              // Anchored directly above the composer, the panel opens UPWARD. On a
              // short viewport it caps at the space available above the pill and
              // scrolls inside itself rather than overflowing off-screen or
              // flipping down over the composer.
              "z-50 flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-y-auto overscroll-contain",
              "rounded-xl border border-border bg-surface shadow-lg outline-none",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[side=top]:slide-in-from-bottom-1",
            )}
          >
            <GoalDetail goal={goal} state={state} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/* --- expanded goal detail --------------------------------------------------- */

function GoalDetail({ goal, state }: { goal: UseGoalResult; state: GoalPillState }) {
  const record = goal.goal;
  if (!record) {
    return null;
  }
  const meta = GOAL_PILL_META[state];
  const notice = continuationNotice(state, record.continuation);
  return (
    <div className="p-3">
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
        <meta.icon className={cn("size-3.5", meta.tint)} />
        {meta.label}
      </div>
      <p className="mt-1.5 text-sm leading-6 text-fg">{record.text}</p>

      {record.successCriteria ? (
        <p className="mt-2 text-xs leading-5 text-fg-muted">
          <span className="font-medium text-fg">Done when</span> {record.successCriteria}
        </p>
      ) : null}
      {record.status === "paused" && (record.pausedReason ?? record.rationale) ? (
        <p className="mt-2 text-xs leading-5 text-status-waiting/90">
          Paused because {record.pausedReason ?? record.rationale}
        </p>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notice>
      ) : null}
      {record.status === "completed" && record.evidence ? (
        <p className="mt-2 text-xs leading-5 text-status-idle/90">Evidence {record.evidence}</p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <MetaChip
          dot={
            record.maxAutoContinuations !== null &&
            record.autoContinuations >= record.maxAutoContinuations
              ? "waiting"
              : undefined
          }
        >
          {record.maxAutoContinuations !== null
            ? `${record.autoContinuations} of ${record.maxAutoContinuations} auto-continues`
            : `${record.autoContinuations} auto-continue${record.autoContinuations === 1 ? "" : "s"}`}
        </MetaChip>
        <MetaChip dot={record.noProgressStreak >= 2 ? "waiting" : undefined}>
          {record.noProgressStreak} stalled check{record.noProgressStreak === 1 ? "" : "s"}
        </MetaChip>
        <MetaChip>v{record.version}</MetaChip>
      </div>

      {/* Delete lives on the left (a quiet destructive action), pause/resume on
          the right. Delete is available in every state, including a completed
          goal the user wants to clear off the session. */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <DeleteGoalButton goal={goal} />
        {record.status === "active" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={goal.updating}
            onClick={() => void goal.pause("Paused from the console")}
          >
            {goal.updating ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <PauseIcon className="size-3" />
            )}
            Pause goal
          </Button>
        ) : record.status === "paused" ? (
          <Button
            type="button"
            size="xs"
            disabled={goal.updating}
            onClick={() => void goal.resume()}
          >
            {goal.updating ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <PlayIcon className="size-3" />
            )}
            Resume goal
          </Button>
        ) : null}
      </div>

      {goal.mutationError ? (
        <div className="mt-2">
          <Notice tone="failed">{goal.mutationError.message}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A quiet destructive "Delete goal" action with a lightweight two-step confirm
 * (it's destructive but low-stakes — the loop stops and the pill hides, no data
 * beyond the goal record is lost, so a full modal would be overkill). On confirm
 * it calls `deleteGoal`; the goal becomes null, which unmounts the whole surface.
 */
function DeleteGoalButton({ goal }: { goal: UseGoalResult }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        <span className="pl-1">Delete goal?</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={goal.updating}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="xs"
          disabled={goal.updating}
          onClick={() => void goal.deleteGoal()}
        >
          {goal.updating ? <Loader2Icon className="size-3 animate-spin" /> : null}
          Delete
        </Button>
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="text-fg-subtle hover:text-destructive"
      disabled={goal.updating}
      onClick={() => setConfirming(true)}
    >
      <Trash2Icon className="size-3" />
      Delete goal
    </Button>
  );
}
