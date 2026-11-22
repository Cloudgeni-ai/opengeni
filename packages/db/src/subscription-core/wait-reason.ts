import {
  automaticallyUsable,
  connectionIneligibility,
  failoverCandidateModels,
  modelPermitted,
  servableAgainAt,
  type PlacementDecision,
  type PlacementInput,
  type SubscriptionCapacityWaitReason,
  type SubscriptionReconnectAccount,
} from "@opengeni/subscriptions";

export type SubscriptionCoreWaitPresentation = {
  reason: SubscriptionCapacityWaitReason;
  earliestResetAt: Date | null;
  reconnectAccount?: SubscriptionReconnectAccount;
};

/** Explain the result using the same accepted, scoped placement world. This
 * never excludes a runnable Free account or treats missing usage as a limit. */
export function projectSubscriptionCoreWait(
  input: PlacementInput,
  decision: Extract<PlacementDecision, { kind: "wait" }>,
  provider: string,
): SubscriptionCoreWaitPresentation {
  const ordinary = {
    reason: decision.reason,
    earliestResetAt: decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
  };
  if (
    provider !== "codex" ||
    !["no_eligible_capacity", "pinned_account_unavailable", "pinned_account_ineligible"].includes(
      decision.reason,
    )
  )
    return ordinary;

  const binding = input.session.binding;
  const pinned = binding?.choice === "explicit" ? binding.connectionId : null;
  const models = failoverCandidateModels(input).filter((model) => modelPermitted(input, model));
  let reconnectAccount: SubscriptionReconnectAccount | undefined;
  let planBlocked = false;
  let otherBlock = false;
  let timed: { at: number | null; rateLimited: boolean } | undefined;
  for (const connection of input.connections) {
    if (pinned ? pinned !== connection.id : !automaticallyUsable(input, connection)) continue;
    for (const model of models) {
      const reasons = connectionIneligibility(input, connection, model);
      if (reasons.length === 0) continue;
      const codex = connection.provider === "codex";
      // In Codex a model cooldown records a proven plan refusal; expiry
      // permits another probe, not a quota refill. A Free plan without an
      // included window also needs evidence that this model is not entitled.
      if (
        codex &&
        (reasons.includes("model_cooling_down") ||
          (connection.planType === "free" &&
            !connection.quota?.windows.length &&
            reasons.includes("model_not_entitled"))) &&
        reasons.every((reason) =>
          ["model_not_entitled", "model_cooling_down", "unhealthy", "exhausted"].includes(reason),
        )
      ) {
        planBlocked = true;
        continue;
      }
      const at = servableAgainAt(input, connection, model);
      if (at !== undefined) {
        const rateLimited =
          codex &&
          connection.quota?.exhaustedKind === "rate_limit" &&
          at !== null &&
          at === connection.quota.exhaustedUntil;
        if (
          !timed ||
          (at !== null && (timed.at === null || at < timed.at)) ||
          (at === timed.at && !rateLimited)
        )
          timed = { at, rateLimited };
        continue;
      }
      if (
        codex &&
        connection.health === "needs_reconnect" &&
        reasons.every((reason) => reason === "unhealthy" || reason === "exhausted")
      ) {
        // Labels are optional and may default to an email. In a chat or a
        // parent agent's notice, use a non-email label or the connection id.
        const label = connection.label?.trim().replace(/\s+/g, " ");
        reconnectAccount ??= {
          label: label && !label.includes("@") ? `“${label.slice(0, 80)}”` : `(${connection.id})`,
          personal: connection.ownership.kind === "personal",
        };
        continue;
      }
      if (
        reasons.includes("unhealthy") &&
        reasons.every(
          (reason) =>
            reason === "unhealthy" || reason === "exhausted" || reason === "model_cooling_down",
        )
      )
        otherBlock = true;
      else if (pinned) otherBlock = true;
    }
  }
  if (timed) {
    return {
      reason: timed.rateLimited ? "codex_rate_limited" : decision.reason,
      earliestResetAt: timed.at === null ? null : new Date(timed.at),
    };
  }
  if (reconnectAccount && !otherBlock)
    return { reason: "codex_relogin_required", earliestResetAt: null, reconnectAccount };
  if (planBlocked && !otherBlock)
    return { reason: "codex_plan_no_capacity", earliestResetAt: null };
  return ordinary;
}
