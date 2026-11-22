import type {
  ProviderCapacityWaitReason,
  SubscriptionReconnectAccount,
} from "@opengeni/contracts/subscription-capacity-wait";
import type { PlacementDecision, PlacementInput, WaitReason } from "@opengeni/subscriptions";
import type { SubscriptionCoreProvider } from "./provider";

export type SubscriptionCoreWaitPresentation = {
  reason: WaitReason | ProviderCapacityWaitReason;
  earliestResetAt: Date | null;
  reconnectAccount?: SubscriptionReconnectAccount;
};

/** Explain a wait using the same scoped world that produced the decision. */
export function projectSubscriptionCoreWait(
  input: PlacementInput,
  decision: Extract<PlacementDecision, { kind: "wait" }>,
  provider: SubscriptionCoreProvider,
): SubscriptionCoreWaitPresentation {
  return (
    provider.projectWait?.(input, decision) ?? {
      reason: decision.reason,
      earliestResetAt:
        decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
    }
  );
}
