/** Provider diagnoses carried by the public capacity-wait events and notices. */
export type ProviderCapacityWaitReason =
  | "codex_relogin_required"
  | "codex_plan_no_capacity"
  | "codex_rate_limited";

/**
 * The one account a capacity wait is about, named for people and agents: the
 * account that needs a new sign-in, or the account the chat is pinned to.
 * `label` is display text that is never an email address.
 */
export type SubscriptionWaitAccount = { label: string; personal: boolean };
/** @deprecated Use `SubscriptionWaitAccount`. */
export type SubscriptionReconnectAccount = SubscriptionWaitAccount;

export function isProviderCapacityWaitReason(reason: string): reason is ProviderCapacityWaitReason {
  return (
    reason === "codex_relogin_required" ||
    reason === "codex_plan_no_capacity" ||
    reason === "codex_rate_limited"
  );
}

/** Current wait guidance shared by initial parking and later reclassification.
 * These are new audit events only; never rewrite an earlier model request. */
export function providerCapacityWaitReasonText(
  reason: ProviderCapacityWaitReason,
  account?: SubscriptionWaitAccount,
): string {
  const messages: Record<ProviderCapacityWaitReason, string> = {
    codex_relogin_required: `The Codex account${account ? ` ${account.label}` : ""} needs a new sign-in. ${account?.personal ? "Its owner" : "An admin"} must reconnect it.`,
    codex_plan_no_capacity:
      "The ChatGPT plans available to this chat don’t provide Codex capacity for this model. Connect an account with access or switch to another model.",
    codex_rate_limited:
      "Codex is rate-limited. This turn continues automatically when an account has capacity again.",
  };
  return messages[reason];
}

export function providerCapacityWaitNeedsAction(reason: ProviderCapacityWaitReason): boolean {
  return reason === "codex_relogin_required" || reason === "codex_plan_no_capacity";
}
