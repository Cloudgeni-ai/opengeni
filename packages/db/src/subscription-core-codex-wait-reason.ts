import { codexPlanKey } from "@opengeni/codex";
import type { SubscriptionWaitAccount } from "@opengeni/contracts/subscription-capacity-wait";
import {
  automaticallyUsable,
  connectionIneligibility,
  failoverCandidateModels,
  modelPermitted,
  servableAgainAt,
  type PlacementDecision,
  type PlacementInput,
} from "@opengeni/subscriptions";
import { SUBSCRIPTION_CORE_CODEX_PROVIDER } from "./subscription-core-codex-provider";
import {
  subscriptionWaitAccountLabel,
  type SubscriptionCoreWaitPresentation,
} from "./subscription-core/wait-reason";

/** Explain the result using the same accepted, scoped placement world. This
 * never excludes a runnable Free account or treats missing usage as a limit. */
export function projectCodexSubscriptionWait(
  input: PlacementInput,
  decision: Extract<PlacementDecision, { kind: "wait" }>,
): SubscriptionCoreWaitPresentation | null {
  if (
    !["no_eligible_capacity", "pinned_account_unavailable", "pinned_account_ineligible"].includes(
      decision.reason,
    )
  )
    return null;

  const binding = input.session.binding;
  const pinned = binding?.choice === "explicit" ? binding.connectionId : null;
  const models = failoverCandidateModels(input).filter((model) => modelPermitted(input, model));
  let waitAccount: SubscriptionWaitAccount | undefined;
  let planBlocked = false;
  let preferredModelRefused = false;
  let onlyProvenPlanBlocks = true;
  let otherBlock = false;
  let timed: { at: number | null; rateLimited: boolean } | undefined;
  for (const connection of input.connections) {
    if (pinned ? pinned !== connection.id : !automaticallyUsable(input, connection)) continue;
    for (const model of models) {
      const reasons = connectionIneligibility(input, connection, model);
      if (reasons.length === 0) {
        onlyProvenPlanBlocks = false;
        continue;
      }
      const codex = connection.provider === SUBSCRIPTION_CORE_CODEX_PROVIDER;
      const cooldown = connection.quota?.modelCooldownCauses?.[model];
      const provenPlanRefusal =
        codex && reasons.includes("model_cooling_down") && cooldown?.cause === "entitlement";
      // Skip pairs excluded by authority or policy. Catalog absence can
      // explain a wait, but it is not a recorded refusal. Nor does a refusal
      // with an independent quota or health blocker prove a plan-only wait.
      const availableByPolicy = reasons.every((reason) =>
        ["model_not_entitled", "model_cooling_down", "unhealthy", "exhausted"].includes(reason),
      );
      if (availableByPolicy) {
        if (!provenPlanRefusal || reasons.includes("unhealthy") || reasons.includes("exhausted"))
          onlyProvenPlanBlocks = false;
        else if (model === input.session.preferredModelId) preferredModelRefused = true;
      }
      if (
        availableByPolicy &&
        (provenPlanRefusal ||
          (codex &&
            codexPlanKey(connection.planType) === "free" &&
            !connection.quota?.windows.length &&
            reasons.includes("model_not_entitled")))
      ) {
        planBlocked = true;
        continue;
      }
      const at = servableAgainAt(input, connection, model);
      if (at !== undefined) {
        const rateLimited =
          codex &&
          at !== null &&
          ((connection.quota?.exhaustedKind === "rate_limit" &&
            at === connection.quota.exhaustedUntil) ||
            (cooldown?.cause === "rate_limit" && at === cooldown.until));
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
        // A reconnect names the account by a non-email label, else its id.
        waitAccount ??= {
          label: subscriptionWaitAccountLabel(connection.label) ?? `(${connection.id})`,
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
  if (waitAccount && !otherBlock)
    return { reason: "codex_relogin_required", earliestResetAt: null, waitAccount };
  if (planBlocked && !otherBlock)
    return {
      reason: "codex_plan_no_capacity",
      earliestResetAt: null,
      ...(onlyProvenPlanBlocks && preferredModelRefused
        ? { planRefusedModelId: input.session.preferredModelId }
        : {}),
    };
  return null;
}
