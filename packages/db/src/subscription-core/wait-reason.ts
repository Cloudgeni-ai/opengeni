import type {
  ProviderCapacityWaitReason,
  SubscriptionWaitAccount,
} from "@opengeni/contracts/subscription-capacity-wait";
import {
  isPinnedAccountWaitReason,
  type PlacementDecision,
  type PlacementInput,
  type WaitReason,
} from "@opengeni/subscriptions";
import type { SubscriptionCoreProvider } from "./provider";

export type SubscriptionCoreWaitPresentation = {
  reason: WaitReason | ProviderCapacityWaitReason;
  earliestResetAt: Date | null;
  /** The account the wait is about: one needing a new sign-in, or the chat's pinned account. */
  waitAccount?: SubscriptionWaitAccount;
  /** Every usable candidate is blocked solely by a recorded model entitlement refusal. */
  planRefusedModelId?: string;
};

/**
 * Labels are optional and may default to an email. In a chat or a parent
 * agent's notice, name an account by a non-email label only.
 */
export function subscriptionWaitAccountLabel(label: string | null | undefined): string | null {
  const text = label?.trim().replace(/\s+/g, " ");
  return text && !text.includes("@") ? `“${text.slice(0, 80)}”` : null;
}

/**
 * The account a pinned wait is about: the session's explicit choice, named
 * by its label when it has a non-email one. Unnamed otherwise, or when the
 * pinned account is gone.
 */
function pinnedWaitAccount(input: PlacementInput): SubscriptionWaitAccount | undefined {
  const binding = input.session.binding;
  if (binding?.choice !== "explicit" || !binding.connectionId) return undefined;
  const connection = input.connections.find((each) => each.id === binding.connectionId);
  const label = subscriptionWaitAccountLabel(connection?.label);
  return connection && label
    ? { label, personal: connection.ownership.kind === "personal" }
    : undefined;
}

/** Explain a wait using the same scoped world that produced the decision. */
export function projectSubscriptionCoreWait(
  input: PlacementInput,
  decision: Extract<PlacementDecision, { kind: "wait" }>,
  provider: SubscriptionCoreProvider,
): SubscriptionCoreWaitPresentation {
  const presentation = provider.projectWait?.(input, decision) ?? {
    reason: decision.reason,
    earliestResetAt: decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
  };
  if (presentation.waitAccount || !isPinnedAccountWaitReason(presentation.reason))
    return presentation;
  const waitAccount = pinnedWaitAccount(input);
  return waitAccount ? { ...presentation, waitAccount } : presentation;
}
