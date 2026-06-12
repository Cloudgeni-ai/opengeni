// The goal surface: active goal text + status, the autonomy counters
// (autoContinuations / noProgressStreak), pause/resume control, and the
// goal.* event history. A session with an active goal keeps working between
// human messages; pausing stops the synthesized continuations without
// killing the session.
import type { UseGoalResult } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { ChevronDownIcon, FlagIcon, Loader2Icon, PauseIcon, PlayIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { eventLabel } from "@/lib/events";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export function GoalCard({ goal, events }: {
  goal: UseGoalResult;
  events: SessionEvent[];
}) {
  if (!goal.goal && !goal.loading) {
    return null;
  }
  const record = goal.goal;
  const goalEvents = [...events.filter((event) => event.type.startsWith("goal."))].sort((a, b) => b.sequence - a.sequence);

  return (
    <div data-testid="goal-card" className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
          <FlagIcon className="size-3.5" />
          Goal
        </h3>
        {record ? <GoalStatusPill status={record.status} /> : null}
      </div>

      {goal.loading && !record ? (
        <div className="flex items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3 text-xs text-[color:var(--color-fg-muted)]">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading goal
        </div>
      ) : record ? (
        <div
          className={cn(
            "rounded-lg border p-2.5",
            record.status === "active" && "border-[color:var(--color-brand)]/35 bg-[color:var(--color-brand)]/5",
            record.status === "paused" && "border-amber-500/30 bg-amber-500/5",
            record.status === "completed" && "border-emerald-500/30 bg-emerald-500/5",
          )}
        >
          <div className="text-xs leading-5 text-[color:var(--color-fg)]">{record.text}</div>
          {record.successCriteria ? (
            <div className="mt-1.5 text-[11px] leading-4 text-[color:var(--color-fg-muted)]">
              <span className="font-medium">Done when:</span> {record.successCriteria}
            </div>
          ) : null}
          {record.status === "paused" && record.rationale ? (
            <div className="mt-1.5 text-[11px] leading-4 text-amber-200/90">Paused: {record.rationale}</div>
          ) : null}
          {record.status === "completed" && record.evidence ? (
            <div className="mt-1.5 text-[11px] leading-4 text-emerald-200/90">Evidence: {record.evidence}</div>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <CounterChip
              label="auto-continuations"
              value={record.maxAutoContinuations !== null ? `${record.autoContinuations}/${record.maxAutoContinuations}` : String(record.autoContinuations)}
              tone={record.maxAutoContinuations !== null && record.autoContinuations >= record.maxAutoContinuations ? "warn" : "default"}
            />
            <CounterChip
              label="no-progress streak"
              value={String(record.noProgressStreak)}
              tone={record.noProgressStreak >= 2 ? "warn" : "default"}
            />
            <CounterChip label="v" value={String(record.version)} tone="default" />
          </div>

          {record.status !== "completed" ? (
            <div className="mt-2.5 flex justify-end">
              {record.status === "active" ? (
                <Button type="button" variant="ghost" size="xs" disabled={goal.updating} onClick={() => void goal.pause("Paused from the console")}>
                  {goal.updating ? <Loader2Icon className="size-3 animate-spin" /> : <PauseIcon className="size-3" />}
                  Pause goal
                </Button>
              ) : (
                <Button type="button" size="xs" disabled={goal.updating} onClick={() => void goal.resume()}>
                  {goal.updating ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
                  Resume goal
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {goal.mutationError ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs leading-4 text-red-200">
          <span className="min-w-0 flex-1">{goal.mutationError.message}</span>
          <button type="button" onClick={goal.clearMutationError} aria-label="Dismiss goal error" className="shrink-0 rounded p-0.5 hover:bg-red-500/20">
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}

      {goalEvents.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)]">
            <ChevronDownIcon className="mr-1 inline size-3 transition-transform group-open:rotate-180" />
            Goal history ({goalEvents.length})
          </summary>
          <ol className="mt-2 space-y-1" aria-label="Goal event history">
            {goalEvents.slice(0, 20).map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--color-border)]/70 bg-[color:var(--color-bg)]/25 px-2 py-1.5 text-[11px]">
                <span className="min-w-0 truncate font-medium text-[color:var(--color-fg-muted)]">{eventLabel(event.type)}</span>
                <span className="shrink-0 text-[10px] text-[color:var(--color-fg-subtle)]">{formatTimestamp(event.occurredAt)}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/** The compact goal chip for the session header: status + counters at a glance. */
export function GoalChip({ goal }: { goal: UseGoalResult }) {
  const record = goal.goal;
  if (!record) {
    return null;
  }
  return (
    <span
      data-testid="goal-chip"
      title={record.text}
      className={cn(
        "inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium",
        record.status === "active" && "border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]",
        record.status === "paused" && "border-amber-500/40 bg-amber-500/10 text-amber-200",
        record.status === "completed" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      )}
    >
      <FlagIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{record.text}</span>
      <span className="shrink-0 font-mono text-[10px] opacity-75">
        {record.status === "paused" ? "paused" : record.status === "completed" ? "done" : `${record.autoContinuations}↻ ${record.noProgressStreak}∅`}
      </span>
    </span>
  );
}

function GoalStatusPill({ status }: { status: "active" | "paused" | "completed" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        status === "active" && "border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]",
        status === "paused" && "border-amber-500/40 bg-amber-500/10 text-amber-200",
        status === "completed" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      )}
    >
      {status}
    </span>
  );
}

function CounterChip({ label, value, tone }: { label: string; value: string; tone: "default" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
        tone === "warn"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
          : "border-[color:var(--color-border)] text-[color:var(--color-fg-subtle)]",
      )}
    >
      <span className="font-mono font-medium text-[color:var(--color-fg-muted)]">{value}</span>
      {label}
    </span>
  );
}
