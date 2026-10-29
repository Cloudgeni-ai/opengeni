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
  // A wait whose reason changed later records its reset as `earliestResetAt`.
  const resetsAt = latest
    ? (payloadField(latest, "resetsAt") ?? payloadField(latest, "earliestResetAt"))
    : null;
  return typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : null;
}

/** Waits that only capacity coming back (a usage reset) ends. */
const USAGE_WAIT_REASONS: ReadonlySet<string> = new Set([
  "no_eligible_capacity",
  "compaction_provider_locked",
  // The chat's pinned account is out of usage until its reset.
  "pinned_account_unavailable",
]);

/**
 * Whether the newest capacity wait is a usage wait, not one that needs a
 * person to act (a turned-off or ineligible account, a model not allowed).
 */
export function codexWaitIsUsageLimit(events: readonly SessionEvent[]): boolean {
  let latest: SessionEvent | null = null;
  for (const event of events) {
    const wait = event.type === "codex.capacity.waiting" || event.type === "turn.capacity_waiting";
    if (wait && (!latest || event.sequence > latest.sequence)) latest = event;
  }
  if (!latest || payloadField(latest, "actionRequired") === true) return false;
  const reason = payloadField(latest, "waitReason");
  return reason === undefined || reason === null || USAGE_WAIT_REASONS.has(String(reason));
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
 * Whether picking another model in the composer continues the blocked chat
 * with it: a Codex chat its usage limit stopped or holds, and any chat whose
 * turn is parked on provider capacity (a used-up Claude, Codex or SuperGrok
 * plan, an account to reconnect), which would otherwise wait for its reset.
 * Only a person who may control the chat continues it.
 */
export function pickedModelContinuesBlockedChat(input: {
  status: Session["status"];
  codexUsageBlocked: boolean;
  canControl: boolean;
}): boolean {
  return input.canControl && (input.codexUsageBlocked || input.status === "waiting_capacity");
}

/**
 * Whether the usage-limit line describes this chat. A Codex usage wait with
 * a known reset is a usage limit. A wait with no reset in sight (for example
 * no ChatGPT plan connected any more) or one that needs a person to act keeps
 * the server's own wait message, which names the actual cause.
 */
export function codexUsageNoticeApplies(input: {
  status: Session["status"];
  resetsAt: string | null;
  usageWait: boolean;
}): boolean {
  return input.status !== "waiting_capacity" || (input.usageWait && input.resetsAt !== null);
}

/**
 * What switching "Continue at reset" to `next` does: pause or resume the
 * waiting chat, or run a stopped chat's work again on its Codex model, which
 * waits for the reset (resuming a paused chat first, so that work isn't held
 * back). Null when nothing changes.
 */
export function codexUsageContinueAtResetAction(input: {
  status: Session["status"];
  paused: boolean;
  next: boolean;
}): "pause" | "resume" | "run_on_codex" | "resume_and_run_on_codex" | null {
  if (input.next === codexUsageContinuesAtReset(input)) return null;
  if (input.status === "waiting_capacity") return input.next ? "resume" : "pause";
  if (!input.next) return null;
  return input.paused ? "resume_and_run_on_codex" : "run_on_codex";
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
