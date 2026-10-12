import {
  placeSubscriptionCoreTurnWithFailover,
  subscriptionCoreProvider,
  releaseSubscriptionTurnLease,
  withSubscriptionCoreAcceptedTurn,
  recordSubscriptionCoreServingPolicyForTurnAttempt,
  requestSessionTurnRecovery,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { servingTurnProviders } from "./subscription-serving-providers";
import {
  noServingModelMapping,
  servingPolicyForSelection,
  type ServingAttempt,
} from "./subscription-serving-claim";
import { selectCoreSubscriptionTurnCapacity } from "./subscription-core-capacity";
import { subscriptionCoreUnsupportedFailure } from "./codex-core-errors";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";

/** Between-attempt switch only: placement has committed before any provenance
 * or recovery writer runs. No model/tool call has started at this phase.
 */
export async function selectServingTurnCapacity(
  deps: CapacityPhaseDeps,
  context: ServingAttempt,
): Promise<CapacityPhaseOutcome> {
  const servingId = context.models.find(
    (model) => model.id === deps.turnExecutionPolicy.productModelId,
  )?.provider;
  const provider = servingTurnProviders().find((candidate) => candidate.id === servingId);
  if (!provider)
    throw subscriptionCoreUnsupportedFailure("Serving provider runtime", "Model account");
  const lease = provider.lease(deps);
  if (!lease.holderId) throw new Error("Serving lease holder not initialized");
  await provider.recoverHealth(deps, context.identity);
  await provider.beforePlacement?.(deps, context.identity);
  const placement = await placeSubscriptionCoreTurnWithFailover(
    deps.db,
    subscriptionCoreProvider(context.homeProviderId),
    {
      identity: context.identity,
      attemptId: deps.input.attemptId,
      executionGeneration: deps.attempt.executionGeneration,
      holderId: lease.holderId,
      leaseTtlMs: provider.leaseTtlMs,
      models: context.models,
      crossProviderFailoverEnabled: true,
      productModelId: context.acceptedPolicy.productModelId,
      reasoningLevel: context.acceptedPolicy.reasoningEffort,
    },
  );
  if (placement.kind === "wait") {
    if (placement.reason === "failover_no_model_mapping") throw noServingModelMapping();
    // B2 owns candidate-aware parking/reconciliation. Never arm a home-only
    // waiter for a multi-provider world and silently lose candidate wakes.
    if (
      (placement.candidateProviders?.length ?? 0) > 1 ||
      placement.candidateProviders?.some((id) => id !== provider.id)
    )
      throw subscriptionCoreUnsupportedFailure("Cross-provider capacity waiting", "Model account");
  }
  if (placement.kind === "run") {
    const modelId = placement.modelId ?? context.acceptedPolicy.productModelId;
    const targetPolicy = servingPolicyForSelection(
      deps.settings,
      context.acceptedPolicy,
      modelId,
      placement.reasoningLevel ?? context.acceptedPolicy.reasoningEffort,
    );
    if (!context.revision) {
      // Claim had no available account. Before dispatch, establish the accepted
      // baseline; the connection is advisory, not permission to dispatch.
      const baseline = await recordSubscriptionCoreServingPolicyForTurnAttempt(deps.db, {
        ...context.identity,
        attemptId: deps.input.attemptId,
        executionGeneration: deps.attempt.executionGeneration,
        crossProviderFailoverEnabled: true,
        policy: deps.turnExecutionPolicy,
        connectionId: placement.connectionId,
        reason: "initial",
      });
      if (!baseline.accepted) throw new Error(`Serving baseline refused: ${baseline.reason}`);
      context.revision = baseline.revision;
    }
    if (
      targetPolicy.productModelId !== deps.turnExecutionPolicy.productModelId ||
      targetPolicy.providerId !== deps.turnExecutionPolicy.providerId
    ) {
      const released = await withSubscriptionCoreAcceptedTurn(deps.db, context.identity, (tx) =>
        releaseSubscriptionTurnLease(tx, {
          ...context.identity,
          provider: placement.provider ?? context.homeProviderId,
          connectionId: placement.connectionId,
          holderId: lease.holderId!,
          generation: deps.attempt.executionGeneration,
        }),
      );
      if (released.status !== "completed") throw new Error("Serving recovery lost accepted turn");
      const recovery = await requestSessionTurnRecovery(deps.db, deps.input.workspaceId, {
        sessionId: deps.input.sessionId,
        turnId: context.identity.turnId,
        triggerEventId: deps.turn.triggerEventId,
        attemptId: deps.input.attemptId,
        reason: "subscription_serving_model_changed",
        subscriptionServingTarget: {
          crossProviderFailoverEnabled: true,
          executionGeneration: deps.attempt.executionGeneration,
          policy: targetPolicy,
          connectionId: placement.connectionId,
          reason: placement.switch,
        },
      });
      if (recovery.action !== "recovering") {
        deps.acknowledgeLostAttemptOwnership();
        return { exit: deps.claimedResult({ status: "cancelled" }) };
      }
      deps.acknowledgeRecoveryQuiescence();
      await publishDurableSessionEvents(
        deps.bus,
        deps.input.workspaceId,
        deps.input.sessionId,
        recovery.events,
      );
      deps.control.activityStatus = "recovering";
      deps.control.turnMetricOutcome = "recovering";
      return { exit: deps.claimedResult({ status: "recovering" }) };
    }
  }
  // Preserve provider-specific adoption, guarded credentials, heartbeat and
  // selection alias. The placement result is already committed; do not place twice.
  return selectCoreSubscriptionTurnCapacity(deps, {
    ...provider,
    recoverHealth: async () => {},
    beforePlacement: async () => {},
    place: async () => {
      if (placement.kind !== "wait") return placement;
      if (placement.reason === "failover_no_model_mapping") throw noServingModelMapping();
      return { ...placement, reason: placement.reason };
    },
  });
}
