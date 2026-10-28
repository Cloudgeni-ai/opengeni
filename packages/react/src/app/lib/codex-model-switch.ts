import type { Session, SessionEvent, SessionEventType } from "@opengeni/sdk";

import { isCodexProductModel } from "./session-model";

/** Events that say whether a chat's live context is a compaction checkpoint. */
export const CONTEXT_CHECKPOINT_EVENT_TYPES: SessionEventType[] = [
  "session.context.compacted",
  "session.context.cleared",
];

/**
 * Whether the newest context checkpoint among `events` is a compaction
 * (true), a clear (false), or absent (null). In a Codex remote_v2 chat every
 * compaction is Codex's own, which other models cannot read.
 */
export function latestCheckpointIsCompaction(events: readonly SessionEvent[]): boolean | null {
  // By sequence, so a page read newest-first answers the same.
  let latest: SessionEvent | null = null;
  for (const event of events) {
    if (event.type !== "session.context.compacted" && event.type !== "session.context.cleared")
      continue;
    if (!latest || event.sequence > latest.sequence) latest = event;
  }
  return latest ? latest.type === "session.context.compacted" : null;
}

/**
 * A chat Codex compacted is about to run on another provider's model, which
 * rebuilds its earlier messages from a fresh summary. Chats without a Codex
 * compaction switch with nothing to rebuild and need no heads-up.
 */
export function needsModelSwitchHeadsUp(input: {
  codexCompactionMode: Session["codexCompactionMode"] | null | undefined;
  codexCompacted: boolean;
  model: string | null | undefined;
}): boolean {
  return (
    input.codexCompactionMode === "remote_v2" &&
    input.codexCompacted &&
    typeof input.model === "string" &&
    input.model.length > 0 &&
    !isCodexProductModel(input.model)
  );
}

export function modelSwitchHeadsUpText(modelLabel: string): string {
  return `Earlier messages will be re-summarized for ${modelLabel}, so it may remember less detail.`;
}

/**
 * When this chat's Codex usage limit resets, from its newest usage-limit
 * event: the capacity wait it is parked on, or the turn the limit stopped.
 * Null when that event names no reset.
 */
export function codexUsageResetsAt(events: readonly SessionEvent[]): string | null {
  let latest: SessionEvent | null = null;
  for (const event of events) {
    const usageEvent =
      event.type === "codex.capacity.waiting" ||
      event.type === "turn.capacity_waiting" ||
      (event.type === "turn.failed" && payloadField(event, "code") === "codex_usage_limit_reached");
    if (usageEvent && (!latest || event.sequence > latest.sequence)) latest = event;
  }
  const resetsAt = latest ? payloadField(latest, "resetsAt") : null;
  return typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : null;
}

function payloadField(event: SessionEvent, key: string): unknown {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  return payload && typeof payload === "object" ? payload[key] : undefined;
}

/**
 * "Continue at reset" for a chat blocked on its Codex usage limit. A turn the
 * limit refused waits for capacity and continues at the reset unless the chat
 * is paused. A chat the limit stopped (failed or idle) is not waiting.
 */
export function codexUsageContinuesAtReset(input: {
  status: Session["status"];
  paused: boolean;
}): boolean {
  return input.status === "waiting_capacity" && !input.paused;
}

/**
 * What switching "Continue at reset" to `next` does: pause or resume the
 * waiting chat, or run a stopped chat's work again on its Codex model, which
 * waits for the reset. Null when nothing changes.
 */
export function codexUsageContinueAtResetAction(input: {
  status: Session["status"];
  paused: boolean;
  next: boolean;
}): "pause" | "resume" | "run_on_codex" | null {
  if (input.next === codexUsageContinuesAtReset(input)) return null;
  if (input.status === "waiting_capacity") return input.next ? "resume" : "pause";
  return input.next ? "run_on_codex" : null;
}

/**
 * "Resets at 14:05." the same day, "Resets Sat 14:05." within a week, else
 * with its date; plainly unknown without a reset time.
 */
export function codexUsageResetText(
  resetsAt: string | null,
  options: { now?: Date; locale?: string; timeZone?: string } = {},
): string {
  const reset = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  if (Number.isNaN(reset)) return "Reset time unknown.";
  const now = options.now ?? new Date();
  if (reset <= now.getTime()) return "Resets soon.";
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", { dateStyle: "short", ...zone }).format(date);
  const at = new Date(reset);
  const time = new Intl.DateTimeFormat(options.locale, { timeStyle: "short", ...zone }).format(at);
  if (day(at) === day(now)) return `Resets at ${time}.`;
  const withinWeek = reset - now.getTime() < 6 * 24 * 60 * 60 * 1000;
  const date = new Intl.DateTimeFormat(
    options.locale,
    withinWeek ? { weekday: "short", ...zone } : { month: "short", day: "numeric", ...zone },
  ).format(at);
  return `Resets ${date} ${time}.`;
}
