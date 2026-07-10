// Pure logic behind the session queue rail: reorder math, drag projection,
// and the claimed-mid-edit ("too late") reconciliation. The optimistic
// edit/reorder/delete projections themselves live in @opengeni/react
// (`applyTurnEdit` & co.); this module covers the console-side decisions on
// top of them so they stay unit-testable without a DOM.

import type { SessionStatus, SessionTurn } from "@opengeni/sdk";
import type { ComposerMode } from "@opengeni/react";

/** New queued-turn id order after moving one turn up or down a step. */
export function moveTurnInQueue(
  queueIds: string[],
  turnId: string,
  direction: "up" | "down",
): string[] | null {
  const from = queueIds.indexOf(turnId);
  if (from === -1) {
    return null;
  }
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= queueIds.length) {
    return null;
  }
  const next = [...queueIds];
  const moved = next.splice(from, 1)[0]!;
  next.splice(to, 0, moved);
  return next;
}

/** New queued-turn id order after dropping `draggedId` onto `targetId`'s slot. */
export function reorderQueueByDrag(
  queueIds: string[],
  draggedId: string,
  targetId: string,
): string[] | null {
  if (draggedId === targetId) {
    return null;
  }
  const from = queueIds.indexOf(draggedId);
  const to = queueIds.indexOf(targetId);
  if (from === -1 || to === -1) {
    return null;
  }
  const next = [...queueIds];
  const moved = next.splice(from, 1)[0]!;
  next.splice(to, 0, moved);
  return next;
}

export type QueueEditFate =
  /** Still queued: the edit can be saved. */
  | { kind: "editable"; turn: SessionTurn }
  /** Claimed by the worker mid-edit: too late, the prompt already ran/runs. */
  | { kind: "claimed"; turn: SessionTurn }
  /** Cancelled (deleted) while the editor was open. */
  | { kind: "cancelled"; turn: SessionTurn }
  /** The turn disappeared from the server view entirely. */
  | { kind: "missing" };

/**
 * What happened to the turn being edited, given the latest server view.
 * Drives the claimed/too-late affordance: an open editor must not pretend a
 * turn is still editable after the worker claimed it.
 */
export function editedTurnFate(turns: SessionTurn[], editingTurnId: string): QueueEditFate {
  const turn = turns.find((candidate) => candidate.id === editingTurnId);
  if (!turn) {
    return { kind: "missing" };
  }
  if (turn.status === "queued") {
    return { kind: "editable", turn };
  }
  if (turn.status === "cancelled") {
    return { kind: "cancelled", turn };
  }
  return { kind: "claimed", turn };
}

/** Seconds the active turn has been running (0 before it starts). */
export function turnElapsedSeconds(
  turn: Pick<SessionTurn, "startedAt">,
  now: Date = new Date(),
): number {
  if (!turn.startedAt) {
    return 0;
  }
  const started = new Date(turn.startedAt).getTime();
  if (Number.isNaN(started)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - started) / 1000));
}

export function turnSourceLabel(source: SessionTurn["source"]): string {
  if (source === "scheduled_task") {
    return "schedule";
  }
  if (source === "goal") {
    return "goal continuation";
  }
  return source;
}

/**
 * Honest one-liner for the compose-time delivery choice, aligned with what
 * `OpenGeniClient.steerMessage` actually does per status: it interrupts only
 * `running` and `requires_action` sessions (steering a session paused on an
 * approval abandons that approval); on a `queued` session it promotes the
 * message to the queue front without interrupting anything; with nothing
 * active it degrades to a plain send. A steer interrupt is tagged
 * `reason: "steer"` and the worker keeps an active goal running through it
 * (redirection, not a stop), so the hints stay silent about goals.
 */
export function deliveryModeExplanation(
  mode: ComposerMode,
  status: SessionStatus | null | undefined,
): string {
  if (mode === "steer") {
    switch (status) {
      case "running":
        return "Steer cancels the current step and runs your message next — the goal continues.";
      case "requires_action":
        return "Steer cancels the step waiting on approval (the pending approval is abandoned) and runs your message next — the goal continues.";
      case "queued":
        return "Nothing is running yet — sends now and jumps to the front of the queue.";
      default:
        return "Nothing is running — steering just sends the message.";
    }
  }
  switch (status) {
    case "running":
      return "Queues behind the running turn — visible and editable in the queue until claimed.";
    case "requires_action":
      return "Queues behind the turn waiting on approval — it starts once the approval is decided.";
    case "queued":
      return "Joins the queue behind the pending turns — visible and editable until claimed.";
    default:
      return "Sends now — the agent is idle, so the turn starts immediately.";
  }
}

/** Finished turns (newest first) for the history section of the rail. */
export function finishedTurns(turns: SessionTurn[]): SessionTurn[] {
  return turns
    .filter(
      (turn) =>
        turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled",
    )
    .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt));
}
