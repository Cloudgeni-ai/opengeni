import { isCacheWarm } from "./cache";
import {
  canServe,
  connectionUsesExtraCredits,
  connectionIneligibility,
  isPermanentIneligibility,
  modelAllowedInWorkspace,
  personalFallbackActive,
  providerEnabled,
  servableAgainAt,
  type Ineligibility,
} from "./eligibility";
import { mapReasoningLevel } from "./reasoning";
import { fallbackOrderFor, rotationFor } from "./settings";
import { spreadHash } from "./spread";
import type {
  ModelDescriptor,
  ModelId,
  PlacementDecision,
  PlacementInput,
  PlacementSwitch,
  ReselectionPoint,
  SubscriptionConnection,
  WaitReason,
} from "./types";

function findModel(input: PlacementInput, modelId: ModelId): ModelDescriptor | undefined {
  return input.models.find((model) => model.id === modelId);
}

/**
 * Candidate models in failover order (design 4 step 3): the preferred model,
 * then its configured fallbacks. Same-provider fallbacks are always candidates;
 * other providers need cross-provider failover (SUB-FAIL-02, SUB-FAIL-03). A
 * session limited to "only this model" or bound by an explicit choice has only
 * the preferred model (SUB-FAIL-05). Restrictions do not remove candidates, so
 * a restricted preferred model keeps its place in the order (D-17); see
 * `modelPermitted`.
 */
export function failoverCandidateModels(input: PlacementInput): ModelId[] {
  const { session, settings } = input;
  const preferredId = session.preferredModelId;
  if (session.onlyThisModel || session.binding?.choice === "explicit") return [preferredId];
  const preferred = findModel(input, preferredId);
  const candidates: ModelId[] = [preferredId];
  for (const modelId of fallbackOrderFor(settings, preferredId)) {
    if (candidates.includes(modelId)) continue;
    const model = findModel(input, modelId);
    if (!model) continue;
    if (model.provider !== preferred?.provider && !settings.crossProviderFailover) continue;
    candidates.push(modelId);
  }
  return candidates;
}

/**
 * May this session's work use this model at all? The workspace model ceiling
 * (SUB-ELIG-02), the provider switch (SUB-SET-06) and a compaction provider
 * lock (SUB-FAIL-09) restrict models alike: a restricted preferred model is
 * treated like one without capacity and work moves to the next permitted
 * candidate (D-17, D-26).
 */
export function modelPermitted(
  input: PlacementInput,
  modelId: ModelId,
  honourCompactionLock = true,
): boolean {
  const model = findModel(input, modelId);
  if (!model) return false;
  if (!modelAllowedInWorkspace(input.workspace, modelId)) return false;
  if (!providerEnabled(input, model.provider)) return false;
  const lock = input.session.compactionProviderLock;
  return !honourCompactionLock || lock === null || model.provider === lock;
}

/**
 * Order servable connections for one model (design 4 step 5): the primary
 * first, whether or not its quota is known (D-13, D-15), then the session's
 * spread hash (D-14, D-21, D-23), then id. Missing telemetry is not a penalty.
 */
export function rankConnections(
  input: PlacementInput,
  connections: readonly SubscriptionConnection[],
): SubscriptionConnection[] {
  const keyed = connections.map((connection) => {
    const rotation = rotationFor(input.settings, connection.provider);
    return {
      connection,
      credits: connectionUsesExtraCredits(input, connection),
      primary: rotation.mode === "primary_first" && rotation.primaryConnectionId === connection.id,
      hash: spreadHash(input.session.id, connection.id),
    };
  });
  keyed.sort(
    (left, right) =>
      Number(left.credits) - Number(right.credits) ||
      Number(right.primary) - Number(left.primary) ||
      left.hash - right.hash ||
      (left.connection.id < right.connection.id
        ? -1
        : left.connection.id > right.connection.id
          ? 1
          : 0),
  );
  return keyed.map((entry) => entry.connection);
}

/**
 * Why an automatic binding does not keep its account for this placement
 * (SUB-STICK-03). Every reason except `cache_cold` is forced: the account or
 * its model cannot (or should not) serve this work now, whatever the cache.
 */
export type ReselectionReason =
  /** The session has no account yet. */
  | "unbound"
  /**
   * The bound account is not in this session's world: removed, or outside
   * the session's scope (a disconnected account stays in the world and is
   * `account_ineligible`).
   */
  | "account_unavailable"
  /** The bound model may no longer be used here (workspace, provider switch, compaction lock). */
  | "model_not_permitted"
  /**
   * The bound account cannot serve now; `ineligibility` says why (exhausted
   * or rate-limited, unhealthy or quarantined, disconnected, switched off,
   * personal authority or owner gone).
   */
  | "account_ineligible"
  /** The bound account would spend paid credits while another has included allowance (SUB-CREDITS-01). */
  | "extra_credits"
  /** A compaction or model change replaced the cached prefix (SUB-STICK-05). */
  | "reselection_point"
  /** Idle longer than the provider's declared cache lifetime (SUB-STICK-04). */
  | "cache_cold";

export type BindingStickiness =
  | { kind: "keep"; connectionId: string; modelId: ModelId }
  | {
      kind: "reselect";
      reason: ReselectionReason;
      /** The bound account's ineligibility for its model (empty unless `account_ineligible`). */
      ineligibility: readonly Ineligibility[];
      /** The re-selection points that applied (empty unless `reselection_point`). */
      points: readonly ReselectionPoint[];
    };

/**
 * Does the session's automatic binding keep its account (SUB-STICK-02,
 * SUB-STICK-03)? It does while the account can still serve the bound model,
 * no re-selection point applies and the prompt cache is warm; otherwise
 * placement re-runs normal selection, which may land on the same account.
 * Forced reasons are checked before warmth, so a warm cache never keeps an
 * account the session may not use (SUB-STICK-07). An explicit choice is not
 * evaluated here: placement keeps it or waits for it (SUB-STICK-06).
 */
export function bindingStickiness(input: PlacementInput): BindingStickiness {
  const { session, connections } = input;
  const binding = session.binding;
  const reselect = (
    reason: ReselectionReason,
    ineligibility: readonly Ineligibility[] = [],
    points: readonly ReselectionPoint[] = [],
  ): BindingStickiness => ({ kind: "reselect", reason, ineligibility, points });
  if (!binding) return reselect("unbound");
  const bound = connections.find((connection) => connection.id === binding.connectionId);
  if (!bound) return reselect("account_unavailable");
  const permitted = failoverCandidateModels(input).filter((modelId) =>
    modelPermitted(input, modelId),
  );
  if (!permitted.includes(binding.modelId))
    // The session moved to another model (no longer a candidate at all) is
    // a re-selection point; a candidate the session may not use is forced.
    return session.reselectionPoints.length > 0 &&
      !failoverCandidateModels(input).includes(binding.modelId)
      ? reselect("reselection_point", [], session.reselectionPoints)
      : reselect("model_not_permitted");
  const ineligibility = connectionIneligibility(input, bound, binding.modelId);
  if (ineligibility.length > 0) return reselect("account_ineligible", ineligibility);
  const fallback = personalFallbackActive(input);
  if (
    connectionUsesExtraCredits(input, bound) &&
    connections.some(
      (candidate) =>
        (candidate.ownership.kind === "shared" || fallback) &&
        !connectionUsesExtraCredits(input, candidate) &&
        canServe(input, candidate, binding.modelId),
    )
  ) {
    return reselect("extra_credits");
  }
  if (session.reselectionPoints.length > 0)
    return reselect("reselection_point", [], session.reselectionPoints);
  if (!isCacheWarm(binding, input.cacheFacts[bound.provider], input.now))
    return reselect("cache_cold");
  return { kind: "keep", connectionId: bound.id, modelId: binding.modelId };
}

/**
 * Place one session's turn (design 4): run on an account and model, or wait
 * with an explained reason. The sender is deliberately not an input: the
 * account belongs to the session (SUB-STICK-01).
 */
export function decidePlacement(input: PlacementInput): PlacementDecision {
  const { session, connections } = input;
  const preferred = findModel(input, session.preferredModelId);
  const models = failoverCandidateModels(input);
  const permitted = models.filter((modelId) => modelPermitted(input, modelId));
  const fallback = personalFallbackActive(input);
  const wait = (reason: WaitReason, earliestResetAt: number | null): PlacementDecision => ({
    kind: "wait",
    reason,
    earliestResetAt,
  });
  const run = (
    connection: SubscriptionConnection,
    modelId: ModelId,
    kind: PlacementSwitch,
  ): PlacementDecision => ({
    kind: "run",
    connectionId: connection.id,
    provider: connection.provider,
    modelId,
    reasoningLevel: mapReasoningLevel(
      session.reasoningLevel,
      preferred,
      findModel(input, modelId)!,
    ),
    switch: kind,
    personal: connection.ownership.kind === "personal",
  });
  const servableAutomatically = (modelId: ModelId) =>
    connections.some(
      (connection) =>
        (connection.ownership.kind === "shared" || fallback) &&
        canServe(input, connection, modelId),
    );
  // Candidates the compaction lock alone keeps from this session (SUB-FAIL-09).
  const lockedOut = models.filter(
    (modelId) => !modelPermitted(input, modelId) && modelPermitted(input, modelId, false),
  );

  // No candidate model may be used here: wait on the restriction (D-17).
  if (permitted.length === 0) {
    return wait(lockedOut.length > 0 ? "compaction_provider_locked" : "model_not_allowed", null);
  }

  const binding = session.binding;
  const bound = binding
    ? connections.find((connection) => connection.id === binding.connectionId)
    : undefined;

  // An explicit choice is binding: run there or wait for it (SUB-SEL-04,
  // SUB-STICK-06). One that can never serve this work says so instead of
  // waiting silently (D-24, SUB-ACCESS-06).
  if (binding?.choice === "explicit") {
    if (bound && canServe(input, bound, session.preferredModelId)) {
      return run(bound, session.preferredModelId, "pinned");
    }
    if (
      !bound ||
      connectionIneligibility(input, bound, session.preferredModelId).some(isPermanentIneligibility)
    ) {
      return wait("pinned_account_ineligible", null);
    }
    const at = servableAgainAt(input, bound, session.preferredModelId);
    return wait("pinned_account_unavailable", typeof at === "number" ? at : null);
  }

  const bindingServable =
    !!binding &&
    !!bound &&
    permitted.includes(binding.modelId) &&
    canServe(input, bound, binding.modelId);

  // Keep a warm session where it is unless a re-selection point applies
  // or the account is forced away (SUB-STICK-02, SUB-STICK-03, SUB-STICK-05).
  const stickiness = bindingStickiness(input);
  if (stickiness.kind === "keep" && bound) return run(bound, stickiness.modelId, "sticky");

  // Each model on shared connections, then (opt-in) on the owner's personal
  // connections, before the next model (SUB-SEL-01, SUB-SEL-02, D-12).
  for (const [index, modelId] of models.entries()) {
    if (!modelPermitted(input, modelId)) continue;
    const eligible = connections.filter(
      (connection) =>
        canServe(input, connection, modelId) &&
        (connection.ownership.kind === "shared" || fallback),
    );
    const included = eligible.filter(
      (connection) => !connectionUsesExtraCredits(input, connection),
    );
    const servable = included.length ? included : eligible;
    const chosen =
      rankConnections(
        input,
        servable.filter((connection) => connection.ownership.kind === "shared"),
      )[0] ??
      (fallback
        ? rankConnections(
            input,
            servable.filter((connection) => connection.ownership.kind === "personal"),
          )[0]
        : undefined);
    if (!chosen) continue;
    let kind: PlacementSwitch;
    if (!binding) kind = "initial";
    else if (binding.connectionId === chosen.id && binding.modelId === modelId) kind = "sticky";
    else if (index === 0) {
      if (binding.modelId !== modelId) kind = "return_to_preferred";
      else kind = bindingServable ? "reselected_cold" : "failover_same_provider";
    } else {
      kind =
        findModel(input, modelId)?.provider === preferred?.provider
          ? "failover_same_provider"
          : "failover_cross_provider";
    }
    return run(chosen, modelId, kind);
  }

  // Nothing servable: wait for the earliest known time a connection this
  // session may use automatically can serve a permitted model (SUB-WAIT-01,
  // SUB-WAIT-02, D-22), and name the compaction lock when it is what keeps a
  // servable model away (SUB-FAIL-09).
  let earliest: number | null = null;
  for (const modelId of permitted) {
    for (const connection of connections) {
      if (connection.ownership.kind === "personal" && !fallback) continue;
      const at = servableAgainAt(input, connection, modelId);
      if (typeof at === "number") earliest = earliest === null ? at : Math.min(earliest, at);
    }
  }
  return wait(
    lockedOut.some(servableAutomatically) ? "compaction_provider_locked" : "no_eligible_capacity",
    earliest,
  );
}
