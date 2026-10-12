import {
  resolveTurnExecutionPolicyV1,
  assertTurnServingPolicyMatchesConfigV1,
  type Settings,
} from "@opengeni/config";
import {
  readTurnPendingServingPolicyV1,
  readTurnServingPolicyV1,
  type TurnExecutionPolicyV1,
  type TurnServingPolicyV1,
} from "@opengeni/contracts";
import {
  evaluateSubscriptionCorePlacementWithFailover,
  getSessionTurn,
  readSubscriptionCoreTurnIdentity,
  recordSubscriptionCoreServingPolicyForTurnAttempt,
  readSubscriptionCoreTurnFailoverBudget,
  SUBSCRIPTION_CORE_SERVING_FAILOVER_LIMIT,
  subscriptionCoreProvider,
  readSubscriptionCoreFailoverProvider,
  withSubscriptionCoreAcceptedTurn,
  type Database,
  type SubscriptionCoreFailoverModel,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { servingCatalog } from "./subscription-serving-catalog";
export { servingCatalog } from "./subscription-serving-catalog";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import {
  SubscriptionCoreCodexTurnError,
  subscriptionCoreServingFailoverExhaustedFailure,
} from "./codex-core-errors";

export type ServingAttempt = {
  acceptedPolicy: TurnExecutionPolicyV1;
  identity: SubscriptionCoreTurnIdentity;
  homeProviderId: string;
  models: SubscriptionCoreFailoverModel[];
  revision: TurnServingPolicyV1 | null;
};

export function noServingModelMapping(): Error {
  return new SubscriptionCoreCodexTurnError(
    {
      code: "subscription_core_unsupported",
      retryable: false,
      error:
        "No supported cross-provider model mapping is configured for this model. Configure an exact allowed fallback model.",
      detail: "failover_no_model_mapping",
    },
    "Model account",
  );
}

export function servingPolicyForSelection(
  settings: Settings,
  accepted: TurnExecutionPolicyV1,
  modelId: string,
  reasoning: string,
): TurnExecutionPolicyV1 {
  return resolveTurnExecutionPolicyV1(settings, {
    modelId,
    requestedModelId: null,
    modelSource: accepted.modelSource,
    reasoningEffort: reasoning as Settings["openaiReasoningEffort"],
    reasoningSource: accepted.reasoningSource,
    latencyMode: accepted.latencyMode,
    latencyModeSource: accepted.latencyModeSource,
  });
}

/** Already-portable only. Disabled/restricted/maintenance paths do not record
 * provenance or enable a provider. Accepted policy and presentation stay fixed.
 */
export async function claimServingAttempt(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  compactionMode: string;
  source: string;
  acceptedPolicy: TurnExecutionPolicyV1;
  providerIds: readonly string[];
}): Promise<ServingAttempt | null> {
  const { db, settings, acceptedPolicy } = input;
  if (
    !settings.subscriptionCrossProviderFailoverEnabled ||
    input.compactionMode !== "portable" ||
    input.source === "compaction" ||
    acceptedPolicy.credentialRestriction !== undefined
  )
    return null;
  const models = servingCatalog(settings, input.providerIds);
  const home = models.find((model) => model.id === acceptedPolicy.productModelId);
  if (!home) return null;
  const identity = await readSubscriptionCoreTurnIdentity(db, input);
  if (!identity) throw new TurnAttemptFencedError("Serving claim lost accepted turn");
  const ready = await withSubscriptionCoreAcceptedTurn(db, identity, (tx) =>
    readSubscriptionCoreFailoverProvider(tx, input.accountId, home.provider),
  );
  if (ready.status !== "completed" || !ready.value) return null;
  const turn = await getSessionTurn(db, input.workspaceId, input.turnId);
  if (!turn || turn.sessionId !== input.sessionId)
    throw new TurnAttemptFencedError("Serving turn disappeared");
  const stored = readTurnServingPolicyV1(turn.metadata);
  const previous = stored.kind === "valid" ? stored.revisions.at(-1) : undefined;
  const pending = readTurnPendingServingPolicyV1(turn.metadata);
  let candidate: Pick<TurnServingPolicyV1, "policy" | "connectionId" | "reason"> | undefined =
    pending ?? previous;
  if (!candidate) {
    const selected = await evaluateSubscriptionCorePlacementWithFailover(
      db,
      subscriptionCoreProvider(home.provider),
      {
        identity,
        models,
        crossProviderFailoverEnabled: true,
        productModelId: acceptedPolicy.productModelId,
        reasoningLevel: acceptedPolicy.reasoningEffort,
      },
    );
    if (selected.kind === "wait" && selected.reason === "failover_no_model_mapping")
      throw noServingModelMapping();
    if (selected.kind === "run")
      candidate = {
        policy: servingPolicyForSelection(
          settings,
          acceptedPolicy,
          selected.modelId ?? acceptedPolicy.productModelId,
          selected.reasoningLevel ?? acceptedPolicy.reasoningEffort,
        ),
        connectionId: selected.connectionId,
        reason: selected.switch,
      };
  }
  const context: ServingAttempt = {
    acceptedPolicy,
    identity,
    homeProviderId: home.provider,
    models,
    revision: null,
  };
  if (!candidate) return context;
  // Validate before persisting; a stale catalog cannot become serving truth.
  assertTurnServingPolicyMatchesConfigV1(
    settings,
    {
      policy: candidate.policy,
      connectionId: candidate.connectionId,
      reason: candidate.reason,
      schemaVersion: 1,
      executionGeneration: input.executionGeneration,
      historyPosition: 0,
    },
    acceptedPolicy,
  );
  const receipt = await recordSubscriptionCoreServingPolicyForTurnAttempt(db, {
    ...input,
    ...candidate,
    crossProviderFailoverEnabled: true,
  });
  if (!receipt.accepted && receipt.reason === "failover_bound_exceeded") {
    const budget = await readSubscriptionCoreTurnFailoverBudget(db, input);
    if (!budget) throw new TurnAttemptFencedError("Serving budget lost accepted turn");
    throw subscriptionCoreServingFailoverExhaustedFailure(
      budget.steps,
      SUBSCRIPTION_CORE_SERVING_FAILOVER_LIMIT,
    );
  }
  if (!receipt.accepted)
    throw new TurnAttemptFencedError(`Serving revision refused: ${receipt.reason}`);
  context.revision = receipt.revision;
  return context;
}
