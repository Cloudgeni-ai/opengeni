import type { WaitReason } from "./types";

/** Waits on the account a person chose for the chat (its explicit pin). */
const PINNED_ACCOUNT_WAIT_REASONS: ReadonlySet<string> = new Set([
  "pinned_account_unavailable",
  "pinned_account_disabled",
  "pinned_account_ineligible",
]);

/**
 * Whether the wait is on the chat's explicitly chosen account. Placement
 * honours the pin and never moves such a turn to another account (D-46), so
 * switching the chat back to automatic account choice, not another model of
 * the same provider, is what lets it continue elsewhere.
 */
export function isPinnedAccountWaitReason(reason: string): boolean {
  return PINNED_ACCOUNT_WAIT_REASONS.has(reason);
}

/** Current wait guidance shared by initial parking and later reclassification.
 * These are new audit events only; never rewrite an earlier model request.
 * `account` names the pinned account of a pinned wait when it has a label;
 * `resetText` says until when a pinned account has no capacity, for a notice
 * that is updated when that time changes (never for an event's stable text). */
export function subscriptionCapacityWaitReasonText(
  reason: string,
  name: string,
  account?: { label: string },
  resetText?: string | null,
): string | null {
  const named = account ? ` ${account.label}` : "";
  const messages: Record<WaitReason, string> = {
    pinned_account_unavailable: `This chat is pinned to the ${name} account${named}, which has no capacity ${resetText ? `until about ${resetText}. It continues by itself then` : "right now. It continues by itself when that account has room again"}, or sooner on another account once the chat is switched back to automatic account choice.`,
    pinned_account_disabled: `The ${name} account${named} pinned to this chat is turned off. Turn it back on, choose another account, or switch the chat to automatic. Waiting alone will not fix this.`,
    pinned_account_ineligible: `The ${name} account${named} chosen for this session can no longer serve this work. This turn continues once another account is chosen or the session is switched back to automatic.`,
    no_eligible_capacity: `No ${name} subscription has capacity for this turn right now. It continues automatically when an account is available.`,
    model_not_allowed: `This model is not allowed for the ${name} subscriptions available here. This turn continues if that changes.`,
    compaction_provider_locked:
      "This session is tied to a provider that has no capacity right now. It continues automatically when an account is available.",
    accepted_authority_unavailable:
      "This work was accepted before the account move and its account access could not be carried. Send it again to continue.",
  };
  return Object.hasOwn(messages, reason) ? messages[reason as WaitReason] : null;
}

export function subscriptionCapacityWaitNeedsAction(reason: string): boolean {
  return [
    "pinned_account_disabled",
    "pinned_account_ineligible",
    "model_not_allowed",
    "accepted_authority_unavailable",
  ].includes(reason);
}
