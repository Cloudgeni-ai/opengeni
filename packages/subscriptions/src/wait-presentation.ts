import type { WaitReason } from "./types";

/** Current wait guidance shared by initial parking and later reclassification.
 * These are new audit events only; never rewrite an earlier model request. */
export function subscriptionCapacityWaitReasonText(reason: string, name: string): string | null {
  const messages: Record<WaitReason, string> = {
    pinned_account_unavailable: `The ${name} account chosen for this session is unavailable right now. This turn continues automatically once it is available again.`,
    pinned_account_disabled: `The ${name} account pinned to this chat is turned off. Turn it back on, choose another account, or switch the chat to automatic. Waiting alone will not fix this.`,
    pinned_account_ineligible: `The ${name} account chosen for this session can no longer serve this work. This turn continues once another account is chosen or the session is switched back to automatic.`,
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
