import {
  subscriptionCapacityWaitNeedsAction as baseWaitNeedsAction,
  subscriptionCapacityWaitReasonText as baseWaitReasonText,
} from "@opengeni/subscriptions";

/** Provider diagnoses carried by the public capacity-wait events and notices. */
export type ProviderCapacityWaitReason =
  | "codex_relogin_required"
  | "codex_plan_no_capacity"
  | "codex_rate_limited";

export type SubscriptionReconnectAccount = { label: string; personal: boolean };

export function isProviderCapacityWaitReason(reason: string): reason is ProviderCapacityWaitReason {
  return (
    reason === "codex_relogin_required" ||
    reason === "codex_plan_no_capacity" ||
    reason === "codex_rate_limited"
  );
}

/** Current wait guidance shared by initial parking and later reclassification.
 * These are new audit events only; never rewrite an earlier model request. */
export function subscriptionCapacityWaitReasonText(
  reason: string,
  name: string,
  account?: SubscriptionReconnectAccount,
): string | null {
  if (!isProviderCapacityWaitReason(reason)) return baseWaitReasonText(reason, name);
  const messages: Record<ProviderCapacityWaitReason, string> = {
    codex_relogin_required: `The Codex account${account ? ` ${account.label}` : ""} needs a new sign-in. ${account?.personal ? "Its owner" : "An admin"} must reconnect it.`,
    codex_plan_no_capacity:
      "The ChatGPT plans available to this chat don’t provide Codex capacity for this model. Connect an account with access or switch to another model.",
    codex_rate_limited:
      "Codex is rate-limited. This turn continues automatically when an account has capacity again.",
  };
  return messages[reason];
}

export function subscriptionCapacityWaitNeedsAction(reason: string): boolean {
  return (
    reason === "codex_relogin_required" ||
    reason === "codex_plan_no_capacity" ||
    baseWaitNeedsAction(reason)
  );
}
