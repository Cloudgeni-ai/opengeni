import type { EventStatusReasonCode } from "@opengeni/contracts";
import type { EventStatusReason } from "@opengeni/db";

/**
 * Why a source or trigger is held back: a code clients word in their own
 * language, the same reason as an English sentence for people and agents,
 * and what the app or server said, when it said something.
 */
export function eventStatusReason(
  code: EventStatusReasonCode,
  text: string,
  detail?: string | null,
): EventStatusReason {
  return { code, text, detail: detail?.trim() || null };
}

/**
 * A failure a person has to fix, such as signing in again. The source or
 * trigger shows its reason, and its owner is told, until it is fixed.
 */
export class EventSourceBlockedError extends Error {
  readonly reason: EventStatusReason;

  constructor(reason: EventStatusReason) {
    super(reason.text);
    this.name = "EventSourceBlockedError";
    this.reason = reason;
  }
}
