// The goal surface: active goal text + status, the autonomy counters
// (autoContinuations / noProgressStreak), pause/resume control, and the
// goal.* event history. A session with an active goal keeps working between
// human messages; pausing stops the synthesized continuations without
// killing the session.
import type { UseGoalResult } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { ChevronDownIcon, FlagIcon, Loader2Icon, PauseIcon, PlayIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
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
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle">
          <FlagIcon className="size-3.5" />
          Goal
        </h3>
        {record ? <GoalStatusPill status={record.status} /> : null}
      </div>

      {goal.loading && !record ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/45 p-3 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading goal
        </div>
      ) : record ? (
        <div
          className={cn(
            "rounded-lg border p-2.5",
            record.status === "active" && "border-brand/35 bg-brand/5",
            record.status === "paused" && "border-status-waiting/30 bg-status-waiting/5",
            record.status === "completed" && "border-status-idle/30 bg-status-idle/5",
          )}
        >
          <div className="text-xs leading-5 text-fg">{record.text}</div>
          {record.successCriteria ? (
            <div className="mt-1.5 text-2xs text-fg-muted">
              <span className="font-medium">Done when:</span> {record.successCriteria}
            </div>
          ) : null}
          {record.status === "paused" && record.rationale ? (
            <div className="mt-1.5 text-2xs text-status-waiting/90">Paused: {record.rationale}</div>
          ) : null}
          {record.status === "completed" && record.evidence ? (
            <div className="mt-1.5 text-2xs text-status-idle/90">Evidence: {record.evidence}</div>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <MetaChip dot={record.maxAutoContinuations !== null && record.autoContinuations >= record.maxAutoContinuations ? "waiting" : undefined}>
              {record.maxAutoContinuations !== null
                ? `${record.autoContinuations} of ${record.maxAutoContinuations} auto-continues`
                : `${record.autoContinuations} auto-continue${record.autoContinuations === 1 ? "" : "s"}`}
            </MetaChip>
            <MetaChip dot={record.noProgressStreak >= 2 ? "waiting" : undefined}>
              {record.noProgressStreak} stalled check{record.noProgressStreak === 1 ? "" : "s"}
            </MetaChip>
            <MetaChip>version {record.version}</MetaChip>
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
        <Notice
          tone="failed"
          action={(
            <button type="button" onClick={goal.clearMutationError} aria-label="Dismiss goal error" className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg">
              <XIcon className="size-3.5" />
            </button>
          )}
        >
          {goal.mutationError.message}
        </Notice>
      ) : null}

      {goalEvents.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-2xs font-medium text-fg-subtle hover:text-fg-muted">
            <ChevronDownIcon className="mr-1 inline size-3 transition-transform group-open:rotate-180" />
            Goal history ({goalEvents.length})
          </summary>
          <ol className="mt-2 space-y-1" aria-label="Goal event history">
            {goalEvents.slice(0, 20).map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-bg/25 px-2 py-1.5 text-2xs">
                <span className="min-w-0 truncate font-medium text-fg-muted">{eventLabel(event.type)}</span>
                <span className="shrink-0 text-2xs text-fg-subtle">{formatTimestamp(event.occurredAt)}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

const GOAL_STATUS_LABEL: Record<"active" | "paused" | "completed", string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
};

/** The compact goal chip for the session header: status at a glance, full
 *  counters (auto-continues, stalled checks, version) in the tooltip so no
 *  cryptic glyphs leak into the chip. */
export function GoalChip({ goal }: { goal: UseGoalResult }) {
  const record = goal.goal;
  if (!record) {
    return null;
  }
  const suffix = record.status === "paused" ? "Paused" : record.status === "completed" ? "Done" : null;
  const tooltip = `${record.text} — ${record.autoContinuations} auto-continues, ${record.noProgressStreak} stalled checks, version ${record.version}`;
  return (
    <span
      data-testid="goal-chip"
      title={tooltip}
      className={cn(
        "inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium",
        record.status === "active" && "border-brand/40 bg-brand/10 text-fg",
        record.status === "paused" && "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
        record.status === "completed" && "border-status-idle/40 bg-status-idle/10 text-status-idle",
      )}
    >
      <FlagIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{record.text}</span>
      {suffix ? <span className="shrink-0 text-2xs opacity-75">{suffix}</span> : null}
    </span>
  );
}

function GoalStatusPill({ status }: { status: "active" | "paused" | "completed" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-2xs font-medium",
        status === "active" && "border-brand/40 bg-brand/10 text-fg",
        status === "paused" && "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
        status === "completed" && "border-status-idle/40 bg-status-idle/10 text-status-idle",
      )}
    >
      {GOAL_STATUS_LABEL[status]}
    </span>
  );
}
