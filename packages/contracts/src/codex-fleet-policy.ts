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

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export const CODEX_FLEET_POLICY_SCHEMA_VERSION = 1 as const;
export const CODEX_FLEET_POLICY_VERSION = "adaptive-shadow-v1" as const;
export const CODEX_FLEET_POLICY_MAX_CANDIDATES = 32;
export const CODEX_FLEET_POLICY_MAX_OVERLAYS_PER_CANDIDATE = 4;

const MAX_DURATION_MS = 31 * 24 * 60 * 60_000;
const MAX_COUNT = 1_000_000;
const SCORE_SCALE = 100;

export type CodexFleetConfidence = "unknown" | "low" | "medium" | "high";
export type CodexFleetCandidateStatus = "active" | "needs_relogin" | "error" | "unknown";
export type CodexFleetCacheState = "unknown" | "healthy" | "collapsed";
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
    /** Previously latched state; the evaluator applies dwell and recovery thresholds. */
    state: CodexFleetCacheState;
    /** Duration of the current continuous below/above-threshold observation. */
    thresholdObservedForMs: number | null;
  };
  /** Workspace-local observed burn, separate from unexplained/external inference. */
  observedBurn: {
    percentPerHour: number | null;
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
  cacheCollapseRecoveryThreshold: number;
  cacheMinimumSampledTokens: number;
  cacheCollapseDwellMs: number;
  cacheRecoveryDwellMs: number;
  activeLeaseScore: number;
  unknownQuotaScore: number;
  lowQuotaConfidenceScore: number;
  mediumQuotaConfidenceScore: number;
  inferredBurnScorePerPercentHour: number;
  observedBurnScorePerPercentHour: number;
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
  overlayPreferenceScore: number;
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
  cacheCollapseRecoveryThreshold: 0.65,
  cacheMinimumSampledTokens: 4_096,
  cacheCollapseDwellMs: 5 * 60_000,
  cacheRecoveryDwellMs: 10 * 60_000,
  activeLeaseScore: 8 * SCORE_SCALE,
  unknownQuotaScore: 16 * SCORE_SCALE,
  lowQuotaConfidenceScore: 10 * SCORE_SCALE,
  mediumQuotaConfidenceScore: 4 * SCORE_SCALE,
  inferredBurnScorePerPercentHour: 0.2 * SCORE_SCALE,
  observedBurnScorePerPercentHour: 0.1 * SCORE_SCALE,
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
  overlayPreferenceScore: 12 * SCORE_SCALE,
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
  observedBurnPressure: number;
  inferredBurnPressure: number;
  runwayPressure: number;
  uncertaintyPressure: number;
  cacheAffinityBenefit: number;
  cacheState: CodexFleetCacheState;
  overlayPreferenceBenefit: number;
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
  recordedDecisionFingerprintMatches: boolean;
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
    inputFingerprint: fingerprintReplayInput(normalized.input, normalized.truncatedCandidateCount),
    decision,
    decisionFingerprint: fingerprint(decision),
  };
}

export function replayCodexFleetDecisionV1(value: unknown): CodexFleetReplayVerdictV1 {
  const record = readCodexFleetReplayRecordV1(value);
  const policyFingerprintMatches = fingerprint(record.policy) === record.policyFingerprint;
  const inputFingerprintMatches =
    fingerprintReplayInput(record.input, record.truncatedCandidateCount) ===
    record.inputFingerprint;
  const decision = evaluateCodexFleetDecisionV1(record.input, record.policy);
  const replayedDecisionFingerprint = fingerprint(decision);
  const recordedDecisionFingerprintMatches =
    fingerprint(record.decision) === record.decisionFingerprint;
  const decisionFingerprintMatches =
    recordedDecisionFingerprintMatches &&
    replayedDecisionFingerprint === record.decisionFingerprint;
  return {
    matches:
      policyFingerprintMatches &&
      inputFingerprintMatches &&
      decisionFingerprintMatches &&
      canonicalJson(decision) === canonicalJson(record.decision),
    policyFingerprintMatches,
    inputFingerprintMatches,
    decisionFingerprintMatches,
    recordedDecisionFingerprintMatches,
    decision,
  };
}

/**
 * Strict reader for durable/offline replay. Unknown fields, lossy normalization,
 * malformed decisions, and non-SHA-256 digests are rejected before comparison.
 */
export function readCodexFleetReplayRecordV1(value: unknown): CodexFleetReplayRecordV1 {
  const record = strictRecord(value, [
    "schemaVersion",
    "policyVersion",
    "mode",
    "policy",
    "input",
    "truncatedCandidateCount",
    "policyFingerprint",
    "inputFingerprint",
    "decision",
    "decisionFingerprint",
  ]);
  if (
    record.schemaVersion !== CODEX_FLEET_POLICY_SCHEMA_VERSION ||
    record.policyVersion !== CODEX_FLEET_POLICY_VERSION ||
    record.mode !== "shadow"
  ) {
    throw new Error("Unsupported Codex fleet replay envelope");
  }

  const policy = normalizePolicy(record.policy as CodexFleetPolicyConfigV1);
  if (canonicalJson(policy) !== canonicalJson(record.policy)) {
    throw new Error("Codex fleet replay policy is not in canonical bounded form");
  }
  const normalizedInput = normalizeInput(
    record.input as CodexFleetDecisionInputV1,
    policy.maxCandidates,
  );
  if (
    normalizedInput.truncatedCandidateCount !== 0 ||
    canonicalJson(normalizedInput.input) !== canonicalJson(record.input)
  ) {
    throw new Error("Codex fleet replay input is not in canonical bounded form");
  }

  return {
    schemaVersion: CODEX_FLEET_POLICY_SCHEMA_VERSION,
    policyVersion: CODEX_FLEET_POLICY_VERSION,
    mode: "shadow",
    policy,
    input: normalizedInput.input,
    truncatedCandidateCount: strictInteger(record.truncatedCandidateCount, 0, MAX_COUNT),
    policyFingerprint: strictSha256(record.policyFingerprint),
    inputFingerprint: strictSha256(record.inputFingerprint),
    decision: readCodexFleetDecisionV1(
      record.decision,
      new Set(normalizedInput.input.candidates.map((candidate) => candidate.key)),
    ),
    decisionFingerprint: strictSha256(record.decisionFingerprint),
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
      scoreCandidate(
        candidate,
        input,
        policy,
        overlay.rejectedByIsolation.has(candidate.key),
        overlay.preferredMembers.has(candidate.key),
      ),
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
    borrowedOverlayCapacity:
      policy.overlaysEnabled &&
      input.request.overlayMode === "prefer" &&
      input.request.overlayKey !== null &&
      !overlay.preferredMembers.has(selected.candidateKey),
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
  preferredOverlayMember = false,
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
  const observedBurnConfidence = confidenceWeight(candidate.observedBurn.confidence);
  const observedBurn = candidate.observedBurn.percentPerHour ?? 0;
  const observedBurnPressure = Math.round(
    observedBurn * policy.observedBurnScorePerPercentHour * observedBurnConfidence,
  );
  const burnConfidence = confidenceWeight(candidate.inferredUnexplainedBurn.confidence);
  const inferredBurn = candidate.inferredUnexplainedBurn.percentPerHour ?? 0;
  const inferredBurnPressure = Math.round(
    inferredBurn * policy.inferredBurnScorePerPercentHour * burnConfidence,
  );
  const remaining = Math.max(0, 100 - (bindingUsed ?? 50));
  const confidenceWeightedBurn =
    observedBurn * observedBurnConfidence + inferredBurn * burnConfidence;
  const runwayHours =
    confidenceWeightedBurn > 0 ? remaining / confidenceWeightedBurn : Number.POSITIVE_INFINITY;
  const runwayPressure = Number.isFinite(runwayHours)
    ? Math.round(
        Math.max(0, policy.minimumRunwayHours - runwayHours) * policy.runwayScorePerMissingHour,
      )
    : 0;
  const uncertaintyPressure = quotaUncertaintyScore(confidence, policy);
  const cacheState = effectiveCodexFleetCacheStateV1(candidate.cache, policy);
  const cacheAffinityBenefit =
    candidate.key === input.request.currentCandidateKey
      ? cacheAffinityBenefitFor(cacheState, policy)
      : 0;
  const overlayPreferenceBenefit = preferredOverlayMember ? policy.overlayPreferenceScore : 0;
  return {
    candidateKey: candidate.key,
    eligible: rejectionReason === null,
    rejectionReason,
    quotaPressure,
    leasePressure,
    observedBurnPressure,
    inferredBurnPressure,
    runwayPressure,
    uncertaintyPressure,
    cacheAffinityBenefit,
    cacheState,
    overlayPreferenceBenefit,
    total:
      quotaPressure +
      leasePressure +
      observedBurnPressure +
      inferredBurnPressure +
      runwayPressure +
      uncertaintyPressure -
      cacheAffinityBenefit -
      overlayPreferenceBenefit,
    confidence,
  };
}

function selectOverlayScope(
  input: CodexFleetDecisionInputV1,
  policy: CodexFleetPolicyConfigV1,
  baseEligibleKeys: Set<string>,
): {
  rejectedByIsolation: Set<string>;
  preferredMembers: Set<string>;
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
      preferredMembers: new Set(),
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
        preferredMembers: members,
        isolatedEmpty: false,
        strandedEligibleCount: 0,
      };
    }
    return {
      // Preference is a bounded score benefit, never a hard partition. Healthy
      // authorized outsiders remain eligible and borrowable.
      rejectedByIsolation: new Set(),
      preferredMembers: members,
      isolatedEmpty: false,
      strandedEligibleCount: 0,
    };
  }
  const outside = [...baseEligibleKeys].filter((candidateKey) => !members.has(candidateKey));
  return {
    rejectedByIsolation: new Set(outside),
    preferredMembers: members,
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
  const windows = [candidate.quota.primary, candidate.quota.secondary];
  const completeWindowCount = windows.filter(
    (window) => window.usedPercent !== null && window.resetRemainingMs !== null,
  ).length;
  const hasPartialWindow = windows.some(
    (window) => (window.usedPercent === null) !== (window.resetRemainingMs === null),
  );
  if (completeWindowCount === 0) return "unknown";
  const completenessCeiling: CodexFleetConfidence = hasPartialWindow
    ? "low"
    : completeWindowCount === windows.length
      ? "high"
      : "medium";
  const completeConfidence = lowerConfidence(candidate.quota.confidence, completenessCeiling);
  if (age > policy.quotaFreshForMs) {
    return lowerConfidence(completeConfidence, "low");
  }
  return completeConfidence;
}

export function effectiveCodexFleetCacheStateV1(
  cache: CodexFleetCandidateV1["cache"],
  policy: CodexFleetPolicyConfigV1,
): CodexFleetCacheState {
  const { hitRatio, sampledTokens, checkedAgeMs, confidence, state, thresholdObservedForMs } =
    cache;
  if (
    hitRatio === null ||
    sampledTokens === null ||
    sampledTokens < policy.cacheMinimumSampledTokens ||
    checkedAgeMs === null ||
    checkedAgeMs > policy.cacheFreshForMs ||
    confidenceWeight(confidence) < confidenceWeight("medium")
  ) {
    return "unknown";
  }
  const observedForMs = thresholdObservedForMs ?? 0;
  if (state === "healthy") {
    return hitRatio < policy.cacheCollapseThreshold && observedForMs >= policy.cacheCollapseDwellMs
      ? "collapsed"
      : "healthy";
  }
  if (state === "collapsed") {
    return hitRatio >= policy.cacheCollapseRecoveryThreshold &&
      observedForMs >= policy.cacheRecoveryDwellMs
      ? "healthy"
      : "collapsed";
  }
  if (hitRatio < policy.cacheCollapseThreshold && observedForMs >= policy.cacheCollapseDwellMs) {
    return "collapsed";
  }
  if (
    hitRatio >= policy.cacheCollapseRecoveryThreshold &&
    observedForMs >= policy.cacheRecoveryDwellMs
  ) {
    return "healthy";
  }
  return "unknown";
}

function cacheAffinityBenefitFor(
  state: CodexFleetCacheState,
  policy: CodexFleetPolicyConfigV1,
): number {
  if (state === "healthy") return policy.healthyCacheAffinityBenefit;
  if (state === "collapsed") return policy.collapsedCacheAffinityBenefit;
  return policy.unknownCacheAffinityBenefit;
}

function bindingUsedPercent(candidate: CodexFleetCandidateV1): number | null {
  const windows = [candidate.quota.primary, candidate.quota.secondary]
    .filter((window) => window.usedPercent !== null && window.resetRemainingMs !== null)
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
      state: normalizeCacheState(candidate.cache.state),
      thresholdObservedForMs: normalizeNullableInteger(
        candidate.cache.thresholdObservedForMs,
        0,
        MAX_DURATION_MS,
      ),
    },
    observedBurn: {
      percentPerHour: normalizeNullableNumber(candidate.observedBurn.percentPerHour, 0, 100, 3),
      confidence: normalizeConfidence(candidate.observedBurn.confidence),
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
  const cacheCollapseThreshold = normalizeNumber(policy.cacheCollapseThreshold, 0, 1, 4);
  return {
    maxCandidates: normalizeInteger(policy.maxCandidates, 1, CODEX_FLEET_POLICY_MAX_CANDIDATES),
    quotaFreshForMs,
    quotaStaleAfterMs: normalizeInteger(policy.quotaStaleAfterMs, quotaFreshForMs, MAX_DURATION_MS),
    placementUsageCeilingPercent: normalizeNumber(policy.placementUsageCeilingPercent, 1, 100, 3),
    cacheFreshForMs: normalizeInteger(policy.cacheFreshForMs, 1, MAX_DURATION_MS),
    cacheCollapseThreshold,
    cacheCollapseRecoveryThreshold: normalizeNumber(
      policy.cacheCollapseRecoveryThreshold,
      cacheCollapseThreshold,
      1,
      4,
    ),
    cacheMinimumSampledTokens: normalizeInteger(policy.cacheMinimumSampledTokens, 1, MAX_COUNT),
    cacheCollapseDwellMs: normalizeInteger(policy.cacheCollapseDwellMs, 1, MAX_DURATION_MS),
    cacheRecoveryDwellMs: normalizeInteger(policy.cacheRecoveryDwellMs, 1, MAX_DURATION_MS),
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
    observedBurnScorePerPercentHour: normalizeNumber(
      policy.observedBurnScorePerPercentHour,
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
    overlayPreferenceScore: normalizeNumber(policy.overlayPreferenceScore, 0, MAX_COUNT, 3),
  };
}

function normalizeConfidence(value: CodexFleetConfidence): CodexFleetConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "unknown";
}

function normalizeCacheState(value: CodexFleetCacheState): CodexFleetCacheState {
  return value === "healthy" || value === "collapsed" ? value : "unknown";
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

function readCodexFleetDecisionV1(
  value: unknown,
  candidateKeys: ReadonlySet<string>,
): CodexFleetDecisionV1 {
  const decision = strictRecord(value, [
    "outcome",
    "selectedCandidateKey",
    "reason",
    "admission",
    "borrowedOverlayCapacity",
    "strandedEligibleCount",
    "confidence",
    "scores",
  ]);
  const outcome = strictEnum(decision.outcome, ["selected", "paced", "none"] as const);
  const selectedCandidateKey = strictOptionalKey(decision.selectedCandidateKey);
  const reason = strictEnum(decision.reason, [
    "fenced_in_flight",
    "fenced_candidate_missing",
    "admission_paced",
    "no_eligible_candidate",
    "overlay_isolated_empty",
    "best_score",
    "affinity_best",
    "hysteresis_hold",
  ] as const);
  const admissionRecord = strictRecord(decision.admission, [
    "outcome",
    "reason",
    "borrowedIdleCapacity",
  ]);
  const admission: CodexFleetAdmissionDecisionV1 = {
    outcome: strictEnum(admissionRecord.outcome, ["admit", "pace"] as const),
    reason: strictEnum(admissionRecord.reason, [
      "fenced_in_flight",
      "pacing_disabled",
      "capacity_unknown",
      "capacity_available",
      "work_conserving_borrow",
      "manager_priority",
      "standard_starvation_bound",
      "capacity_saturated",
      "emergency_fuse",
    ] as const),
    borrowedIdleCapacity: strictBoolean(admissionRecord.borrowedIdleCapacity),
  };
  if (!Array.isArray(decision.scores) || decision.scores.length > candidateKeys.size) {
    throw new Error("Codex fleet replay decision scores are not a bounded array");
  }
  const scores = decision.scores.map(readCodexFleetScoreV1);
  if (
    new Set(scores.map((score) => score.candidateKey)).size !== scores.length ||
    scores.some((score) => !candidateKeys.has(score.candidateKey))
  ) {
    throw new Error("Codex fleet replay decision has invalid candidate scores");
  }
  const borrowedOverlayCapacity = strictBoolean(decision.borrowedOverlayCapacity);
  const strandedEligibleCount = strictInteger(decision.strandedEligibleCount, 0, MAX_COUNT);

  const selectedReasons = [
    "fenced_in_flight",
    "best_score",
    "affinity_best",
    "hysteresis_hold",
  ] as const;
  const noneReasons = [
    "fenced_candidate_missing",
    "no_eligible_candidate",
    "overlay_isolated_empty",
  ] as const;
  const paceReasons = ["manager_priority", "capacity_saturated", "emergency_fuse"] as const;
  const consistent =
    outcome === "selected"
      ? selectedCandidateKey !== null &&
        admission.outcome === "admit" &&
        selectedReasons.includes(reason as (typeof selectedReasons)[number]) &&
        scores.some((score) => score.candidateKey === selectedCandidateKey)
      : outcome === "paced"
        ? selectedCandidateKey === null &&
          reason === "admission_paced" &&
          admission.outcome === "pace" &&
          paceReasons.includes(admission.reason as (typeof paceReasons)[number])
        : selectedCandidateKey === null &&
          admission.outcome === "admit" &&
          noneReasons.includes(reason as (typeof noneReasons)[number]);
  if (
    !consistent ||
    strandedEligibleCount > candidateKeys.size ||
    admission.borrowedIdleCapacity !== (admission.reason === "work_conserving_borrow") ||
    (borrowedOverlayCapacity && (outcome !== "selected" || strandedEligibleCount !== 0))
  ) {
    throw new Error("Codex fleet replay decision is internally inconsistent");
  }

  return {
    outcome,
    selectedCandidateKey,
    reason,
    admission,
    borrowedOverlayCapacity,
    strandedEligibleCount,
    confidence: strictConfidence(decision.confidence),
    scores,
  };
}

function readCodexFleetScoreV1(value: unknown): CodexFleetScoreV1 {
  const score = strictRecord(value, [
    "candidateKey",
    "eligible",
    "rejectionReason",
    "quotaPressure",
    "leasePressure",
    "observedBurnPressure",
    "inferredBurnPressure",
    "runwayPressure",
    "uncertaintyPressure",
    "cacheAffinityBenefit",
    "cacheState",
    "overlayPreferenceBenefit",
    "total",
    "confidence",
  ]);
  const parsed: CodexFleetScoreV1 = {
    candidateKey: normalizeKey(strictString(score.candidateKey)),
    eligible: strictBoolean(score.eligible),
    rejectionReason:
      score.rejectionReason === null
        ? null
        : strictEnum(score.rejectionReason, [
            "allocator_disabled",
            "unavailable",
            "cooling",
            "quota_ceiling",
            "overlay_isolation",
          ] as const),
    quotaPressure: strictFiniteNumber(score.quotaPressure, 0, Number.MAX_SAFE_INTEGER),
    leasePressure: strictFiniteNumber(score.leasePressure, 0, Number.MAX_SAFE_INTEGER),
    observedBurnPressure: strictFiniteNumber(
      score.observedBurnPressure,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    inferredBurnPressure: strictFiniteNumber(
      score.inferredBurnPressure,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    runwayPressure: strictFiniteNumber(score.runwayPressure, 0, Number.MAX_SAFE_INTEGER),
    uncertaintyPressure: strictFiniteNumber(score.uncertaintyPressure, 0, Number.MAX_SAFE_INTEGER),
    cacheAffinityBenefit: strictFiniteNumber(
      score.cacheAffinityBenefit,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    cacheState: strictEnum(score.cacheState, ["unknown", "healthy", "collapsed"] as const),
    overlayPreferenceBenefit: strictFiniteNumber(
      score.overlayPreferenceBenefit,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    total: strictFiniteNumber(score.total, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    confidence: strictConfidence(score.confidence),
  };
  const expectedTotal =
    parsed.quotaPressure +
    parsed.leasePressure +
    parsed.observedBurnPressure +
    parsed.inferredBurnPressure +
    parsed.runwayPressure +
    parsed.uncertaintyPressure -
    parsed.cacheAffinityBenefit -
    parsed.overlayPreferenceBenefit;
  if (parsed.eligible !== (parsed.rejectionReason === null) || parsed.total !== expectedTotal) {
    throw new Error("Codex fleet replay score is internally inconsistent");
  }
  return parsed;
}

function strictRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error("Codex fleet replay value must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const canonicalExpected = [...expectedKeys].sort();
  if (canonicalJson(actualKeys) !== canonicalJson(canonicalExpected)) {
    throw new Error("Codex fleet replay object has missing or unknown fields");
  }
  return record;
}

function strictEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error("Codex fleet replay enum value is invalid");
  }
  return value as T[number];
}

function strictConfidence(value: unknown): CodexFleetConfidence {
  return strictEnum(value, ["unknown", "low", "medium", "high"] as const);
}

function strictString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Codex fleet replay value must be a string");
  return value;
}

function strictOptionalKey(value: unknown): string | null {
  return value === null ? null : normalizeKey(strictString(value));
}

function strictBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Codex fleet replay value must be boolean");
  return value;
}

function strictFiniteNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("Codex fleet replay numeric value is invalid");
  }
  return value;
}

function strictInteger(value: unknown, min: number, max: number): number {
  const number = strictFiniteNumber(value, min, max);
  if (!Number.isInteger(number)) throw new Error("Codex fleet replay value must be an integer");
  return number;
}

function strictSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Codex fleet replay fingerprint must be lowercase SHA-256");
  }
  return value;
}

function fingerprint(value: unknown): string {
  const serialized = canonicalJson(value);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

function fingerprintReplayInput(
  input: CodexFleetDecisionInputV1,
  truncatedCandidateCount: number,
): string {
  // Truncation affects actual-vs-shadow comparability and the UI explanation,
  // so it is part of the replay input's integrity boundary rather than mutable
  // envelope metadata.
  return fingerprint({ input, truncatedCandidateCount });
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
