import { subscriptionCapacityWaitNeedsAction } from "@opengeni/subscriptions";

/**
 * When a subscription capacity wait needs a person's (or a parent agent's)
 * attention, and the notices that tell them.
 *
 * A short wait (capacity returns within minutes) resumes by itself and stays
 * quiet. A long one, whose reset is far away, unknown, or that only a person
 * can fix, is announced once when it is armed: a worker's parent gets a
 * `child_waiting_capacity` notice, and a top-level chat's person gets an inbox
 * notification. Both carry the reset time and say how to continue sooner
 * (switch the chat's model, which releases the waiting turn onto it).
 * The person's notification never keeps promising a time that no longer
 * holds: when a later check finds the reset later than it said (its time
 * passed without capacity, or a longer limit binds) or unknown, the same
 * notification is updated in place (`capacityWaitNoticeNeedsRestating`).
 */
export const CAPACITY_WAIT_ATTENTION_AFTER_MS = 15 * 60_000;

/** Turn metadata recording the person's open capacity-wait notification. */
export const CAPACITY_WAIT_NOTICE_KEY = "capacityWaitNoticeV1";
/**
 * Turn metadata recording the reset a worker's parent was last told in a
 * `child_waiting_capacity` notice (the same marker shape, keyed by the
 * notice's dedupe key). Nothing is withdrawn for it when the wait ends.
 */
export const CAPACITY_WAIT_PARENT_NOTICE_KEY = "capacityWaitParentNoticeV1";

export type CapacityWaitAttention = {
  /** When capacity is expected back, when anything says so. */
  resetsAt: Date | null;
};

/** Null when the wait is short and resumes by itself. */
export function capacityWaitAttention(input: {
  waitReason: string;
  earliestResetAt: Date | null;
  healthRetryAt: Date | null;
  now: Date;
}): CapacityWaitAttention | null {
  const resetsAt = input.earliestResetAt ?? input.healthRetryAt ?? null;
  const long =
    subscriptionCapacityWaitNeedsAction(input.waitReason) ||
    resetsAt === null ||
    resetsAt.getTime() - input.now.getTime() >= CAPACITY_WAIT_ATTENTION_AFTER_MS;
  return long ? { resetsAt } : null;
}

export function capacityWaitProviderName(provider: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "xai") return "xAI";
  if (provider === "claude") return "Claude";
  return provider;
}

/** `2026-11-09 06:54 UTC`: the reset time as people read it. */
export function capacityWaitResetText(resetsAt: Date | string | null): string | null {
  if (resetsAt === null) return null;
  const date = typeof resetsAt === "string" ? new Date(resetsAt) : resetsAt;
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function capacityWaitNotificationKey(turnId: string): string {
  return `capacity-wait:${turnId}`;
}

/** The person's inbox notification for a top-level chat's long capacity wait. */
export function capacityWaitNotificationPayload(input: {
  turnId: string;
  provider: string;
  resetsAt: Date | null;
}) {
  const name = capacityWaitProviderName(input.provider);
  const reset = capacityWaitResetText(input.resetsAt);
  return {
    key: capacityWaitNotificationKey(input.turnId),
    title: `Chat waiting for ${name} capacity`,
    body: `${
      reset
        ? `No ${name} subscription has capacity until about ${reset}.`
        : `No ${name} subscription has capacity, and no reset time is known.`
    } The chat continues by itself then. To continue sooner, switch the chat to another model; its waiting turn continues on that model.`,
    urgency: "normal" as const,
    replaced: false,
  };
}

/**
 * The open notification of a waiting turn: its key, and the reset it told
 * the person (ISO, or null for "no reset time is known"). `resetsAt` is
 * undefined for a marker written before the notice recorded it.
 */
export type CapacityWaitNoticeMarker = { key: string; resetsAt?: string | null };

export function readCapacityWaitNotice(
  metadata: Record<string, unknown> | null | undefined,
  metadataKey: string = CAPACITY_WAIT_NOTICE_KEY,
): CapacityWaitNoticeMarker | null {
  const value = metadata?.[metadataKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { key, resetsAt } = value as { key?: unknown; resetsAt?: unknown };
  if (typeof key !== "string" || key.length === 0) return null;
  if (resetsAt === null) return { key, resetsAt: null };
  return typeof resetsAt === "string" && Number.isFinite(Date.parse(resetsAt))
    ? { key, resetsAt }
    : { key };
}

/** The turn metadata marker of a notification that told the person `resetsAt`. */
export function capacityWaitNoticeMarker(key: string, resetsAt: Date | null) {
  return { key, resetsAt: resetsAt?.toISOString() ?? null } satisfies CapacityWaitNoticeMarker;
}

/**
 * Whether the person's open notification, which told them `stated`, must be
 * updated for a wait now expected to end at `next`. It must when the wait
 * now ends later than it said (to the minute it shows), including after its
 * time passed without capacity, when the reset became unknown or known, and
 * when the marker does not record what it said. An earlier reset keeps it:
 * the turn then continues before the time it named.
 */
export function capacityWaitNoticeNeedsRestating(
  stated: CapacityWaitNoticeMarker,
  next: Date | null,
): boolean {
  if (stated.resetsAt === undefined) return true;
  if (stated.resetsAt === null || next === null)
    return stated.resetsAt !== (next?.toISOString() ?? null);
  return (
    next.getTime() > Date.parse(stated.resetsAt) &&
    capacityWaitResetText(next) !== capacityWaitResetText(stated.resetsAt)
  );
}

export function withoutCapacityWaitNotice(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (!(CAPACITY_WAIT_NOTICE_KEY in metadata)) return metadata;
  const next = { ...metadata };
  delete next[CAPACITY_WAIT_NOTICE_KEY];
  return next;
}

/** The event row (without sequence) withdrawing an open notice, if any. */
export function capacityWaitNoticeWithdrawal(
  metadata: Record<string, unknown> | null | undefined,
): { type: "session.notification.withdrawn"; payload: { key: string } } | null {
  const notice = readCapacityWaitNotice(metadata);
  return notice ? { type: "session.notification.withdrawn", payload: { key: notice.key } } : null;
}
