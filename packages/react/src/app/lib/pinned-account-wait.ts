import type { ChatSession as Session, SessionEvent } from "@opengeni/sdk";

/**
 * Waits on the account a person chose for this chat. Placement honours an
 * explicit choice and never moves the turn to another account, whatever the
 * model (subscription design D-24, D-46), so the way to continue sooner is
 * to switch the chat back to automatic account choice.
 */
export const PINNED_ACCOUNT_WAIT_REASONS: ReadonlySet<string> = new Set([
  "pinned_account_unavailable",
  "pinned_account_disabled",
  "pinned_account_ineligible",
]);

export type PinnedAccountWait = {
  /** The waiting turn's subscription provider (`codex`, `claude`, `xai`). */
  provider: string;
  reason: "pinned_account_unavailable" | "pinned_account_disabled" | "pinned_account_ineligible";
  /** When the pinned account is expected to have room again, if known. */
  resetsAt: string | null;
};

/** Provider of a `turn.capacity_waiting` event, by the provider it records. */
const WAIT_EVENT_PROVIDERS: Readonly<Record<string, string>> = {
  "claude-subscription": "claude",
  "supergrok-subscription": "xai",
};

/**
 * The pinned-account wait this chat's active turn is parked on, from its
 * newest capacity-wait event. Null when the chat is not waiting, or waits for
 * another reason (a busy pool keeps its own guidance).
 */
export function pinnedAccountWait(
  session: Pick<Session, "status" | "activeTurnId">,
  events: readonly SessionEvent[],
): PinnedAccountWait | null {
  if (session.status !== "waiting_capacity") return null;
  let latest: SessionEvent | null = null;
  for (const event of events) {
    if (event.type !== "codex.capacity.waiting" && event.type !== "turn.capacity_waiting") continue;
    if (!latest || event.sequence > latest.sequence) latest = event;
  }
  if (!latest) return null;
  if (session.activeTurnId && latest.turnId && latest.turnId !== session.activeTurnId) return null;
  const payload = (latest.payload ?? {}) as Record<string, unknown>;
  const reason = payload.waitReason;
  if (typeof reason !== "string" || !PINNED_ACCOUNT_WAIT_REASONS.has(reason)) return null;
  const provider =
    latest.type === "codex.capacity.waiting"
      ? "codex"
      : WAIT_EVENT_PROVIDERS[String(payload.provider)];
  if (!provider) return null;
  // A later reclassification records the reset as `earliestResetAt`.
  const reset = payload.earliestResetAt ?? payload.resetsAt;
  return {
    provider,
    reason: reason as PinnedAccountWait["reason"],
    resetsAt: typeof reset === "string" && !Number.isNaN(Date.parse(reset)) ? reset : null,
  };
}
