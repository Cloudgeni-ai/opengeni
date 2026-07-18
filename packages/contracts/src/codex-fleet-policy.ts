/**
 * OPE-32 adaptive Codex fleet policy, replay contract, and shadow evaluator.
 *
 * This module is deliberately pure and browser-safe. It accepts only bounded,
 * metadata-only snapshots whose candidate keys are opaque aliases assigned by
 * the caller. It never accepts credential ids, account emails, labels, token
 * material, prompts, or tenant activity. The same normalized snapshot can be
 * persisted in a session event, replayed offline, and compared byte-for-byte.
 *
 * V1 is shadow-only at the runtime integration boundary. The evaluator models
 * later placement, admission, manager priority, borrowing, emergency-fuse, and
 * named-overlay semantics so they can be proven with deterministic simulations
 * before any independent kill switch is allowed to affect a live allocation.
 */

export const CODEX_FLEET_POLICY_SCHEMA_VERSION = 1 as const;
export const CODEX_FLEET_POLICY_VERSION = "adaptive-shadow-v1" as const;
export const CODEX_FLEET_POLICY_MAX_CANDIDATES = 32;
export const CODEX_FLEET_POLICY_MAX_OVERLAYS_PER_CANDIDATE = 4;

const MAX_DURATION_MS = 31 * 24 * 60 * 60_000;
const MAX_COUNT = 1_000_000;
const SCORE_SCALE = 100;

export type CodexFleetConfidence = "unknown" | "low" | "medium" | "high";
export type CodexFleetCandidateStatus = "active" | "needs_relogin" | "error" | "unknown";
export type CodexFleetPriority = "standard" | "manager";
export type CodexFleetPlacementKind = "new" | "fenced_in_flight";
export type CodexFleetOverlayMode = "none" | "prefer" | "isolate";

export type CodexFleetQuotaWindowV1 = {
  /** Provider-reported percentage from a workspace-local cache, never inferred tenant truth. */
  usedPercent: number | null;
  /** Relative to input.observedAtMs. Zero means the reported window has reset. */
  resetRemainingMs: number | null;
};

export type CodexFleetCandidateV1 = {
  /** Opaque, event-local alias such as c00. Never a credential/account id. */
  key: string;
  status: CodexFleetCandidateStatus;
  allocatorEnabled: boolean;
  /** Relative cooldown. A positive value excludes only NEW placements. */
  cooldownRemainingMs: number | null;
  activeLeaseCount: number;
  quota: {
    primary: CodexFleetQuotaWindowV1;
    secondary: CodexFleetQuotaWindowV1;
    checkedAgeMs: number | null;
    confidence: CodexFleetConfidence;
  };
  /**
   * Runtime-observed cache evidence. It may be absent because the production
   * baseline currently exists as aggregate metrics/logs rather than allocator
   * state. Absence is explicit uncertainty, not a zero cache hit.
   */
  cache: {
    hitRatio: number | null;
    sampledTokens: number | null;
    checkedAgeMs: number | null;
    confidence: CodexFleetConfidence;
  };
  /**
   * Unexplained/external burn is an inference only. The name and confidence are
   * load-bearing: consumers must never relabel it as provider or tenant truth.
   */
  inferredUnexplainedBurn: {
    percentPerHour: number | null;
    confidence: CodexFleetConfidence;
  };
  /** Opaque named-policy keys. Ignored unless overlaysEnabled is independently true. */
  overlayKeys: string[];
};

export type CodexFleetAdmissionSnapshotV1 = {
  /** Dynamically observed capacity, not a static per-account slot allocation. */
  dynamicCapacityUnits: number | null;
  inUseUnits: number;
  queuedManagerCount: number;
  emergencyFuseActive: boolean;
};

export type CodexFleetDecisionInputV1 = {
  observedAtMs: number;
  request: {
    placement: CodexFleetPlacementKind;
    priority: CodexFleetPriority;
    currentCandidateKey: string | null;
    waitAgeMs: number;
    overlayKey: string | null;
    overlayMode: CodexFleetOverlayMode;
  };
  admission: CodexFleetAdmissionSnapshotV1;
  candidates: CodexFleetCandidateV1[];
};

export type CodexFleetPolicyConfigV1 = {
  maxCandidates: number;
  quotaFreshForMs: number;
  quotaStaleAfterMs: number;
  placementUsageCeilingPercent: number;
  cacheFreshForMs: number;
  cacheCollapseThreshold: number;
  activeLeaseScore: number;
  unknownQuotaScore: number;
  lowQuotaConfidenceScore: number;
  mediumQuotaConfidenceScore: number;
  inferredBurnScorePerPercentHour: number;
  minimumRunwayHours: number;
  runwayScorePerMissingHour: number;
  healthyCacheAffinityBenefit: number;
  unknownCacheAffinityBenefit: number;
  collapsedCacheAffinityBenefit: number;
  switchHysteresisScore: number;
  admissionPacingEnabled: boolean;
  managerPriorityEnabled: boolean;
  managerStandardStarvationMs: number;
  emergencyFuseEnabled: boolean;
  overlaysEnabled: boolean;
};

/**
 * Experimental shadow defaults. None of the boolean control fields is enabled;
 * production behavior therefore remains sticky-sharded until operators enable
 * each independently after shadow acceptance.
 */
export const DEFAULT_CODEX_FLEET_POLICY_V1: CodexFleetPolicyConfigV1 = Object.freeze({
  maxCandidates: CODEX_FLEET_POLICY_MAX_CANDIDATES,
  quotaFreshForMs: 15 * 60_000,
  quotaStaleAfterMs: 60 * 60_000,
  placementUsageCeilingPercent: 90,
  cacheFreshForMs: 30 * 60_000,
  cacheCollapseThreshold: 0.4,
  activeLeaseScore: 8 * SCORE_SCALE,
  unknownQuotaScore: 16 * SCORE_SCALE,
  lowQuotaConfidenceScore: 10 * SCORE_SCALE,
  mediumQuotaConfidenceScore: 4 * SCORE_SCALE,
  inferredBurnScorePerPercentHour: 0.2 * SCORE_SCALE,
  minimumRunwayHours: 2,
  runwayScorePerMissingHour: 8 * SCORE_SCALE,
  healthyCacheAffinityBenefit: 32 * SCORE_SCALE,
  unknownCacheAffinityBenefit: 24 * SCORE_SCALE,
  collapsedCacheAffinityBenefit: 6 * SCORE_SCALE,
  switchHysteresisScore: 8 * SCORE_SCALE,
  admissionPacingEnabled: false,
  managerPriorityEnabled: false,
  managerStandardStarvationMs: 2 * 60_000,
  emergencyFuseEnabled: false,
  overlaysEnabled: false,
});

export type CodexFleetScoreV1 = {
  candidateKey: string;
  eligible: boolean;
  rejectionReason:
    | "allocator_disabled"
    | "unavailable"
    | "cooling"
    | "quota_ceiling"
    | "overlay_isolation"
    | null;
  quotaPressure: number;
  leasePressure: number;
  inferredBurnPressure: number;
  runwayPressure: number;
  uncertaintyPressure: number;
  cacheAffinityBenefit: number;
  total: number;
  confidence: CodexFleetConfidence;
};

export type CodexFleetAdmissionDecisionV1 = {
  outcome: "admit" | "pace";
  reason:
    | "fenced_in_flight"
    | "pacing_disabled"
    | "capacity_unknown"
    | "capacity_available"
    | "work_conserving_borrow"
    | "manager_priority"
    | "standard_starvation_bound"
    | "capacity_saturated"
    | "emergency_fuse";
  /** True only when standard work uses otherwise-idle capacity with no manager backlog. */
  borrowedIdleCapacity: boolean;
};

export type CodexFleetDecisionV1 = {
  outcome: "selected" | "paced" | "none";
  selectedCandidateKey: string | null;
  reason:
    | "fenced_in_flight"
    | "fenced_candidate_missing"
    | "admission_paced"
    | "no_eligible_candidate"
    | "overlay_isolated_empty"
    | "best_score"
    | "affinity_best"
    | "hysteresis_hold";
  admission: CodexFleetAdmissionDecisionV1;
  borrowedOverlayCapacity: boolean;
  strandedEligibleCount: number;
  confidence: CodexFleetConfidence;
  scores: CodexFleetScoreV1[];
};

export type CodexFleetReplayRecordV1 = {
  schemaVersion: typeof CODEX_FLEET_POLICY_SCHEMA_VERSION;
  policyVersion: typeof CODEX_FLEET_POLICY_VERSION;
  mode: "shadow";
  policy: CodexFleetPolicyConfigV1;
  input: CodexFleetDecisionInputV1;
  truncatedCandidateCount: number;
  policyFingerprint: string;
  inputFingerprint: string;
  decision: CodexFleetDecisionV1;
  decisionFingerprint: string;
};

export type CodexFleetReplayVerdictV1 = {
  matches: boolean;
  policyFingerprintMatches: boolean;
  inputFingerprintMatches: boolean;
  decisionFingerprintMatches: boolean;
  decision: CodexFleetDecisionV1;
};

type NormalizedInput = {
  input: CodexFleetDecisionInputV1;
  truncatedCandidateCount: number;
};

export function createCodexFleetReplayRecordV1(
  input: CodexFleetDecisionInputV1,
  policy: CodexFleetPolicyConfigV1 = DEFAULT_CODEX_FLEET_POLICY_V1,
): CodexFleetReplayRecordV1 {
  const normalizedPolicy = normalizePolicy(policy);
  const normalized = normalizeInput(input, normalizedPolicy.maxCandidates);
  const decision = evaluateCodexFleetDecisionV1(normalized.input, normalizedPolicy);
  return {
    schemaVersion: CODEX_FLEET_POLICY_SCHEMA_VERSION,
    policyVersion: CODEX_FLEET_POLICY_VERSION,
    mode: "shadow",
    policy: normalizedPolicy,
    input: normalized.input,
    truncatedCandidateCount: normalized.truncatedCandidateCount,
    policyFingerprint: fingerprint(normalizedPolicy),
    inputFingerprint: fingerprint(normalized.input),
    decision,
    decisionFingerprint: fingerprint(decision),
  };
}

export function replayCodexFleetDecisionV1(
  record: CodexFleetReplayRecordV1,
): CodexFleetReplayVerdictV1 {
  const policyFingerprintMatches = fingerprint(record.policy) === record.policyFingerprint;
  const inputFingerprintMatches = fingerprint(record.input) === record.inputFingerprint;
  const decision = evaluateCodexFleetDecisionV1(record.input, record.policy);
  const replayedDecisionFingerprint = fingerprint(decision);
  const decisionFingerprintMatches = replayedDecisionFingerprint === record.decisionFingerprint;
  return {
    matches:
      policyFingerprintMatches &&
      inputFingerprintMatches &&
      decisionFingerprintMatches &&
      canonicalJson(decision) === canonicalJson(record.decision),
    policyFingerprintMatches,
    inputFingerprintMatches,
    decisionFingerprintMatches,
    decision,
  };
}

export function evaluateCodexFleetDecisionV1(
  input: CodexFleetDecisionInputV1,
  policy: CodexFleetPolicyConfigV1 = DEFAULT_CODEX_FLEET_POLICY_V1,
): CodexFleetDecisionV1 {
  const admission = evaluateAdmission(input, policy);
  const current = input.request.currentCandidateKey
    ? input.candidates.find((candidate) => candidate.key === input.request.currentCandidateKey)
    : undefined;

  // A fenced turn is immutable under every overlay, pacing rule, manager class,
  // or emergency fuse. If its candidate vanished, fail closed instead of moving.
  if (input.request.placement === "fenced_in_flight") {
    if (!current) {
      return emptyDecision("fenced_candidate_missing", admission, "unknown");
    }
    return {
      outcome: "selected",
      selectedCandidateKey: current.key,
      reason: "fenced_in_flight",
      admission,
      borrowedOverlayCapacity: false,
      strandedEligibleCount: 0,
      confidence: candidateConfidence(current, policy),
      scores: [scoreCandidate(current, input, policy, false)],
    };
  }

  if (admission.outcome === "pace") {
    return emptyDecision("admission_paced", admission, "unknown");
  }

  const scored = input.candidates.map((candidate) =>
    scoreCandidate(candidate, input, policy, false),
  );
  const baseEligibleKeys = new Set(
    scored.filter((candidate) => candidate.eligible).map((candidate) => candidate.candidateKey),
  );
  const overlay = selectOverlayScope(input, policy, baseEligibleKeys);
  const scopedScores = input.candidates
    .map((candidate) =>
      scoreCandidate(candidate, input, policy, overlay.rejectedByIsolation.has(candidate.key)),
    )
    .sort((a, b) => a.candidateKey.localeCompare(b.candidateKey));
  const eligible = scopedScores
    .filter((candidate) => candidate.eligible)
    .sort((a, b) => a.total - b.total || a.candidateKey.localeCompare(b.candidateKey));

  if (eligible.length === 0) {
    return {
      ...emptyDecision(
        overlay.isolatedEmpty ? "overlay_isolated_empty" : "no_eligible_candidate",
        admission,
        aggregateConfidence(scopedScores),
      ),
      strandedEligibleCount: overlay.strandedEligibleCount,
      scores: scopedScores,
    };
  }

  let selected = eligible[0]!;
  let reason: CodexFleetDecisionV1["reason"] = "best_score";
  const currentScore = input.request.currentCandidateKey
    ? eligible.find((candidate) => candidate.candidateKey === input.request.currentCandidateKey)
    : undefined;
  if (currentScore) {
    if (selected.candidateKey === currentScore.candidateKey) {
      reason = "affinity_best";
    } else if (selected.total + policy.switchHysteresisScore >= currentScore.total) {
      selected = currentScore;
      reason = "hysteresis_hold";
    }
  }

  return {
    outcome: "selected",
    selectedCandidateKey: selected.candidateKey,
    reason,
    admission,
    borrowedOverlayCapacity: overlay.borrowed,
    strandedEligibleCount: overlay.strandedEligibleCount,
    confidence: aggregateConfidence(eligible),
    scores: scopedScores,
  };
}

function evaluateAdmission(
  input: CodexFleetDecisionInputV1,
  policy: CodexFleetPolicyConfigV1,
): CodexFleetAdmissionDecisionV1 {
  if (input.request.placement === "fenced_in_flight") {
    return { outcome: "admit", reason: "fenced_in_flight", borrowedIdleCapacity: false };
  }
  if (policy.emergencyFuseEnabled && input.admission.emergencyFuseActive) {
    return { outcome: "pace", reason: "emergency_fuse", borrowedIdleCapacity: false };
  }
  if (!policy.admissionPacingEnabled) {
    return { outcome: "admit", reason: "pacing_disabled", borrowedIdleCapacity: false };
  }
  if (input.admission.dynamicCapacityUnits === null) {
    // Observability-first fail-open: unknown soft capacity never invents a hard slot.
    return { outcome: "admit", reason: "capacity_unknown", borrowedIdleCapacity: false };
  }
  const available = Math.max(0, input.admission.dynamicCapacityUnits - input.admission.inUseUnits);
  if (available === 0) {
    return { outcome: "pace", reason: "capacity_saturated", borrowedIdleCapacity: false };
  }
  if (
    policy.managerPriorityEnabled &&
    input.request.priority === "standard" &&
    input.admission.queuedManagerCount > 0 &&
    available <= input.admission.queuedManagerCount
  ) {
    if (input.request.waitAgeMs >= policy.managerStandardStarvationMs) {
      return {
        outcome: "admit",
        reason: "standard_starvation_bound",
        borrowedIdleCapacity: false,
      };
    }
    return { outcome: "pace", reason: "manager_priority", borrowedIdleCapacity: false };
  }
  if (input.request.priority === "standard" && input.admission.queuedManagerCount === 0) {
    return {
      outcome: "admit",
      reason: "work_conserving_borrow",
      borrowedIdleCapacity: true,
    };
  }
  return { outcome: "admit", reason: "capacity_available", borrowedIdleCapacity: false };
}

function scoreCandidate(
  candidate: CodexFleetCandidateV1,
  input: CodexFleetDecisionInputV1,
  policy: CodexFleetPolicyConfigV1,
  rejectedByIsolation: boolean,
): CodexFleetScoreV1 {
  const confidence = candidateConfidence(candidate, policy);
  const bindingUsed = bindingUsedPercent(candidate);
  const hardQuotaKnown = confidence === "high" || confidence === "medium";
  const rejectionReason: CodexFleetScoreV1["rejectionReason"] = !candidate.allocatorEnabled
    ? "allocator_disabled"
    : candidate.status !== "active"
      ? "unavailable"
      : (candidate.cooldownRemainingMs ?? 0) > 0
        ? "cooling"
        : hardQuotaKnown &&
            bindingUsed !== null &&
            bindingUsed >= policy.placementUsageCeilingPercent
          ? "quota_ceiling"
          : rejectedByIsolation
            ? "overlay_isolation"
            : null;

  const confidenceFactor = confidenceWeight(confidence);
  // Missing quota is not treated as pristine 0% or as a hard exclusion. Blend
  // toward neutral 50% and add an explicit uncertainty component instead.
  const quotaPressure = Math.round(
    ((bindingUsed ?? 50) * confidenceFactor + 50 * (1 - confidenceFactor)) * SCORE_SCALE,
  );
  const leasePressure = candidate.activeLeaseCount * policy.activeLeaseScore;
  const burnConfidence = confidenceWeight(candidate.inferredUnexplainedBurn.confidence);
  const inferredBurn = candidate.inferredUnexplainedBurn.percentPerHour ?? 0;
  const inferredBurnPressure = Math.round(
    inferredBurn * policy.inferredBurnScorePerPercentHour * burnConfidence,
  );
  const remaining = Math.max(0, 100 - (bindingUsed ?? 50));
  const runwayHours = inferredBurn > 0 ? remaining / inferredBurn : Number.POSITIVE_INFINITY;
  const runwayPressure = Number.isFinite(runwayHours)
    ? Math.round(
        Math.max(0, policy.minimumRunwayHours - runwayHours) *
          policy.runwayScorePerMissingHour *
          burnConfidence,
      )
    : 0;
  const uncertaintyPressure = quotaUncertaintyScore(confidence, policy);
  const cacheAffinityBenefit =
    candidate.key === input.request.currentCandidateKey
      ? cacheAffinityBenefitFor(candidate, policy)
      : 0;
  return {
    candidateKey: candidate.key,
    eligible: rejectionReason === null,
    rejectionReason,
    quotaPressure,
    leasePressure,
    inferredBurnPressure,
    runwayPressure,
    uncertaintyPressure,
    cacheAffinityBenefit,
    total:
      quotaPressure +
      leasePressure +
      inferredBurnPressure +
      runwayPressure +
      uncertaintyPressure -
      cacheAffinityBenefit,
    confidence,
  };
}

function selectOverlayScope(
  input: CodexFleetDecisionInputV1,
  policy: CodexFleetPolicyConfigV1,
  baseEligibleKeys: Set<string>,
): {
  rejectedByIsolation: Set<string>;
  borrowed: boolean;
  isolatedEmpty: boolean;
  strandedEligibleCount: number;
} {
  if (
    !policy.overlaysEnabled ||
    input.request.overlayMode === "none" ||
    input.request.overlayKey === null
  ) {
    return {
      rejectedByIsolation: new Set(),
      borrowed: false,
      isolatedEmpty: false,
      strandedEligibleCount: 0,
    };
  }
  const members = new Set(
    input.candidates
      .filter(
        (candidate) =>
          baseEligibleKeys.has(candidate.key) &&
          candidate.overlayKeys.includes(input.request.overlayKey!),
      )
      .map((candidate) => candidate.key),
  );
  if (input.request.overlayMode === "prefer") {
    if (members.size === 0) {
      return {
        rejectedByIsolation: new Set(),
        borrowed: baseEligibleKeys.size > 0,
        isolatedEmpty: false,
        strandedEligibleCount: 0,
      };
    }
    return {
      rejectedByIsolation: new Set(
        [...baseEligibleKeys].filter((candidateKey) => !members.has(candidateKey)),
      ),
      borrowed: false,
      isolatedEmpty: false,
      strandedEligibleCount: 0,
    };
  }
  const outside = [...baseEligibleKeys].filter((candidateKey) => !members.has(candidateKey));
  return {
    rejectedByIsolation: new Set(outside),
    borrowed: false,
    isolatedEmpty: members.size === 0,
    strandedEligibleCount: outside.length,
  };
}

function candidateConfidence(
  candidate: CodexFleetCandidateV1,
  policy: CodexFleetPolicyConfigV1,
): CodexFleetConfidence {
  const age = candidate.quota.checkedAgeMs;
  if (age === null || age > policy.quotaStaleAfterMs) return "unknown";
  if (age > policy.quotaFreshForMs) {
    return lowerConfidence(candidate.quota.confidence, "low");
  }
  return candidate.quota.confidence;
}

function cacheAffinityBenefitFor(
  candidate: CodexFleetCandidateV1,
  policy: CodexFleetPolicyConfigV1,
): number {
  const { hitRatio, checkedAgeMs, confidence } = candidate.cache;
  if (
    hitRatio === null ||
    checkedAgeMs === null ||
    checkedAgeMs > policy.cacheFreshForMs ||
    confidenceWeight(confidence) < confidenceWeight("medium")
  ) {
    return policy.unknownCacheAffinityBenefit;
  }
  return hitRatio < policy.cacheCollapseThreshold
    ? policy.collapsedCacheAffinityBenefit
    : policy.healthyCacheAffinityBenefit;
}

function bindingUsedPercent(candidate: CodexFleetCandidateV1): number | null {
  const windows = [candidate.quota.primary, candidate.quota.secondary]
    .map((window) => (window.resetRemainingMs === 0 ? 0 : window.usedPercent))
    .filter((used): used is number => used !== null);
  return windows.length > 0 ? Math.max(...windows) : null;
}

function quotaUncertaintyScore(
  confidence: CodexFleetConfidence,
  policy: CodexFleetPolicyConfigV1,
): number {
  if (confidence === "unknown") return policy.unknownQuotaScore;
  if (confidence === "low") return policy.lowQuotaConfidenceScore;
  if (confidence === "medium") return policy.mediumQuotaConfidenceScore;
  return 0;
}

function emptyDecision(
  reason: CodexFleetDecisionV1["reason"],
  admission: CodexFleetAdmissionDecisionV1,
  confidence: CodexFleetConfidence,
): CodexFleetDecisionV1 {
  return {
    outcome: admission.outcome === "pace" ? "paced" : "none",
    selectedCandidateKey: null,
    reason,
    admission,
    borrowedOverlayCapacity: false,
    strandedEligibleCount: 0,
    confidence,
    scores: [],
  };
}

function aggregateConfidence(scores: CodexFleetScoreV1[]): CodexFleetConfidence {
  if (scores.length === 0) return "unknown";
  return scores.reduce<CodexFleetConfidence>(
    (lowest, score) =>
      confidenceWeight(score.confidence) < confidenceWeight(lowest) ? score.confidence : lowest,
    "high",
  );
}

function normalizeInput(input: CodexFleetDecisionInputV1, maxCandidates: number): NormalizedInput {
  const currentCandidateKey = normalizeOptionalKey(input.request.currentCandidateKey);
  const candidates = input.candidates
    .map(normalizeCandidate)
    .sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1]!.key === candidates[index]!.key) {
      throw new Error(`Duplicate Codex fleet candidate key: ${candidates[index]!.key}`);
    }
  }
  let bounded = candidates.slice(0, maxCandidates);
  if (
    currentCandidateKey &&
    candidates.some((candidate) => candidate.key === currentCandidateKey) &&
    !bounded.some((candidate) => candidate.key === currentCandidateKey)
  ) {
    bounded = [
      ...bounded.slice(0, Math.max(0, maxCandidates - 1)),
      candidates.find((candidate) => candidate.key === currentCandidateKey)!,
    ].sort((a, b) => a.key.localeCompare(b.key));
  }
  return {
    input: {
      observedAtMs: normalizeInteger(input.observedAtMs, 0, Number.MAX_SAFE_INTEGER),
      request: {
        placement: input.request.placement === "fenced_in_flight" ? "fenced_in_flight" : "new",
        priority: input.request.priority === "manager" ? "manager" : "standard",
        currentCandidateKey,
        waitAgeMs: normalizeInteger(input.request.waitAgeMs, 0, MAX_DURATION_MS),
        overlayKey: normalizeOptionalKey(input.request.overlayKey),
        overlayMode:
          input.request.overlayMode === "isolate"
            ? "isolate"
            : input.request.overlayMode === "prefer"
              ? "prefer"
              : "none",
      },
      admission: {
        dynamicCapacityUnits:
          input.admission.dynamicCapacityUnits === null
            ? null
            : normalizeInteger(input.admission.dynamicCapacityUnits, 0, MAX_COUNT),
        inUseUnits: normalizeInteger(input.admission.inUseUnits, 0, MAX_COUNT),
        queuedManagerCount: normalizeInteger(input.admission.queuedManagerCount, 0, MAX_COUNT),
        emergencyFuseActive: input.admission.emergencyFuseActive === true,
      },
      candidates: bounded,
    },
    truncatedCandidateCount: candidates.length - bounded.length,
  };
}

function normalizeCandidate(candidate: CodexFleetCandidateV1): CodexFleetCandidateV1 {
  return {
    key: normalizeKey(candidate.key),
    status:
      candidate.status === "active" ||
      candidate.status === "needs_relogin" ||
      candidate.status === "error"
        ? candidate.status
        : "unknown",
    allocatorEnabled: candidate.allocatorEnabled === true,
    cooldownRemainingMs: normalizeNullableInteger(
      candidate.cooldownRemainingMs,
      0,
      MAX_DURATION_MS,
    ),
    activeLeaseCount: normalizeInteger(candidate.activeLeaseCount, 0, MAX_COUNT),
    quota: {
      primary: normalizeQuotaWindow(candidate.quota.primary),
      secondary: normalizeQuotaWindow(candidate.quota.secondary),
      checkedAgeMs: normalizeNullableInteger(candidate.quota.checkedAgeMs, 0, MAX_DURATION_MS),
      confidence: normalizeConfidence(candidate.quota.confidence),
    },
    cache: {
      hitRatio: normalizeNullableNumber(candidate.cache.hitRatio, 0, 1, 4),
      sampledTokens: normalizeNullableInteger(candidate.cache.sampledTokens, 0, MAX_COUNT),
      checkedAgeMs: normalizeNullableInteger(candidate.cache.checkedAgeMs, 0, MAX_DURATION_MS),
      confidence: normalizeConfidence(candidate.cache.confidence),
    },
    inferredUnexplainedBurn: {
      percentPerHour: normalizeNullableNumber(
        candidate.inferredUnexplainedBurn.percentPerHour,
        0,
        100,
        3,
      ),
      confidence: normalizeConfidence(candidate.inferredUnexplainedBurn.confidence),
    },
    overlayKeys: [...new Set(candidate.overlayKeys.map(normalizeKey))]
      .sort()
      .slice(0, CODEX_FLEET_POLICY_MAX_OVERLAYS_PER_CANDIDATE),
  };
}

function normalizeQuotaWindow(window: CodexFleetQuotaWindowV1): CodexFleetQuotaWindowV1 {
  return {
    usedPercent: normalizeNullableNumber(window.usedPercent, 0, 100, 3),
    resetRemainingMs: normalizeNullableInteger(window.resetRemainingMs, 0, MAX_DURATION_MS),
  };
}

function normalizePolicy(policy: CodexFleetPolicyConfigV1): CodexFleetPolicyConfigV1 {
  const quotaFreshForMs = normalizeInteger(policy.quotaFreshForMs, 1, MAX_DURATION_MS);
  return {
    maxCandidates: normalizeInteger(policy.maxCandidates, 1, CODEX_FLEET_POLICY_MAX_CANDIDATES),
    quotaFreshForMs,
    quotaStaleAfterMs: normalizeInteger(policy.quotaStaleAfterMs, quotaFreshForMs, MAX_DURATION_MS),
    placementUsageCeilingPercent: normalizeNumber(policy.placementUsageCeilingPercent, 1, 100, 3),
    cacheFreshForMs: normalizeInteger(policy.cacheFreshForMs, 1, MAX_DURATION_MS),
    cacheCollapseThreshold: normalizeNumber(policy.cacheCollapseThreshold, 0, 1, 4),
    activeLeaseScore: normalizeNumber(policy.activeLeaseScore, 0, MAX_COUNT, 3),
    unknownQuotaScore: normalizeNumber(policy.unknownQuotaScore, 0, MAX_COUNT, 3),
    lowQuotaConfidenceScore: normalizeNumber(policy.lowQuotaConfidenceScore, 0, MAX_COUNT, 3),
    mediumQuotaConfidenceScore: normalizeNumber(policy.mediumQuotaConfidenceScore, 0, MAX_COUNT, 3),
    inferredBurnScorePerPercentHour: normalizeNumber(
      policy.inferredBurnScorePerPercentHour,
      0,
      MAX_COUNT,
      3,
    ),
    minimumRunwayHours: normalizeNumber(policy.minimumRunwayHours, 0, 24 * 31, 3),
    runwayScorePerMissingHour: normalizeNumber(policy.runwayScorePerMissingHour, 0, MAX_COUNT, 3),
    healthyCacheAffinityBenefit: normalizeNumber(
      policy.healthyCacheAffinityBenefit,
      0,
      MAX_COUNT,
      3,
    ),
    unknownCacheAffinityBenefit: normalizeNumber(
      policy.unknownCacheAffinityBenefit,
      0,
      MAX_COUNT,
      3,
    ),
    collapsedCacheAffinityBenefit: normalizeNumber(
      policy.collapsedCacheAffinityBenefit,
      0,
      MAX_COUNT,
      3,
    ),
    switchHysteresisScore: normalizeNumber(policy.switchHysteresisScore, 0, MAX_COUNT, 3),
    admissionPacingEnabled: policy.admissionPacingEnabled === true,
    managerPriorityEnabled: policy.managerPriorityEnabled === true,
    managerStandardStarvationMs: normalizeInteger(
      policy.managerStandardStarvationMs,
      1,
      MAX_DURATION_MS,
    ),
    emergencyFuseEnabled: policy.emergencyFuseEnabled === true,
    overlaysEnabled: policy.overlaysEnabled === true,
  };
}

function normalizeConfidence(value: CodexFleetConfidence): CodexFleetConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "unknown";
}

function confidenceWeight(confidence: CodexFleetConfidence): number {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.6;
  if (confidence === "low") return 0.25;
  return 0;
}

function lowerConfidence(
  value: CodexFleetConfidence,
  ceiling: CodexFleetConfidence,
): CodexFleetConfidence {
  return confidenceWeight(value) < confidenceWeight(ceiling) ? value : ceiling;
}

function normalizeKey(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{1,32}$/.test(value)) {
    throw new Error("Codex fleet candidate/overlay keys must be 1-32 opaque safe characters");
  }
  return value;
}

function normalizeOptionalKey(value: string | null): string | null {
  return value === null ? null : normalizeKey(value);
}

function normalizeNullableNumber(
  value: number | null,
  min: number,
  max: number,
  decimals: number,
): number | null {
  return value === null ? null : normalizeNumber(value, min, max, decimals);
}

function normalizeNumber(value: number, min: number, max: number, decimals: number): number {
  const finite = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, finite));
  const scale = 10 ** decimals;
  return Math.round(clamped * scale) / scale;
}

function normalizeNullableInteger(value: number | null, min: number, max: number): number | null {
  return value === null ? null : normalizeInteger(value, min, max);
}

function normalizeInteger(value: number, min: number, max: number): number {
  return Math.round(normalizeNumber(value, min, max, 0));
}

function fingerprint(value: unknown): string {
  const serialized = canonicalJson(value);
  return `${fnv1a32(serialized, 0x811c9dc5).toString(16).padStart(8, "0")}${fnv1a32(
    serialized,
    0x9e3779b9,
  )
    .toString(16)
    .padStart(8, "0")}`;
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
